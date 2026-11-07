#!/usr/bin/env node
// Verify layerscope against the goldens dive itself produced.
//
// For every named fixture in dive's imagefixture suite we recreate the image
// tar using tools/fixtures.mjs (a 1:1 port of the Go specs), analyze it with
// layerscope, and diff the result against the committed golden
//   <dive-repo>/internal/imagefixture/testdata/golden/<name>.export.json
//
// The two on-disk docker saves (real images committed to dive's repo) are
// analyzed directly. No expected values are hardcoded here; the goldens are
// NOTE on the dive pin: committed goldens exist only on dive's `main` branch
// (added in dive#727, the stereoscope port). v0.13.1 and earlier tags have no
// internal/imagefixture tree — cloning them makes every fixture skip silently.
// The verifier therefore pins commit e97febbeb6956b11f679f6d823762752185e3fef
// (tip of dive main at the time of writing). When dive releases a tag that
// contains the golden suite, pin that tag instead. DIVE_REPO env var,
// default /tmp/dive-src.
//
// Usage:
//   DIVE_REPO=/path/to/dive node tools/verify-fixtures.mjs [--verbose]
//   git init -q /tmp/dive-src && git -C /tmp/dive-src remote add origin https://github.com/wagoodman/dive \
//     && git -C /tmp/dive-src fetch -q --depth 1 origin e97febbeb6956b11f679f6d823762752185e3fef \
//     && git -C /tmp/dive-src checkout -q FETCH_HEAD

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeImage } from '../src/core/analyze.js';
import { buildFixtureAsync, NAMED_FIXTURES } from './fixtures.mjs';
import { compareAnalyses } from './lib-compare.mjs';

const DIVE_REPO = process.env.DIVE_REPO || '/tmp/dive-src/dive-main';
const verbose = process.argv.includes('--verbose');

const diskFixtures = {
  'test-docker-image': '.data/test-docker-image.tar',
  'test-oci-docker-image': '.data/test-oci-docker-image.tar',
};

// File/Blob shim around an in-memory buffer for the browser-oriented core
class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}
class FileBlob {
  constructor(path) { this.path = path; this.buf = readFileSync(path); this.size = this.buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}
const disk = (path) => new FileBlob(path);

function diveShape(analysis) {
  return {
    layer: analysis.layers.map((l) => ({
      index: l.index, id: l.digestId, digestId: l.digestId, sizeBytes: l.sizeBytes,
      command: l.command, fileList: l.fileList,
    })),
    image: {
      sizeBytes: analysis.totalSizeBytes,
      inefficientBytes: analysis.wastedBytes,
      efficiencyScore: analysis.efficiency,
      fileReference: analysis.inefficiencies.map((x) => ({ count: x.count, sizeBytes: x.sizeBytes, file: x.path })),
    },
  };
}

let pass = 0, failCount = 0, skip = 0;
const failedNames = [];

async function check(name, blob, goldenPath) {
  let golden;
  try {
    golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  } catch (err) {
    console.error(`SKIP ${name}: golden not readable at ${goldenPath} (${err.message})`);
    skip++;
    return;
  }
  let analysis;
  try {
    analysis = await analyzeImage(blob, { topLimit: 20 });
  } catch (err) {
    console.error(`FAIL ${name}: layerscope threw: ${err.message}`);
    failCount++;
    failedNames.push(name);
    return;
  }
  const { failures, lines } = compareAnalyses(golden, diveShape(analysis));
  if (failures === 0) {
    pass++;
    console.error(`PASS ${name}`);
  } else {
    failCount++;
    failedNames.push(name);
    console.error(`FAIL ${name}`);
    for (const l of lines) console.error(l);
  }
}

for (const name of Object.keys(NAMED_FIXTURES)) {
  let buf;
  try {
    buf = await buildFixtureAsync(name);
  } catch (err) {
    console.error(`SKIP ${name}: cannot synthesize fixture (${err.message})`);
    skip++;
    continue;
  }
  await check(name, new MemBlob(buf), join(DIVE_REPO, 'internal/imagefixture/testdata/golden', `${name}.export.json`));
}
for (const [name, rel] of Object.entries(diskFixtures)) {
  const p = join(DIVE_REPO, rel);
  await check(name, disk(p), join(DIVE_REPO, 'internal/imagefixture/testdata/golden', `${name}.export.json`));
}

console.error(`\n${pass} passed, ${failCount} failed, ${skip} skipped`);
if (failedNames.length) console.error(`failing fixtures: ${failedNames.join(', ')}`);
process.exit(failCount ? 1 : 0);
