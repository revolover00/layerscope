// Compare the `layerscope` CLI's --json output against the in-process
// analysis engine (src/core/analyze.js analyzeImage — the exact code the web
// UI runs) over the same archive. Any mismatch fails the job.
//
// Usage: node tools/ci/compare-cli-web.mjs <image.tar> [label]
//
// The library report is rebuilt with the same buildReport() the CLI uses, so
// the comparison covers every field of schemaVersion 1 except the literal
// tool version, which is forced equal on both sides (same process, same
// package). Numbers are compared exactly — no tolerances.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeImage } from '../../src/core/analyze.js';
import { buildReport } from '../../src/cli/report.mjs';

const tar = process.argv[2];
const label = process.argv[3] ?? tar;
if (!tar) {
  console.error('usage: node tools/ci/compare-cli-web.mjs <image.tar> [label]');
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const cli = spawnSync(process.execPath, [join(ROOT, 'bin', 'layerscope.mjs'), 'analyze', tar, '--json'], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 1024,
});
if (cli.status !== 0) {
  process.stderr.write(cli.stderr ?? '');
  console.error(`::error::cli-vs-web ${label}: layerscope exited with ${cli.status}`);
  process.exit(2);
}
const cliDoc = JSON.parse(cli.stdout);

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}
const expected = buildReport(await analyzeImage(new MemBlob(readFileSync(tar))), { toolVersion: cliDoc.tool?.version });

const problems = [];
const diff = (path, a, b) => {
  if (problems.length >= 10) return;
  if (Object.is(a, b)) return;
  if (typeof a !== typeof b || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    problems.push(`${path}: CLI=${JSON.stringify(a)} engine=${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      problems.push(`${path}: length CLI=${a.length} engine=${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) diff(`${path}[${i}]`, a[i], b[i]);
    return;
  }
  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { problems.push(`${path}.${k}: missing in CLI report`); continue; }
      if (!(k in b)) { problems.push(`${path}.${k}: missing in engine report`); continue; }
      diff(`${path}.${k}`, a[k], b[k]);
    }
    return;
  }
  if (a !== b) problems.push(`${path}: CLI=${JSON.stringify(a)} engine=${JSON.stringify(b)}`);
};
diff('$', cliDoc, expected);

if (problems.length) {
  for (const p of problems) console.error(`::error::cli-vs-web ${label} mismatch at ${p}`);
  process.exit(1);
}
console.log(`::notice::cli-vs-web ${label}: CLI --json deep-equals the in-process engine output (schemaVersion ${cliDoc.schemaVersion}, ${cliDoc.summary.layerCount} layers, total ${cliDoc.summary.totalSizeBytes} B)`);
