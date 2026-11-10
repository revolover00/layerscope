// Unit tests for src/core/exporter.js — document shape, filter honouring,
// deterministic serialization and filename handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import {
  buildExport, exportToJSON, exportToCSV, exportFilename, EXPORT_SCHEMA_VERSION,
} from '../src/core/exporter.js';
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

// add 200 KiB config (rewritten in layer 2) + delete a 5 MiB file in layer 2
const buildFixture = async () => {
  const buf = synthesizeRaw({
    format: 'legacy',
    compression: 'none',
    layers: [
      withDirs([
        { name: 'app/config.txt', content: randomContent(200 * 1024, 1001), mode: 0o644 },
        { name: 'etc/keep.txt', content: Buffer.from('keep-me\n') },
        { name: 'data/big.bin', content: randomContent(5 * 1024 * 1024, 1002), mode: 0o644 },
      ]),
      withDirs([{ name: 'data/.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) }]),
      withDirs([{ name: 'app/config.txt', content: randomContent(200 * 1024, 1003), mode: 0o644 }]),
    ],
    history: [
      { created_by: '/bin/sh -c dd if=/dev/urandom of=/app/config.txt bs=1k count=200' },
      { created_by: '/bin/sh -c rm /data/big.bin' },
      { created_by: '/bin/sh -c sed -i s/a/c/ /app/config.txt' },
    ],
    repoTag: 'example/export-test:latest',
  });
  return analyzeImage(new MemBlob(buf));
};

const FIXED_NOW = '2026-11-06T12:00:00.000Z';
const buildDoc = (a, filters) => buildExport(a, { generatedAt: FIXED_NOW, filters });

test('export document carries the schema version and the required sections', async () => {
  const a = await buildFixture();
  const doc = buildDoc(a);
  assert.equal(doc.schemaVersion, EXPORT_SCHEMA_VERSION);
  assert.equal(doc.tool, 'layerscope');
  assert.equal(doc.exportedAt, FIXED_NOW);
  assert.equal(doc.image.name, 'example/export-test:latest');
  assert.equal(doc.image.format, 'docker-save (legacy)');
  assert.equal(doc.summary.layerCount, 3);
  assert.equal(doc.layers.length, 3);
  assert.ok(doc.diffs.length > 0);
  assert.ok(doc.wastedPaths.length >= 1);
  // summary mirrors the analysis
  assert.equal(doc.summary.totalSizeBytes, a.totalSizeBytes);
  assert.equal(doc.summary.wastedBytes, a.wastedBytes);
  assert.equal(doc.summary.reclaimableBytes, a.reclaimableBytes);
  assert.equal(doc.summary.efficiency, a.efficiency);
  // wastedPaths mirror a.inefficiencies
  assert.deepEqual(doc.wastedPaths.map((w) => [w.path, w.count, w.sizeBytes]),
    a.inefficiencies.map((i) => [i.path, i.count, i.sizeBytes]));
});

test('layers section records per-layer counts and sizes', async () => {
  const a = await buildFixture();
  const doc = buildDoc(a);
  assert.equal(doc.layers[0].index, 0);
  assert.equal(doc.layers[0].counts.added, a.layers[0].added.length);
  assert.equal(doc.layers[1].counts.deleted, 1);
  assert.equal(doc.layers[0].sizeBytes, a.layers[0].sizeBytes);
  assert.equal(doc.layers[0].compressedBytes, a.layers[0].compressedBytes);
});

test('path filter narrows diffs; wasted filter narrows wasted paths; both are recorded', async () => {
  const a = await buildFixture();
  const doc = buildDoc(a, { fileKind: 'all', pathFilter: 'config', wastedPathFilter: 'big' });
  assert.ok(doc.diffs.length > 0);
  assert.ok(doc.diffs.every((d) => d.path.includes('config')));
  assert.equal(doc.wastedPaths.length, 1);
  assert.equal(doc.wastedPaths[0].path, '/data/big.bin');
  assert.equal(doc.filters.pathFilter, 'config');
  assert.equal(doc.filters.wastedPathFilter, 'big');
});

test('fileKind=deleted includes both whiteouts and opaque markers', async () => {
  const buf = synthesizeRaw({
    format: 'legacy',
    compression: 'none',
    layers: [
      withDirs([{ name: 'etc/keep.txt', content: Buffer.from('keep\n') }]),
      withDirs([{ name: 'etc/.wh..wh..opq', typeflag: '0', content: Buffer.alloc(0) }]),
      withDirs([{ name: 'etc/.wh.keep.txt', typeflag: '0', content: Buffer.alloc(0) }]),
    ],
    history: [
      { created_by: 'RUN echo keep > /etc/keep.txt' },
      { created_by: 'RUN rm -rf /etc && mkdir /etc' },
      { created_by: 'RUN rm /etc/keep2.txt' },
    ],
    repoTag: 'example/opaque-test:latest',
  });
  const a = await analyzeImage(new MemBlob(buf));
  const doc = buildExport(a, { generatedAt: FIXED_NOW, filters: { fileKind: 'deleted' } });
  const kinds = doc.diffs.map((d) => d.kind);
  assert.ok(kinds.includes('opaque'));
  assert.ok(kinds.includes('deleted'));
  assert.ok(!kinds.includes('added'));
  assert.ok(!kinds.includes('modified'));
});

test('fileKind narrows diffs by kind with selectedLayer recorded but not applied', async () => {
  const a = await buildFixture();
  const added = buildDoc(a, { fileKind: 'added', selectedLayer: 0 });
  assert.ok(added.diffs.every((d) => d.kind === 'added'));
  assert.equal(added.filters.selectedLayer, 0);
  const modified = buildDoc(a, { fileKind: 'modified', selectedLayer: 0 });
  assert.ok(modified.diffs.every((d) => d.kind === 'modified'));
  // recorded, not limiting: layer 2 still appears although selectedLayer is 0
  assert.ok(modified.diffs.some((d) => d.layer === 2 && d.path === '/app/config.txt'));
  const mod2 = buildDoc(a, { fileKind: 'modified' });
  assert.ok(mod2.diffs.some((d) => d.path === '/app/config.txt'));
});

test('JSON export is deterministic for a fixed timestamp and parses cleanly', async () => {
  const a = await buildFixture();
  const s1 = exportToJSON(buildDoc(a));
  const s2 = exportToJSON(buildDoc(a));
  assert.equal(s1, s2);
  const doc = JSON.parse(s1);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.diffs.length, buildDoc(a).diffs.length);
});

test('CSV export has the documented header, self-describing rows and LF endings', async () => {
  const a = await buildFixture();
  const csv = exportToCSV(buildDoc(a));
  assert.ok(!csv.includes('\r'));
  assert.ok(csv.endsWith('\n'));
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'schemaVersion,section,layer,kind,path,sizeBytes,oldSizeBytes,compressedBytes,copies,cumulativeBytes,removedBytes,whiteoutPath,targetKnown,directory,opaque');
  const sectionOf = (l) => l.split(',')[1];
  const layerRows = lines.filter((l) => sectionOf(l) === 'layer');
  const diffRows = lines.filter((l) => sectionOf(l) === 'diff');
  const wastedRows = lines.filter((l) => sectionOf(l) === 'wasted');
  assert.equal(layerRows.length, 3);
  assert.ok(diffRows.length > 0);
  assert.ok(wastedRows.length > 0);
  for (const line of lines.slice(1)) {
    assert.equal(line.split(',').length, 15, `row has 15 columns: ${line}`);
  }
});

test('CSV export is byte-for-byte deterministic and carries no timestamp', async () => {
  const a = await buildFixture();
  const csv1 = exportToCSV(buildDoc(a));
  const csv2 = exportToCSV(buildExport(a, { generatedAt: '2030-01-01T00:00:00.000Z' }));
  assert.equal(csv1, csv2, 'generatedAt must not leak into the CSV');
});

test('CSV cells are RFC-4180 escaped when they contain commas or quotes', async () => {
  const buf = synthesizeRaw({
    format: 'legacy',
    compression: 'none',
    layers: [
      withDirs([{ name: 'app/weird", name.txt', content: Buffer.from('x\n') }]),
    ],
    history: [{ created_by: 'RUN echo x > "app/weird"", name.txt"' }],
    repoTag: 'example/csv-escape:latest',
  });
  const a = await analyzeImage(new MemBlob(buf));
  const csv = exportToCSV(buildExport(a, { generatedAt: FIXED_NOW }));
  assert.match(csv, /"\/app\/weird"", name\.txt"/);
});

test('exportFilename sanitises the image name and stamps UTC time', async () => {
  const a = await buildFixture();
  const doc = buildDoc(a);
  const name = exportFilename(doc, 'json', new Date(Date.UTC(2026, 10, 6, 12, 30, 45)));
  assert.equal(name, 'layerscope-example-export-test-latest-20261106-123045.json');
});

test('exportFilename falls back to "image" for unusable names', () => {
  assert.equal(exportFilename({ image: { name: '***' } }, 'csv', new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), 'layerscope-image-20260102-030405.csv');
  assert.equal(exportFilename({ image: { name: null } }, 'csv', new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), 'layerscope-image-20260102-030405.csv');
});

test('buildExport refuses a non-analysis input', () => {
  assert.throws(() => buildExport(null), TypeError);
  assert.throws(() => buildExport({}), TypeError);
});
