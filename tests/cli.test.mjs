// CLI tests: argument parsing (pure), exit codes and the --json contract
// (subprocess against the built fixtures), stdin spooling, the outer-gzip
// refusal, and the golden check that the CLI's JSON equals the library's
// output for every synthesizable fixture (plus the two disk fixtures when
// DIVE_REPO is available).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { parseArgs, UsageError, HELP } from '../src/cli/args.mjs';
import { buildReport, checkThresholds } from '../src/cli/report.mjs';
import { analyzeImage } from '../src/core/analyze.js';
import { buildFixtureAsync, NAMED_FIXTURES } from '../tools/fixtures.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO_ROOT, 'bin', 'layerscope.mjs');

const runCli = (args, { input = undefined, env = {} } = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'buffer',
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

const withTempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'layerscope-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------- parseArgs: happy paths ----------------

test('parseArgs: bare analyze requires a file argument', () => {
  assert.throws(() => parseArgs(['analyze']), (e) => e instanceof UsageError && /missing <image\.tar>/.test(e.message));
});

test('parseArgs: - is accepted as the archive argument (stdin)', () => {
  const p = parseArgs(['analyze', '-']);
  assert.equal(p.command, 'analyze');
  assert.equal(p.file, '-');
  assert.equal(p.json, false);
});

test('parseArgs: --json and all threshold flags parse', () => {
  const p = parseArgs(['analyze', 'img.tar', '--json', '--fail-under-efficiency', '0.9', '--fail-over-wasted', '65536', '--max-layer-bytes', '1048576', '--platform', 'linux/arm64']);
  assert.equal(p.json, true);
  assert.equal(p.failUnderEfficiency, 0.9);
  assert.equal(p.failOverWasted, 65536);
  assert.equal(p.maxLayerBytes, 1048576);
  assert.equal(p.platform, 'linux/arm64');
});

test('parseArgs: percent form of --fail-under-efficiency equals the fraction', () => {
  assert.equal(parseArgs(['analyze', 'x.tar', '--fail-under-efficiency', '90%']).failUnderEfficiency, 0.9);
  assert.equal(parseArgs(['analyze', 'x.tar', '--fail-under-efficiency', '0']).failUnderEfficiency, 0);
  assert.equal(parseArgs(['analyze', 'x.tar', '--fail-under-efficiency', '1']).failUnderEfficiency, 1);
  assert.equal(parseArgs(['analyze', 'x.tar', '--fail-under-efficiency', '100%']).failUnderEfficiency, 1);
});

test('parseArgs: platform with variant is accepted', () => {
  assert.equal(parseArgs(['analyze', 'x.tar', '--platform', 'linux/arm/v7']).platform, 'linux/arm/v7');
  assert.equal(parseArgs(['analyze', 'x.tar', '--platform', 'linux/arm64/v8']).platform, 'linux/arm64/v8');
});

// ---------------- parseArgs: rejections (exit-2 material) ----------------

for (const [argv, pattern] of [
  [[], /missing command/],
  [['frobnicate'], /unknown command/],
  [['analyze', 'a.tar', '--bogus'], /unknown option/],
  [['analyze', 'a.tar', 'extra.tar'], /unexpected extra argument/],
  [['analyze', '--fail-under-efficiency'], /requires a value/],
  [['analyze', 'a.tar', '--fail-under-efficiency', 'abc'], /fraction in \[0, 1\]/],
  [['analyze', 'a.tar', '--fail-under-efficiency', '1.5'], /between 0 and 1/],
  [['analyze', 'a.tar', '--fail-under-efficiency', '101%'], /between 0 and 1/],
  [['analyze', 'a.tar', '--fail-over-wasted', '-5'], /non-negative integer/],
  [['analyze', 'a.tar', '--fail-over-wasted', '1.5'], /non-negative integer/],
  [['analyze', 'a.tar', '--fail-over-wasted', 'ten'], /non-negative integer/],
  [['analyze', 'a.tar', '--max-layer-bytes', '16777216.5'], /non-negative integer/],
  [['analyze', 'a.tar', '--platform', 'arm64'], /OS\/ARCH/],
  [['analyze', 'a.tar', '--platform', 'linux/'], /OS\/ARCH/],
  [['analyze', 'a.tar', '--platform', 'LINUX/ARM64'], /OS\/ARCH/],
]) {
  test(`parseArgs rejects: ${argv.join(' ') || '(empty)'}`, () => {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message));
  });
}

// ---------------- checkThresholds (pure) ----------------

test('checkThresholds: empty when no thresholds set; one or both failures reported', () => {
  const report = { summary: { efficiency: 0.5, wastedBytes: 100 } };
  assert.deepEqual(checkThresholds(report, {}), []);
  assert.equal(checkThresholds(report, { failUnderEfficiency: 0.9 }).length, 1);
  assert.equal(checkThresholds(report, { failOverWasted: 99 }).length, 1);
  assert.equal(checkThresholds(report, { failUnderEfficiency: 0.9, failOverWasted: 99 }).length, 2);
  assert.deepEqual(checkThresholds(report, { failUnderEfficiency: 0.5 }), []); // boundary: equal passes
  assert.deepEqual(checkThresholds(report, { failOverWasted: 100 }), []);      // boundary: equal passes
});

// ---------------- exit codes via the real binary ----------------

test('CLI: analyzing the bundled demo sample exits 0 and reports known numbers', (t) => {
  const r = runCli(['analyze', 'assets/samples/layerscope-demo.tar', '--json']);
  assert.equal(r.status, 0, r.stderr.toString());
  const doc = JSON.parse(r.stdout.toString());
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.tool.name, 'layerscope');
  assert.equal(doc.summary.layerCount, 4);
  assert.equal(doc.summary.totalSizeBytes, 65660);
  assert.equal(doc.summary.wastedBytes, 65582);
  assert.equal(doc.summary.reclaimableBytes, 65559);
  assert.ok(Math.abs(doc.summary.efficiency - 0.0015382272311909838) < 1e-18);
});

test('CLI: --fail-under-efficiency exits 1 and prints the breach on stderr; stdout stays parseable', (t) => {
  const r = runCli(['analyze', 'assets/samples/layerscope-demo.tar', '--json', '--fail-under-efficiency', '0.9']);
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout.toString()); // stdout remains valid JSON
  assert.equal(doc.schemaVersion, 1);
  assert.match(r.stderr.toString(), /efficiency .* below the required/);
});

test('CLI: --fail-over-wasted exits 1 over the limit and 0 at the exact boundary', () => {
  const over = runCli(['analyze', 'assets/samples/layerscope-demo.tar', '--fail-over-wasted', '65581']);
  assert.equal(over.status, 1);
  assert.match(over.stderr.toString(), /wasted 65582 bytes/);
  const at = runCli(['analyze', 'assets/samples/layerscope-demo.tar', '--fail-over-wasted', '65582']);
  assert.equal(at.status, 0, at.stderr.toString());
});

test('CLI: unreadable archive exits 2 with a clear message', () => {
  const r = runCli(['analyze', 'does-not-exist.tar']);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /cannot stat 'does-not-exist\.tar'/);
});

test('CLI: a missing/invalid threshold value exits 2 (usage error, never a silent pass)', () => {
  const r = runCli(['analyze', 'assets/samples/layerscope-demo.tar', '--fail-under-efficiency', 'banana']);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /--fail-under-efficiency expects/);
});

test('CLI: --max-layer-bytes refusal on a zstd layer exits 2 with the engine message', async (t) => {
  const buf = await buildFixtureAsync('oci-save-zstd');
  const dir = withTempDir(t);
  const tar = join(dir, 'zstd.tar');
  writeFileSync(tar, buf);
  const r = runCli(['analyze', tar, '--max-layer-bytes', '1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /max-layer-bytes|exceeding/i);
});

test('CLI: a gzip-wrapped archive is refused with the unpack hint (outer wrappers unsupported)', async (t) => {
  const buf = await buildFixtureAsync('legacy-save');
  const dir = withTempDir(t);
  const gz = join(dir, 'image.tar.gz');
  writeFileSync(gz, zlib.gzipSync(buf));
  const r = runCli(['analyze', gz]);
  assert.equal(r.status, 2);
  assert.match(r.stderr.toString(), /gzip-compressed \(\.tar\.gz\)/);
});

test('CLI: reading the archive from stdin produces the same report as reading it from disk', async (t) => {
  const buf = await buildFixtureAsync('duplicate-files-across-layers');
  const dir = withTempDir(t);
  const tar = join(dir, 'dup.tar');
  writeFileSync(tar, buf);
  const fromDisk = runCli(['analyze', tar, '--json']);
  const fromStdin = runCli(['analyze', '-', '--json'], { input: buf });
  assert.equal(fromDisk.status, 0, fromDisk.stderr.toString());
  assert.equal(fromStdin.status, 0, fromStdin.stderr.toString());
  assert.deepEqual(JSON.parse(fromStdin.stdout.toString()), JSON.parse(fromDisk.stdout.toString()));
});

// ---------------- golden: CLI JSON equals the library output on the fixtures ----------------

const toolVersionOf = () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
};

for (const name of Object.keys(NAMED_FIXTURES)) {
  test(`golden: CLI JSON === library analysis for fixture '${name}'`, async (t) => {
    const buf = await buildFixtureAsync(name);
    const dir = withTempDir(t);
    const tar = join(dir, `${name}.tar`);
    writeFileSync(tar, buf);

    const cli = runCli(['analyze', tar, '--json']);
    assert.equal(cli.status, 0, cli.stderr.toString());
    const cliDoc = JSON.parse(cli.stdout.toString());

    const expected = buildReport(await analyzeImage(new MemBlob(buf)), { toolVersion: toolVersionOf() });
    assert.deepEqual(cliDoc, expected);
  });
}

// The two dive-repo disk fixtures (17 in total when DIVE_REPO is set). These
// need dive's own test-data tars; skipped automatically elsewhere.
const DIVE_REPO = process.env.DIVE_REPO;
const DISK_FIXTURES = {
  'test-docker-image': '.data/test-docker-image.tar',
  'test-oci-docker-image': '.data/test-oci-docker-image.tar',
};
for (const [name, rel] of Object.entries(DISK_FIXTURES)) {
  test(`golden: CLI JSON === library analysis for disk fixture '${name}'`, { skip: !(DIVE_REPO && existsSync(join(DIVE_REPO, rel))) && 'DIVE_REPO (dive checkout with test data) not available' }, async () => {
    const tar = join(DIVE_REPO, rel);
    const cli = runCli(['analyze', tar, '--json']);
    assert.equal(cli.status, 0, cli.stderr.toString());
    const cliDoc = JSON.parse(cli.stdout.toString());
    const buf = readFileSync(tar);
    const expected = buildReport(await analyzeImage(new MemBlob(buf)), { toolVersion: toolVersionOf() });
    assert.deepEqual(cliDoc, expected);
  });
}

// ---------------- misc contract ----------------

test('HELP documents the exit codes and stdin usage', () => {
  assert.match(HELP, /Exit codes/);
  assert.match(HELP, /docker save <image> \| layerscope analyze -/);
  assert.match(HELP, /--fail-under-efficiency/);
});
