#!/usr/bin/env node
// Decoder soak test — is the vendored WASM zstd decoder stable under load?
//
// Phase A: decompress the SAME zstd frame `iterations` times on ONE long-lived
// instance (the harshest sharing scenario) and verify the sha256 of every
// output. The app does not share instances across analyses (each analysis
// gets a fresh one); this phase measures the decoder itself.
//
// Phase B: run analyzeImage `analyses` times on the same archive and compare
// a stable analysis fingerprint (totalSizeBytes, wastedBytes, efficiency,
// layerCount, per-layer digestIds) across all runs.
//
// Usage: node tools/soak-zstd.mjs [--iterations 2000] [--analyses 50]
// Exits non-zero if any divergence is observed.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeZstdCapped } from '../src/core/zstd-decode.js';
import { analyzeImage } from '../src/core/analyze.js';
import { synthesizeRawAsync, mulberry32 } from './synth-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const ITERATIONS = opt('iterations', 2000);
const ANALYSES = opt('analyses', 50);

// deterministic 3 MiB layer payload
const SIZE = 3 * 1024 * 1024;
const rand = mulberry32(7);
const content = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) content[i] = (rand() * 256) | 0;
const expectedSha = createHash('sha256').update(content).digest('hex');
const frame = zlib.zstdCompressSync(content, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
const sha = (b) => createHash('sha256').update(b).digest('hex');

console.log(`soak: frame=${frame.length}B iterations=${ITERATIONS} analyses=${ANALYSES}`);
console.log(`soak: sha256(uncompressed layer) = ${expectedSha}`);

// ---------- Phase A: N sequential streaming decodes through the app's fallback ----------
let ok = 0;
const divergence = [];
for (let i = 1; i <= ITERATIONS; i++) {
  let out = null;
  try {
    out = decodeZstdCapped(new Uint8Array(frame), { maxBytes: SIZE * 2 });
  } catch (err) {
    divergence.push({ iteration: i, error: err.message });
    if (divergence.length <= 3) console.error(`  MISMATCH (throw) at #${i}: ${err.message}`);
    continue;
  }
  if (sha(Buffer.from(out)) === expectedSha) ok++;
  else {
    divergence.push({ iteration: i, error: 'sha256 mismatch' });
    if (divergence.length <= 3) console.error(`  MISMATCH (sha256) at #${i}`);
  }
}
console.log(`phase A (shared fallback decoder × ${ITERATIONS}): ok=${ok} divergence=${divergence.length}`);

// ---------- Phase B: analyze the same archive M times, compare fingerprints --
const dir = mkdtempSync(join(tmpdir(), 'layerscope-soak-'));
const archivePath = join(dir, 'soak.tar');
const buf = await synthesizeRawAsync({
  format: 'oci-save',
  compression: 'zstd',
  layers: [[{ name: 'data/big.bin', content, mode: 0o644 }]],
  history: [{ created_by: 'RUN dd if=/dev/urandom of=/data/big.bin' }],
  repoTag: 'layerscope/soak:latest',
});
writeFileSync(archivePath, buf);
const { readFileSync } = await import('node:fs');
const archiveBytes = readFileSync(archivePath);

class MemBlob {
  constructor(b) { this.buf = b; this.size = b.length; }
  slice(s, e) {
    const b = this.buf.subarray(s, e);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

const fingerprint = (a) => sha(Buffer.from(JSON.stringify({
  totalSizeBytes: a.totalSizeBytes,
  wastedBytes: a.wastedBytes,
  efficiency: a.efficiency,
  layerCount: a.layerCount,
  digestIds: a.layers.map((l) => l.digestId),
  imageName: a.imageName,
})));

const fps = [];
let bFailures = 0;
for (let i = 1; i <= ANALYSES; i++) {
  try {
    const a = await analyzeImage(new MemBlob(archiveBytes));
    fps.push(fingerprint(a));
  } catch (err) {
    bFailures++;
    fps.push('ERROR: ' + err.message);
    if (bFailures <= 3) console.error(`  analysis #${i} failed: ${err.message}`);
  }
}
const unique = new Set(fps);
console.log(`phase B (${ANALYSES} analyses of one archive): uniqueFingerprints=${unique.size} failures=${bFailures}`);
if (unique.size > 1) {
  const [first, ...rest] = [...unique];
  console.error(`  fingerprints diverge — first: ${first}`);
  rest.slice(0, 3).forEach((f) => console.error(`  other:         ${f}`));
}
const pass = divergence.length === 0 && unique.size === 1 && bFailures === 0;
console.log(pass ? 'SOAK TEST PASSED' : 'SOAK TEST FAILED');
process.exit(pass ? 0 : 1);
