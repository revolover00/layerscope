// Live round-trip of the browser page <-> zstd worker streaming protocol in
// node: the ACTUAL src/core/zstd.worker.js module is loaded in a vm with a
// fake self/postMessage, the ACTUAL page-side createZstd() worker branch is
// used by analyzeImage (globals window/document/Worker are set before the
// dynamic import), and a fake Worker shuttles ArrayBuffers between the two.
// This test exists because a protocol bug that deadlocked every fallback
// analysis above 32 MiB of in-flight compressed bytes shipped once and was
// only caught by the browser CI job.
//
// Note: this file MUST set its globals before importing src/core/analyze.js
// (node caches the module) — hence dynamic imports only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { createZstdDecompressor } from '../src/core/zstd-decode.js';

const workerSource = readFileSync(new URL('../src/core/zstd.worker.js', import.meta.url), 'utf8');

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    const page = this;
    const selfObj = {
      postMessage(data) { queueMicrotask(() => { page.onmessage?.({ data }); }); },
    };
    const body = workerSource.replace(/^import[^;]+;\s*/m, '');
    const sandbox = { self: selfObj, console, createZstdDecompressor, globalThis: null };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(body, sandbox);
    this._self = selfObj;
  }
  postMessage(data) {
    queueMicrotask(() => {
      try { this._self.onmessage?.({ data }); }
      catch (err) { this.onerror?.({ message: err.message }); }
    });
  }
  terminate() {}
}

globalThis.window = {};
globalThis.document = {};
globalThis.Worker = FakeWorker;

const { analyzeImage } = await import('../src/core/analyze.js');
const { buildFixtureAsync } = await import('../tools/fixtures.mjs');
const { synthesizeRawAsync, randomContent } = await import('../tools/synth-lib.mjs');

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

test('fake-worker end-to-end analysis matches the expected fixture numbers', async () => {
  const buf = await buildFixtureAsync('oci-save-zstd');
  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.layerCount, 3);
  assert.equal(a.totalSizeBytes, 5089);
  assert.equal(a.wastedBytes, 30);
  assert.deepEqual(a.layers.map((l) => l.compression), ['zstd', 'zstd', 'zstd']);
  assert.equal(a.imageName, 'fixture:latest');
  assert.ok(a.layers.every((l) => l.digestId));
});

test('40 MiB incompressible layer completes through the fake worker (in-flight cap regression)', async () => {
  const content = randomContent(40 * 1024 * 1024, 987654); // must exceed the 32 MiB in-flight cap
  const buf = await synthesizeRawAsync({
    format: 'oci-save',
    compression: 'zstd',
    layers: [[{ name: 'data/big.bin', content, mode: 0o644 }]],
    history: [{ created_by: 'RUN big' }],
    repoTag: 'layerscope/big:test',
  });
  assert.ok(buf.length > 32 * 1024 * 1024, 'fixture must exceed the in-flight cap');
  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.layerCount, 1);
  assert.equal(a.totalSizeBytes, 40 * 1024 * 1024);
});

// A corrupted layer frame must NEVER yield a silently wrong analysis — it
// must reject, either at decode (fzstd error through the worker), at tar
// parse, or at the rootfs.diff_ids integrity check. Which family fires
// depends on where the bytes broke (and on the encoder build), so pin the
// contract, not the byte position.
for (const [label, corrupt] of [
  ['truncated mid-body', (donor) => donor.subarray(0, donor.length - 64)],
  ['last byte flipped', (donor) => { const b = Buffer.from(donor); b[b.length - 1] ^= 0xff; return b; }],
  ['first body block byte flipped', (donor) => { const b = Buffer.from(donor); b[Math.min(20, b.length - 1)] ^= 0xff; return b; }],
]) {
  test(`corrupted frame (${label}) rejects — never a silent wrong analysis`, async () => {
    const zlib = await import('node:zlib');
    const payload = randomContent(256 * 1024, 42); // incompressible — no degenerate tiny frames
    const donor = zlib.zstdCompressSync(payload, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
    const buf = await synthesizeRawAsync({
      format: 'oci-save',
      compression: 'zstd',
      rawLayerBlobs: [corrupt(donor)],
      layers: [[{ name: 'data/x.bin', content: payload, mode: 0o644 }]],
      history: [{ created_by: 'RUN x' }],
      repoTag: 'layerscope/corrupt:test',
    });
    await assert.rejects(
      () => analyzeImage(new MemBlob(buf)),
      /Failed to unpack layer 1\/1|Integrity check failed: layer 1\/1/,
    );
  });
}
