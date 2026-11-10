// Unit tests for src/core/compare.js — deltas between two analyses.
// Images are synthesized with known content so the expected deltas are
// derived, not recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import { compareAnalyses, squashFiles, COMPARE_PATH_LIMIT } from '../src/core/compare.js';
import { synthesizeRaw, randomContent } from '../tools/synth-lib.mjs';

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

const withDirs = (entries) => {
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.name.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      if (i === parts.length && !e.name.endsWith('/')) break;
      dirs.add(parts.slice(0, i).join('/') + '/');
    }
  }
  const out = [];
  for (const d of [...dirs].sort()) out.push({ name: d, typeflag: '5', mode: 0o755 });
  return [...out, ...entries];
};

const analyze = async (layers, history, repoTag) => {
  const buf = synthesizeRaw({ format: 'legacy', compression: 'none', layers: layers.map(withDirs), history, repoTag });
  return analyzeImage(new MemBlob(buf));
};

// Known-delta pair — a "before/after an optimization" comparison, mirroring
// the CI fixtures (test5-compare-a / test6-compare-b):
//   A (compare-a): [cfg 200 KiB + keep] → [big.bin 5 MiB] → [whiteout] → [cfg rewrite 200 KiB]
//                  4 layers, wasted 5,652,480 bytes (big.bin + the cfg rewrite)
//   B (compare-b): [cfg' 150 KiB + keep] → [scripts/patch.sh 1 KiB]
//                  2 layers, no waste
// The FINAL manifests differ only in config.txt's size (200 -> 150 KiB) and
// the new patch.sh. data/big.bin appears in neither final manifest (A
// whiteouted it), so it is NOT a changed path — the 5 MiB win shows up as
// totalSize/waste/efficiency deltas instead.
const buildPair = async () => {
  const mkShared = (cfgBytes, seed) => [
    { name: 'app/config.txt', content: randomContent(cfgBytes, seed), mode: 0o644 },
    { name: 'etc/keep.txt', content: Buffer.from('keep-me\n') },
  ];
  const a = await analyze([
    mkShared(200 * 1024, 1001),
    [{ name: 'data/big.bin', content: randomContent(5 * 1024 * 1024, 1002), mode: 0o644 }],
    [{ name: 'data/.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) }],
    [{ name: 'app/config.txt', content: randomContent(200 * 1024, 1003), mode: 0o644 }],
  ], [
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/app/config.txt bs=1k count=200' },
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/data/big.bin bs=1M count=5' },
    { created_by: '/bin/sh -c rm /data/big.bin' },
    { created_by: '/bin/sh -c sed -i s/a/c/ /app/config.txt' },
  ], 'example/compare-a:latest');
  const b = await analyze([
    mkShared(150 * 1024, 2001),
    [{ name: 'scripts/patch.sh', content: randomContent(1024, 2002), mode: 0o755 }],
  ], [
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/app/config.txt bs=1k count=150' },
    { created_by: '/bin/sh -c install -m 755 patch.sh /scripts/patch.sh' },
  ], 'example/compare-b:latest');
  return { a, b };
};

test('squashFiles maps the final manifest, honoring whiteouts', async () => {
  const { a, b } = await buildPair();
  const fa = squashFiles(a);
  const fb = squashFiles(b);
  assert.equal(fa.get('/app/config.txt'), 200 * 1024); // last rewrite wins
  assert.ok(!fa.has('/data/big.bin'), 'whiteouted file is absent from the final manifest');
  assert.equal(fb.get('/app/config.txt'), 150 * 1024);
  assert.equal(fb.get('/scripts/patch.sh'), 1024);
});

test('compareAnalyses reports headline deltas with known directions', async () => {
  const { a, b } = await buildPair();
  const cmp = compareAnalyses(a, b);
  assert.equal(cmp.delta.layerCount, 2 - 4);
  assert.equal(cmp.delta.totalSizeBytes, b.totalSizeBytes - a.totalSizeBytes);
  assert.ok(cmp.delta.totalSizeBytes < 0, 'the optimized rebuild is smaller');
  assert.equal(cmp.delta.wastedBytes, b.wastedBytes - a.wastedBytes);
  assert.equal(cmp.delta.wastedBytes, -a.wastedBytes); // b wastes nothing
  assert.equal(cmp.delta.wastedBytes, -5652480); // matches the test1-waste fixture number
  assert.equal(cmp.delta.reclaimableBytes, -a.reclaimableBytes);
  assert.ok(Math.abs(cmp.delta.efficiency - (b.efficiency - a.efficiency)) < 1e-12);
  assert.ok(cmp.delta.efficiency > 0.9, 'efficiency jumps from ~3.6% to 100%');
  assert.equal(cmp.before.imageName, 'example/compare-a:latest');
  assert.equal(cmp.after.imageName, 'example/compare-b:latest');
});

test('changed paths are sorted by |delta| desc with deterministic order, identical files excluded', async () => {
  const { a, b } = await buildPair();
  const cmp = compareAnalyses(a, b);
  assert.equal(cmp.changedPathCount, 2);
  assert.equal(cmp.changedPaths[0].path, '/app/config.txt');
  assert.equal(cmp.changedPaths[0].beforeSize, 200 * 1024);
  assert.equal(cmp.changedPaths[0].afterSize, 150 * 1024);
  assert.equal(cmp.changedPaths[0].delta, -50 * 1024);
  assert.equal(cmp.changedPaths[1].path, '/scripts/patch.sh');
  assert.equal(cmp.changedPaths[1].delta, 1024);
  assert.equal(cmp.addedPathCount, 1);   // scripts/patch.sh
  assert.equal(cmp.removedPathCount, 0); // data/big.bin is absent from BOTH final manifests
  assert.ok(!cmp.changedPaths.some((p) => p.path === '/data/big.bin'), 'big.bin appears in neither final manifest — its 5 MiB win is a size/waste delta, not a path change');
  assert.ok(!cmp.changedPaths.some((p) => p.path === '/etc/keep.txt'), 'identical file must not appear');
  for (let i = 1; i < cmp.changedPaths.length; i++) {
    const prev = Math.abs(cmp.changedPaths[i - 1].delta);
    const cur = Math.abs(cmp.changedPaths[i].delta);
    assert.ok(prev >= cur, '|delta| must be non-increasing');
  }
});

test('topPaths limits the changed-paths list but not the counts', async () => {
  const { a, b } = await buildPair();
  const cmp = compareAnalyses(a, b, { topPaths: 1 });
  assert.equal(cmp.changedPaths.length, 1);
  assert.equal(cmp.changedPaths[0].path, '/app/config.txt');
  assert.equal(cmp.changedPathCount, 2);
  assert.ok(COMPARE_PATH_LIMIT >= 1);
});

test('identical analyses produce zero deltas and no changed paths', async () => {
  const { a } = await buildPair();
  const cmp = compareAnalyses(a, a);
  assert.equal(cmp.delta.totalSizeBytes, 0);
  assert.equal(cmp.delta.wastedBytes, 0);
  assert.equal(cmp.delta.reclaimableBytes, 0);
  assert.equal(cmp.delta.efficiency, 0);
  assert.equal(cmp.delta.layerCount, 0);
  assert.deepEqual(cmp.changedPaths, []);
  assert.equal(cmp.changedPathCount, 0);
});

test('compareAnalyses refuses missing input', () => {
  assert.throws(() => compareAnalyses(null, null), TypeError);
});

test('a file whose payload grew shows a positive delta with both sides recorded', async () => {
  const before = await analyze([
    [{ name: 'app/data.bin', content: randomContent(100 * 1024, 100) }],
  ], [{ created_by: 'RUN dd if=/dev/urandom of=/app/data.bin bs=1k count=100' }], 'example/grow-a:latest');
  const after = await analyze([
    [{ name: 'app/data.bin', content: randomContent(300 * 1024, 101) }],
  ], [{ created_by: 'RUN dd if=/dev/urandom of=/app/data.bin bs=1k count=300' }], 'example/grow-b:latest');
  const cmp = compareAnalyses(before, after);
  const row = cmp.changedPaths.find((p) => p.path === '/app/data.bin');
  assert.ok(row);
  assert.equal(row.beforeSize, 100 * 1024);
  assert.equal(row.afterSize, 300 * 1024);
  assert.equal(row.delta, 200 * 1024);
  assert.equal(cmp.addedPathCount, 0);
  assert.equal(cmp.removedPathCount, 0);
});

test('a brand-new file shows afterSize>0 with beforeSize 0 and counts as added', async () => {
  const before = await analyze([
    [{ name: 'etc/keep.txt', content: Buffer.from('keep\n') }],
  ], [{ created_by: 'RUN echo keep > /etc/keep.txt' }], 'example/new-a:latest');
  const after = await analyze([
    [{ name: 'etc/keep.txt', content: Buffer.from('keep\n') }, { name: 'opt/tool', content: randomContent(64 * 1024, 102) }],
  ], [{ created_by: 'RUN echo keep > /etc/keep.txt && cp tool /opt/tool' }], 'example/new-b:latest');
  const cmp = compareAnalyses(before, after);
  const row = cmp.changedPaths.find((p) => p.path === '/opt/tool');
  assert.ok(row);
  assert.equal(row.beforeSize, 0);
  assert.equal(row.afterSize, 64 * 1024);
  assert.equal(cmp.addedPathCount, 1);
});
