#!/usr/bin/env node
// Analyze a docker-save / OCI image archive and print (or write) JSON.
// The `layer` and `image` sections are shape-compatible with `dive --json`
// output so tools/compare.mjs can diff the two directly.
//
// Usage:
//   node tools/analyze.mjs <image.tar> [--json out.json] [--pretty]

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeImage } from '../src/core/analyze.js';

// Node Blob wrapper so the browser-oriented core can run on disk files.
// For multi-GB archives this copies the file once; tests use small samples.
class FileBlob {
  constructor(path) {
    this.buf = readFileSync(path);
    this.size = this.buf.length;
    this.path = path;
  }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return {
      size: b.length,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  }
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node tools/analyze.mjs <image.tar> [--json out.json] [--pretty]');
  process.exit(2);
}
const jsonOutIdx = args.indexOf('--json');
const jsonOut = jsonOutIdx >= 0 ? args[jsonOutIdx + 1] : null;
const pretty = args.includes('--pretty');

const t0 = Date.now();
const analysis = await analyzeImage(new FileBlob(target), {
  onProgress: (p) => {
    if (process.env.VERBOSE) console.error('[progress]', JSON.stringify(p));
  },
});
const elapsedMs = Date.now() - t0;

const diveCompatible = {
  layer: analysis.layers.map((l) => ({
    index: l.index,
    id: l.digestId,
    digestId: l.digestId,
    sizeBytes: l.sizeBytes,
    command: l.command,
    fileList: l.fileList,
  })),
  image: {
    sizeBytes: analysis.totalSizeBytes,
    inefficientBytes: analysis.wastedBytes,
    efficiencyScore: analysis.efficiency,
    fileReference: analysis.inefficiencies.map((x) => ({
      count: x.count,
      sizeBytes: x.sizeBytes,
      file: x.path,
    })),
  },
};

const layerscope = {
  format: analysis.format,
  imageName: analysis.imageName,
  compressedArchiveBytes: analysis.compressedArchiveBytes,
  userSizeBytes: analysis.userSizeBytes,
  wastedUserPercent: analysis.wastedUserPercent,
  warnings: analysis.warnings,
  elapsedMs,
  layers: analysis.layers.map((l) => ({
    index: l.index,
    digestId: l.digestId,
    command: l.command,
    sizeBytes: l.sizeBytes,
    compressedBytes: l.compressedBytes,
    compression: l.compression,
    entryCount: l.entryCount,
    added: l.added,
    modified: l.modified,
    deleted: l.deleted,
    opaqued: l.opaqued,
  })),
  topLayerEntries: analysis.topLayerEntries,
  topFinalFiles: analysis.topFinalFiles,
};

const out = { ...diveCompatible, layerscope };
const text = JSON.stringify(out, null, pretty ? 2 : 0);
if (jsonOut) {
  writeFileSync(jsonOut, text);
  console.error(`wrote ${jsonOut}`);
} else {
  console.log(text);
}

// Human-readable summary on stderr so --json stays machine readable
console.error(`${basename(target)}: format=${analysis.format} layers=${analysis.layerCount} ` +
  `size=${analysis.totalSizeBytes}B efficiency=${(analysis.efficiency * 100).toFixed(2)}% ` +
  `wasted=${analysis.wastedBytes}B (${elapsedMs}ms)`);
if (analysis.warnings.length) for (const w of analysis.warnings) console.error(`warning: ${w}`);
