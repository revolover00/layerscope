// Argument parsing for the layerscope CLI. Pure and dependency-free so the
// unit tests can exercise it without spawning a process.
//
// Grammar:
//   layerscope analyze <image.tar|-> [--json] [--fail-under-efficiency N]
//                                    [--fail-over-wasted BYTES]
//                                    [--max-layer-bytes N] [--platform OS/ARCH[/VARIANT]]
//   layerscope -h | --help | help
//   layerscope -v | --version | version
//
// Exit-code contract (see docs/CLI.md): 0 ok, 1 threshold failed, 2 bad input.

export class UsageError extends Error {}

const PLATFORM_RE = /^[a-z0-9]+\/[a-z0-9_.-]+(\/[a-z0-9_.-]+)?$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const NUMBER_RE = /^[0-9]+(\.[0-9]+)?$/;
const PERCENT_RE = /^([0-9]+(\.[0-9]+)?)%$/;

export const HELP = `layerscope — analyze a docker-save / OCI image archive. Local-only: nothing leaves the machine.

Usage:
  layerscope analyze <image.tar> [options]
  docker save <image> | layerscope analyze -
  layerscope analyze <image.tar> --json

Arguments:
  <image.tar>                 Path to an uncompressed \`docker save\` / OCI archive,
                              or - to read the archive from standard input.

Options:
  --json                      Print the machine-readable report (schemaVersion 1,
                              documented in docs/CLI.md) instead of the table.
  --fail-under-efficiency N   Exit 1 when the image efficiency ratio is below N.
                              N is a fraction in [0, 1] (e.g. 0.9) or a percent
                              with a % suffix (e.g. 90%).
  --fail-over-wasted BYTES    Exit 1 when wasted bytes exceed BYTES (integer).
                              1 MB = 1000000 bytes; use raw bytes, e.g. 524288000.
  --max-layer-bytes N         Refuse zstd layers that declare or decode beyond N
                              bytes (integer). Same meaning as the engine's
                              maxLayerBytes option; default is the engine default
                              (160 MiB). gzip layers stream and are unaffected.
  --platform OS/ARCH[/VARIANT]
                              For multi-manifest OCI archives, select the manifest
                              for this platform (e.g. linux/arm64, linux/arm/v7).
                              Default: linux/amd64 when present, else the first
                              manifest. If the platform is absent the default is
                              analyzed and a warning is recorded.
  -h, --help                  Show this help.
  -v, --version               Show the layerscope version.

Exit codes:
  0  analysis completed, thresholds (if any) satisfied
  1  analysis completed, at least one --fail-* threshold was breached
  2  bad input or error (unreadable archive, unsupported wrapper, corrupt
     image, invalid options, analysis failure)

Notes:
  - Archives must not be gzip/zstd-wrapped: \`docker save\` already emits an
    uncompressed .tar. A .tar.gz or .tar.zst input is rejected with a clear
    message; unpack it first (gzip -d).
  - Reading from stdin spools the archive to a temporary file first, so memory
    usage stays bounded; the temporary file is deleted when the analysis ends.
  - The human-readable table is for people; only --json output is a stable
    contract. Numbers follow dive's definitions.
`;

/**
 * Parse argv (already sliced of node/script). Returns
 *   { command: 'analyze', file, json, failUnderEfficiency, failOverWasted,
 *     maxLayerBytes, platform }
 * or throws UsageError (caller maps to exit 2).
 */
export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0) throw new UsageError('missing command — try `layerscope --help`');

  const first = args[0];
  if (first === '-h' || first === '--help' || first === 'help') {
    return { command: 'help' };
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    return { command: 'version' };
  }
  if (first !== 'analyze') {
    throw new UsageError(`unknown command '${first}' — expected 'analyze' (see \`layerscope --help\`)`);
  }
  args.shift();

  let file = null;
  let json = false;
  let failUnderEfficiency = null;
  let failOverWasted = null;
  let maxLayerBytes = null;
  let platform = null;

  const takeValue = (flag, i) => {
    if (i + 1 >= args.length) throw new UsageError(`${flag} requires a value`);
    return args[i + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--fail-under-efficiency') {
      const raw = takeValue(a, i); i++;
      failUnderEfficiency = parseEfficiency(a, raw);
      continue;
    }
    if (a === '--fail-over-wasted') {
      const raw = takeValue(a, i); i++;
      failOverWasted = parseInteger(a, raw);
      continue;
    }
    if (a === '--max-layer-bytes') {
      const raw = takeValue(a, i); i++;
      maxLayerBytes = parseInteger(a, raw);
      continue;
    }
    if (a === '--platform') {
      const raw = takeValue(a, i); i++;
      if (!PLATFORM_RE.test(raw)) {
        throw new UsageError(`--platform expects OS/ARCH[/VARIANT] (e.g. linux/arm64), got '${raw}'`);
      }
      platform = raw;
      continue;
    }
    if (a.startsWith('--')) throw new UsageError(`unknown option '${a}' — try \`layerscope --help\``);
    if (file !== null) throw new UsageError(`unexpected extra argument '${a}' — one archive per invocation`);
    file = a;
  }

  if (file === null) {
    throw new UsageError('missing <image.tar> — pass a path, or - to read from stdin (see `layerscope --help`)');
  }

  return { command: 'analyze', file, json, failUnderEfficiency, failOverWasted, maxLayerBytes, platform };
}

function parseEfficiency(flag, raw) {
  let value;
  const pct = PERCENT_RE.exec(raw);
  if (pct) {
    value = Number(pct[1]) / 100;
  } else if (NUMBER_RE.test(raw)) {
    value = Number(raw);
  } else {
    throw new UsageError(`${flag} expects a fraction in [0, 1] (e.g. 0.9) or a percent (e.g. 90%), got '${raw}'`);
  }
  if (!(value >= 0 && value <= 1)) {
    throw new UsageError(`${flag} must be between 0 and 1 (or 0%..100%), got '${raw}'`);
  }
  return value;
}

function parseInteger(flag, raw) {
  if (!INTEGER_RE.test(raw)) {
    throw new UsageError(`${flag} expects a non-negative integer (bytes), got '${raw}'`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(`${flag} is too large to represent exactly, got '${raw}'`);
  }
  return n;
}
