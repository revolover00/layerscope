#!/usr/bin/env node
// Memory footprint of the zstd FALLBACK decode path.
//
// Node has no native DecompressionStream('zstd'), so analyzing a zstd-layered
// archive here exercises exactly the fallback path that browsers without
// native zstd take (the pure-JS fzstd streaming decoder), with the same
// Blob.slice streaming around it.
//
// Measures rss and process.memoryUsage().arrayBuffers (plus heapUsed and
// external for context) — NOT heapUsed only. A running max of rss is sampled
// inside onProgress callbacks so a cross-layer peak is not missed.
//
// Usage:
//   node --expose-gc tools/bench-memory.mjs [archive.tar] [--label NAME]
// Without an argument, synthesizes the deterministic 6-layer / 62 MiB zstd
// fixture (incompressible random content, seed 1234+i) into $TMPDIR first.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeImage } from '../src/core/analyze.js';

const args = process.argv.slice(2);
const labelIdx = args.indexOf('--label');
const label = labelIdx >= 0 ? args[labelIdx + 1] : null;
const target = args.find((a, i) => !a.startsWith('--') && i !== labelIdx + 1);

async function ensureFixture() {
  const path = join(tmpdir(), 'layerscope-bench-memory-zstd.tar');
  if (existsSync(path)) {
    console.error(`reusing ${path}`);
    return path;
  }
  const { synthesizeRawAsync, randomContent } = await import('./synth-lib.mjs');
  const layers = [];
  const history = [];
  const per = Math.floor((62 * 1024 * 1024) / 6);
  for (let i = 0; i < 6; i++) {
    const entries = [{ name: `data/big-${i}.bin`, content: randomContent(per, 1234 + i), mode: 0o644 }];
    if (i === 1 || i === 4) entries.push({ name: 'meta/marker.txt', content: Buffer.alloc(68, 65), mode: 0o644 });
    layers.push(entries);
    history.push({ created_by: 'RUN dd if=/dev/urandom of=/data/big-' + i + '.bin bs=1M' });
  }
  const buf = await synthesizeRawAsync({ format: 'oci-save', compression: 'zstd', layers, history, repoTag: 'layerscope/bench-memory:latest' });
  writeFileSync(path, buf);
  console.error(`synthesized ${path}`);
  return path;
}

const path = target || (await ensureFixture());
const archiveBytes = statSync(path).size;

class FileBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(s, e) {
    const b = this.buf.subarray(s, e);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

const mem = () => {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    arrayBuffers: m.arrayBuffers,
    external: m.external,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
  };
};
const mib = (b) => (b / 1048576).toFixed(2);
const gc = () => { if (typeof global.gc === 'function') global.gc(); };

if (typeof global.gc !== 'function') {
  console.error('warning: --expose-gc not set; before/after numbers will include GC noise');
}

let maxRss = 0;
const note = () => { const r = process.memoryUsage().rss; if (r > maxRss) maxRss = r; };

gc();
const base = mem();
const buf = readFileSync(path);           // node Buffer IS a Uint8Array view on an ArrayBuffer, so it counts in arrayBuffers (but not heapUsed)
gc();
const afterLoad = mem();

const heapBefore = mem().heapUsed;

gc();
const beforeAnalyze = mem();
const t0 = Date.now();
const analysis = await analyzeImage(new FileBlob(buf), { onProgress: note });
const elapsedMs = Date.now() - t0;
note();
const afterAnalyze = mem();               // no gc yet: peak-ish snapshot
gc();
const afterGc = mem();

const out = {
  label: label || path,
  archiveBytes,
  uncompressedLayerBytes: analysis.totalSizeBytes,
  layers: analysis.layerCount,
  efficiency: analysis.efficiency,
  wastedBytes: analysis.wastedBytes,
  elapsedMs,
  heapUsedDeltaMiB: mib(afterAnalyze.heapUsed - beforeAnalyze.heapUsed),
  rss: {
    baseMiB: mib(base.rss),
    afterLoadMiB: mib(afterLoad.rss),
    beforeAnalyzeMiB: mib(beforeAnalyze.rss),
    afterAnalyzeMiB: mib(afterAnalyze.rss),
    afterGcMiB: mib(afterGc.rss),
    maxSampledMiB: mib(Math.max(maxRss, afterAnalyze.rss)),
    deltaAnalyzeMiB: mib(afterAnalyze.rss - beforeAnalyze.rss),
    deltaAfterGcMiB: mib(afterGc.rss - beforeAnalyze.rss),
  },
  arrayBuffers: {
    baseMiB: mib(base.arrayBuffers),
    afterLoadMiB: mib(afterLoad.arrayBuffers),
    beforeAnalyzeMiB: mib(beforeAnalyze.arrayBuffers),
    afterAnalyzeMiB: mib(afterAnalyze.arrayBuffers),
    afterGcMiB: mib(afterGc.arrayBuffers),
    deltaAnalyzeMiB: mib(afterAnalyze.arrayBuffers - beforeAnalyze.arrayBuffers),
    deltaAfterGcMiB: mib(afterGc.arrayBuffers - beforeAnalyze.arrayBuffers),
  },
  externalDeltaMiB: mib(afterAnalyze.external - beforeAnalyze.external),
  heapBeforeMiB: mib(heapBefore),
};
console.log(JSON.stringify(out, null, 2));
