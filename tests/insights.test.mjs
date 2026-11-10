// Unit tests for src/core/insights.js — every rule gets a positive and a
// negative fixture. Fixtures are synthesized archives analyzed with the real
// engine, so the assertions exercise exactly what the browser renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import { buildSuggestions } from '../src/core/insights.js';
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

const analyze = async (layers, history, repoTag = 'example/insights:latest') => {
  const buf = synthesizeRaw({ format: 'legacy', compression: 'none', layers: layers.map(withDirs), history, repoTag });
  return analyzeImage(new MemBlob(buf));
};

const byId = (suggestions, id) => suggestions.filter((s) => s.id === id);

// ---------------- rule 1: add then delete ----------------

test('add-then-delete fires with the stranded bytes, layers and path', async () => {
  const big = randomContent(128 * 1024, 11);
  const a = await analyze([
    [{ name: 'data/big.bin', content: big, mode: 0o644 }, { name: 'etc/keep.txt', content: Buffer.from('keep\n') }],
    [{ name: 'data/.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/data/big.bin bs=1k count=128' },
    { created_by: '/bin/sh -c rm /data/big.bin' },
  ]);
  const hits = byId(buildSuggestions(a), 'add-then-delete');
  assert.equal(hits.length, 1);
  const s = hits[0];
  assert.equal(s.bytesReclaimable, big.length);
  assert.deepEqual(s.paths, ['/data/big.bin']);
  assert.deepEqual(s.layers, [0, 1]);
  assert.equal(s.severity, 'low'); // 128 KiB < 256 KiB threshold
  assert.match(s.fix, /single RUN/);
});

test('add-then-delete stays silent when the file is created and removed in the same layer', async () => {
  // a tar that both stores the file and whiteouts it in one layer: the bytes
  // never cross a layer boundary, so no add→delete story exists
  const a = await analyze([
    [{ name: 'data/big.bin', content: randomContent(64 * 1024, 12) }, { name: 'data/.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) }],
  ], [{ created_by: '/bin/sh -c dd if=/dev/zero of=/data/big.bin && rm /data/big.bin' }]);
  assert.equal(byId(buildSuggestions(a), 'add-then-delete').length, 0);
});

test('add-then-delete stays silent when the deleted path was never seen in this image', async () => {
  const a = await analyze([
    [{ name: 'etc/keep.txt', content: Buffer.from('keep\n') }],
    [{ name: 'ghost/.wh.nope.bin', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c echo keep > /etc/keep.txt' },
    { created_by: '/bin/sh -c rm /ghost/nope.bin' },
  ]);
  assert.equal(byId(buildSuggestions(a), 'add-then-delete').length, 0);
});

// ---------------- rule 2: package-manager caches across layers ----------------

test('cache-cleanup fires for apt lists written then removed in a later layer', async () => {
  const lists = randomContent(300 * 1024, 21);
  const a = await analyze([
    [{ name: 'var/lib/apt/lists/foo.debian', content: lists, mode: 0o644 }],
    [{ name: 'var/lib/apt/lists/.wh.foo.debian', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c apt-get update' },
    { created_by: '/bin/sh -c rm -rf /var/lib/apt/lists/*' },
  ]);
  const hits = byId(buildSuggestions(a), 'cache-cleanup');
  assert.equal(hits.length, 1);
  const s = hits[0];
  assert.equal(s.bytesReclaimable, lists.length);
  assert.deepEqual(s.paths, ['/var/lib/apt/lists/foo.debian']);
  assert.equal(s.severity, 'medium'); // ≥ 256 KiB
  assert.match(s.fix, /same RUN/);
});

test('cache-cleanup covers cache subtrees wiped by a directory whiteout', async () => {
  const a = await analyze([
    [{ name: 'var/cache/apk/pkg-1.tar.gz', content: randomContent(100 * 1024, 22) }],
    [{ name: 'var/cache/apk/pkg-2.tar.gz', content: randomContent(100 * 1024, 23) }],
    [{ name: 'var/cache/.wh.apk', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c apk update' },
    { created_by: '/bin/sh -c apk add --no-cache-ish thing' },
    { created_by: '/bin/sh -c rm -rf /var/cache/apk' },
  ]);
  const hits = byId(buildSuggestions(a), 'cache-cleanup');
  assert.equal(hits.length, 1);
  // both files were written before the directory whiteout — both are stranded
  assert.equal(hits[0].bytesReclaimable, 200 * 1024);
  assert.deepEqual(hits[0].paths.sort(), ['/var/cache/apk/pkg-1.tar.gz', '/var/cache/apk/pkg-2.tar.gz']);
});

test('cache-cleanup stays silent when the cache is created and cleaned in the same layer', async () => {
  const payload = randomContent(300 * 1024, 24);
  const a = await analyze([
    [
      { name: 'var/lib/apt/lists/foo.debian', content: payload },
      { name: 'var/lib/apt/lists/.wh.foo.debian', typeflag: '0', content: Buffer.alloc(0) },
    ],
  ], [{ created_by: '/bin/sh -c apt-get update && apt-get install -y foo && rm -rf /var/lib/apt/lists/*' }]);
  assert.equal(byId(buildSuggestions(a), 'cache-cleanup').length, 0);
});

test('cache-cleanup stays silent for cache files that are never removed', async () => {
  const a = await analyze([
    [{ name: 'var/lib/apt/lists/foo.debian', content: randomContent(300 * 1024, 25) }],
  ], [{ created_by: '/bin/sh -c apt-get update' }]);
  assert.equal(byId(buildSuggestions(a), 'cache-cleanup').length, 0);
});

test('cache-cleanup does not claim non-cache paths', async () => {
  const a = await analyze([
    [{ name: 'app/data.bin', content: randomContent(300 * 1024, 26) }],
    [{ name: 'app/.wh.data.bin', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/app/data.bin bs=1k count=300' },
    { created_by: '/bin/sh -c rm /app/data.bin' },
  ]);
  assert.equal(byId(buildSuggestions(a), 'cache-cleanup').length, 0);
});

// ---------------- rule 3: same path rewritten across layers ----------------

test('rewritten-paths fires for a large path rewritten in two layers', async () => {
  const a = await analyze([
    [{ name: 'usr/local/bin/tool', content: randomContent(128 * 1024, 31) }],
    [{ name: 'usr/local/bin/tool', content: randomContent(128 * 1024, 32) }],
  ], [
    { created_by: '/bin/sh -c make && cp tool /usr/local/bin/' },
    { created_by: '/bin/sh -c patch && cp tool /usr/local/bin/' },
  ]);
  const hits = byId(buildSuggestions(a), 'rewritten-paths');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].paths, ['/usr/local/bin/tool']);
  assert.equal(hits[0].bytesReclaimable, 128 * 1024); // first copy stranded, second survives
  assert.deepEqual(hits[0].layers, [0, 1]);
});

test('rewritten-paths stays silent below the size threshold', async () => {
  const small = randomContent(1024, 33);
  const a = await analyze([
    [{ name: 'etc/config.yml', content: small }],
    [{ name: 'etc/config.yml', content: Buffer.from('v2\n') }],
  ], [
    { created_by: '/bin/sh -c cp config.yml /etc/' },
    { created_by: '/bin/sh -c sed -i s/v1/v2/ /etc/config.yml' },
  ]);
  assert.equal(byId(buildSuggestions(a), 'rewritten-paths').length, 0);
});

test('rewritten-paths stays silent for paths deleted in a later layer (rules 1/2 cover those)', async () => {
  const big = randomContent(128 * 1024, 34);
  const a = await analyze([
    [{ name: 'usr/local/bin/tool', content: big }],
    [{ name: 'usr/local/bin/tool', content: randomContent(128 * 1024, 35) }],
    [{ name: 'usr/local/bin/.wh.tool', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c make && cp tool /usr/local/bin/' },
    { created_by: '/bin/sh -c patch && cp tool /usr/local/bin/' },
    { created_by: '/bin/sh -c rm /usr/local/bin/tool' },
  ]);
  const suggestions = buildSuggestions(a);
  assert.equal(byId(suggestions, 'rewritten-paths').length, 0);
  assert.equal(byId(suggestions, 'add-then-delete').length, 1);
});

// ---------------- rule 4: metadata-only re-stores ----------------

test('metadata-only-rewrite fires for an equal-size rewrite under a chmod command', async () => {
  const payload = randomContent(2 * 1024 * 1024, 41);
  const a = await analyze([
    [{ name: 'usr/bin/app', content: payload, mode: 0o644 }],
    [{ name: 'usr/bin/app', content: payload, mode: 0o755 }],
  ], [
    { created_by: '/bin/sh -c cp app /usr/bin/app' },
    { created_by: '/bin/sh -c chmod 755 /usr/bin/app' },
  ]);
  const hits = byId(buildSuggestions(a), 'metadata-only-rewrite');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bytesReclaimable, payload.length); // first copy stranded
  assert.deepEqual(hits[0].layers, [1]);
  assert.match(hits[0].title, /Metadata-only/);
});

test('metadata-only-rewrite stays silent for a size-changing rewrite even under chmod', async () => {
  const a = await analyze([
    [{ name: 'usr/bin/app', content: randomContent(2 * 1024 * 1024, 42) }],
    [{ name: 'usr/bin/app', content: randomContent(3 * 1024 * 1024, 43) }],
  ], [
    { created_by: '/bin/sh -c cp app /usr/bin/app' },
    { created_by: '/bin/sh -c chmod 755 /usr/bin/app && strip /usr/bin/app' },
  ]);
  assert.equal(byId(buildSuggestions(a), 'metadata-only-rewrite').length, 0);
});

test('metadata-only-rewrite reports very large equal-size rewrites without a metadata command, cautiously worded', async () => {
  const payload = randomContent(5 * 1024 * 1024, 44);
  const a = await analyze([
    [{ name: 'opt/blob.bin', content: payload }],
    [{ name: 'opt/blob.bin', content: payload }],
  ], [
    { created_by: '/bin/sh -c cp blob /opt/blob.bin' },
    { created_by: '/bin/sh -c cp other-blob /opt/blob.bin' },
  ]);
  const hits = byId(buildSuggestions(a), 'metadata-only-rewrite');
  assert.equal(hits.length, 1);
  assert.doesNotMatch(hits[0].title, /Metadata-only/);
  assert.match(hits[0].detail, /same size/);
});

test('metadata-only-rewrite stays silent for small equal-size rewrites without a metadata command', async () => {
  const payload = randomContent(256 * 1024, 45);
  const a = await analyze([
    [{ name: 'etc/app/config.yml', content: payload }],
    [{ name: 'etc/app/config.yml', content: payload }],
  ], [
    { created_by: '/bin/sh -c cp config.yml /etc/app/' },
    { created_by: '/bin/sh -c cp config.yml /etc/app/' },
  ]);
  assert.equal(byId(buildSuggestions(a), 'metadata-only-rewrite').length, 0);
});

// ---------------- rule 5: largest wasted paths ----------------

test('top-wasted-paths lists the biggest duplicated paths with bytes', async () => {
  const waste = randomContent(6 * 1024 * 1024, 51);
  const a = await analyze([
    [{ name: 'opt/waste.bin', content: waste }],
    [{ name: 'opt/waste.bin', content: randomContent(6 * 1024 * 1024, 52) }],
  ], [
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/opt/waste.bin bs=1M count=6' },
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/opt/waste.bin bs=1M count=6' },
  ]);
  const hits = byId(buildSuggestions(a), 'top-wasted-paths');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].paths[0], '/opt/waste.bin');
  assert.equal(hits[0].bytesReclaimable, 6 * 1024 * 1024);
  assert.equal(hits[0].severity, 'medium'); // 6 MiB < 8 MiB high threshold
});

test('top-wasted-paths stays silent on a clean image', async () => {
  const a = await analyze([
    [{ name: 'etc/keep.txt', content: Buffer.from('keep\n') }],
  ], [{ created_by: '/bin/sh -c echo keep > /etc/keep.txt' }]);
  const suggestions = buildSuggestions(a);
  assert.equal(byId(suggestions, 'top-wasted-paths').length, 0);
  assert.deepEqual(suggestions, []); // clean image: no suggestions at all
});

// ---------------- cross-cutting ----------------

test('suggestions are sorted by severity then bytes, and carry the required fields', async () => {
  const a = await analyze([
    [{ name: 'data/big.bin', content: randomContent(9 * 1024 * 1024, 61) }],
    [{ name: 'data/.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) }],
  ], [
    { created_by: '/bin/sh -c dd if=/dev/urandom of=/data/big.bin bs=1M count=9' },
    { created_by: '/bin/sh -c rm /data/big.bin' },
  ]);
  const suggestions = buildSuggestions(a);
  assert.ok(suggestions.length >= 2); // add-then-delete + top-wasted-paths
  const rank = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < suggestions.length; i++) {
    assert.ok(rank[suggestions[i - 1].severity] <= rank[suggestions[i].severity]);
  }
  for (const s of suggestions) {
    for (const field of ['id', 'severity', 'title', 'detail', 'fix']) {
      assert.equal(typeof s[field], 'string');
      assert.ok(s[field].length > 0, `${field} must not be empty`);
    }
    assert.ok(Array.isArray(s.layers) && s.layers.every((n) => Number.isInteger(n)));
    assert.ok(Array.isArray(s.paths) && s.paths.length > 0);
    assert.ok(Number.isFinite(s.bytesReclaimable) && s.bytesReclaimable > 0);
  }
});

test('every rule reports layers as 0-based indices and bytes as numbers', async () => {
  const a = await analyze([
    [{ name: 'x/y.bin', content: randomContent(512 * 1024, 71) }],
    [{ name: 'x/y.bin', content: randomContent(512 * 1024, 72) }],
  ], [
    { created_by: 'RUN a' },
    { created_by: 'RUN b' },
  ]);
  for (const s of buildSuggestions(a)) {
    for (const l of s.layers) assert.ok(l >= 0 && l < a.layerCount);
  }
});

test('buildSuggestions tolerates a missing/empty analysis object', () => {
  assert.deepEqual(buildSuggestions(null), []);
  assert.deepEqual(buildSuggestions({}), []);
});
