#!/usr/bin/env node
// Independent reference analysis for the big legacy fixture — runs the same
// src/core/analyze.js the browser uses, on a fs-backed Blob (lazy, so the
// file is never slurped into memory). Prints the measured wall-clock time,
// sampled peak RSS and sampled peak JS heap, plus the exact display strings
// the UI renders, so tools/browser-big.mjs can assert the Chromium analysis
// reports the same numbers.
//
//   node tools/ci/analyze-big.mjs <image.tar> [--json out.json]

import { openAsBlob } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { analyzeImage } from '../../src/core/analyze.js';
import { formatBytes, formatPercent, formatCount } from '../../src/core/format.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) { console.error('usage: node tools/ci/analyze-big.mjs <image.tar> [--json out.json]'); process.exit(2); }
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

let rssPeak = process.memoryUsage().rss;
let heapUsedPeak = process.memoryUsage().heapUsed;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > rssPeak) rssPeak = m.rss;
  if (m.heapUsed > heapUsedPeak) heapUsedPeak = m.heapUsed;
}, 100);

const t0 = Date.now();
const blob = await openAsBlob(target); // fs-backed, lazy — slices read from disk on demand
const analysis = await analyzeImage(blob, {});
clearInterval(sampler);
const elapsedMs = Date.now() - t0;
const mEnd = process.memoryUsage();
if (mEnd.rss > rssPeak) rssPeak = mEnd.rss;
if (mEnd.heapUsed > heapUsedPeak) heapUsedPeak = mEnd.heapUsed;

const layerCount = analysis.layerCount;
const display = {
  chipLayers: `${layerCount} layer${layerCount === 1 ? '' : 's'}`,
  statTotal: formatBytes(analysis.totalSizeBytes),
  statWasted: formatBytes(analysis.wastedBytes),
  statReclaimable: formatBytes(analysis.reclaimableBytes),
  gaugeValue: `${(analysis.efficiency * 100).toFixed(1)}%`,
  wsEfficiency: formatPercent(analysis.efficiency, 1),
  wsWasted: formatBytes(analysis.wastedBytes),
  wsReclaimable: formatBytes(analysis.reclaimableBytes),
  wsPaths: formatCount(analysis.inefficiencies.length),
};

const out = {
  layers: layerCount,
  totalBytes: analysis.totalSizeBytes,
  wastedBytes: analysis.wastedBytes,
  reclaimableBytes: analysis.reclaimableBytes,
  efficiency: analysis.efficiency,
  userWastePercent: analysis.wastedUserPercent,
  elapsedMs,
  rssPeakBytes: rssPeak,
  heapUsedPeakBytes: heapUsedPeak,
  display,
};

const text = JSON.stringify(out, null, 2);
if (jsonOut) writeFileSync(jsonOut, text);
console.log(text);
