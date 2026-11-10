// Streaming zstd fallback: window policy, chunk-boundary decode, and
// outer-wrapper (.tar.gz / .tar.zst) equivalence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { gzipSync, gunzipSync } from 'node:zlib';

import { analyzeImage } from '../src/core/analyze.js';
import { iterTarEntries, openTarEntryDataStream, blobReadableStream } from '../src/core/tar.js';
import {
  zstdFrameWindowSize,
  enforceZstdWindowLimit,
  WindowSizeError,
  decompressReadable,
  ZSTD_MAX_WINDOW_BYTES,
} from '../src/core/zstd-decode.js';
import { synthesizeRawAsync } from '../tools/synth-lib.mjs';

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

function chunkedStream(bytes, chunkSize) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const next = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
  });
}

const randContent = (size, seed) => {
  let s = seed;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = s & 0xff; }
  return buf;
};

// A real 10 MiB level-3 frame (explicit window descriptor 0x58 → 2 MiB window)
// whose window byte is patched, as a crafted hostile/ultra frame would have it.
const makeWindowFrame = (windowByte) => {
  const frame = zlib.zstdCompressSync(randContent(10 * 1024 * 1024, 99), {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  assert.equal(frame[4] & 0x20, 0, 'expected an explicit-window-descriptor frame');
  frame[5] = windowByte;
  return frame;
};

test('zstdFrameWindowSize: level-3 frame reports a 2 MiB window', () => {
  const frame = zlib.zstdCompressSync(randContent(10 * 1024 * 1024, 7), {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  assert.equal(zstdFrameWindowSize(frame), 2 * 1024 * 1024);
});

test('a frame with a 36 MiB window is refused with WINDOW_TOO_BIG naming both sizes', async () => {
  const frame = makeWindowFrame(0x79); // ws = 36 MiB
  assert.equal(zstdFrameWindowSize(frame), 36 * 1024 * 1024);
  assert.throws(() => enforceZstdWindowLimit(frame), (err) => {
    assert.ok(err instanceof WindowSizeError);
    assert.equal(err.code, 'WINDOW_TOO_BIG');
    assert.equal(err.windowBytes, 36 * 1024 * 1024);
    assert.match(err.message, /36\.0 MiB/);
    assert.match(err.message, /32 MiB/);
    return true;
  });
});

test('a frame with exactly the 32 MiB window is accepted', () => {
  const frame = makeWindowFrame(0x78); // ws = exactly 32 MiB
  assert.equal(zstdFrameWindowSize(frame), ZSTD_MAX_WINDOW_BYTES);
  assert.doesNotThrow(() => enforceZstdWindowLimit(frame));
});

test('analyzeImage refuses an OCI archive whose zstd layer demands a 36 MiB window', async () => {
  const frame = makeWindowFrame(0x79);
  const buf = await synthesizeRawAsync({
    format: 'oci-save',
    compression: 'zstd',
    rawLayerBlobs: [frame],
    layers: [[{ name: 'data/big.bin', content: Buffer.alloc(1024, 1), mode: 0o644 }]],
    history: [{ created_by: 'RUN ultra-compress' }],
    repoTag: 'layerscope/window:latest',
  });
  await assert.rejects(
    () => analyzeImage(new MemBlob(buf)),
    (err) => {
      assert.match(err.message, /WINDOW|window/);
      assert.match(err.message, /36\.0 MiB/);
      assert.match(err.message, /Failed to unpack layer 1\/1/);
      return true;
    },
  );
});

test('zstd frame split at 1, 2, 3 bytes decompresses identically', async () => {
  const payload = randContent(512 * 1024, 1234);
  const frame = zlib.zstdCompressSync(payload);
  for (const chunkSize of [1, 2, 3]) {
    const decoded = decompressReadable(chunkedStream(new Uint8Array(frame), chunkSize), { maxBytes: payload.length + 1024 });
    const reader = decoded.getReader();
    const out = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(Buffer.from(value));
    }
    assert.deepEqual(Buffer.concat(out), payload, `chunk size ${chunkSize}`);
  }
});

test('tar header split across 1-byte chunks parses identically to a single chunk', async () => {
  const { buildLayerTar } = await import('../tools/synth-lib.mjs');
  const tar = buildLayerTar([
    { name: 'etc/app/config.txt', content: Buffer.from('key=value\n'.repeat(100)) },
    { name: 'data/blob.bin', content: randContent(2048, 55) },
  ]);
  const collect = async (stream) => {
    const entries = [];
    for await (const { header } of iterTarEntries(stream)) entries.push([header.path, header.size]);
    return entries;
  };
  const one = await collect(chunkedStream(new Uint8Array(tar), 1024 * 1024));
  for (const chunkSize of [1, 2, 7, 512, 513]) {
    const many = await collect(chunkedStream(new Uint8Array(tar), chunkSize));
    assert.deepEqual(many, one, `chunk size ${chunkSize}`);
  }
});

test('openTarEntryDataStream drains exactly the entry bytes, byte-exact head', async () => {
  const { buildLayerTar } = await import('../tools/synth-lib.mjs');
  const first = randContent(3000, 11);
  const second = randContent(7000, 22);
  const tar = buildLayerTar([
    { name: 'a.bin', content: first },
    { name: 'b.bin', content: second },
  ]);
  // locate b.bin by walking the tar ourselves
  const blob = new MemBlob(tar);
  let target = null;
  for await (const { header, dataOffset } of iterTarEntries(blobReadableStream(blob, 0, blob.size))) {
    if (header.path === '/b.bin') target = { dataOffset, size: header.size };
  }
  assert.ok(target);
  const { stream, head } = await openTarEntryDataStream(chunkedStream(new Uint8Array(tar), 13), target.dataOffset, target.size);
  assert.deepEqual([...head], [...second.subarray(0, 32)]);
  const reader = stream.getReader();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(Buffer.from(value));
  }
  assert.deepEqual(Buffer.concat(out), second);
});

const deepFingerprint = (a) => [
  a.layerCount,
  a.totalSizeBytes,
  a.wastedBytes,
  a.efficiency,
  a.reclaimableBytes,
  JSON.stringify(a.layers.map((l) => [l.sizeBytes, l.compression, l.entryCount, l.digestId])),
  JSON.stringify(a.inefficiencies),
];

test('a gzip-wrapped docker save analyzes identically to the unwrapped archive', async () => {
  const inner = await synthesizeRawAsync({
    format: 'legacy',
    compression: 'none',
    layers: [
      [{ name: 'data/a.bin', content: randContent(2048, 1) }],
      [{ name: 'data/a.bin', content: randContent(2048, 2) }], // overwrite: real waste
    ],
    history: [{ created_by: 'RUN a' }, { created_by: 'RUN b' }],
    repoTag: 'layerscope/wrap:test',
  });
  const wrapped = gzipSync(inner);
  const plain = await analyzeImage(new MemBlob(inner));
  const via = await analyzeImage(new MemBlob(wrapped));
  assert.deepEqual(deepFingerprint(via), deepFingerprint(plain));
});

test('a zstd-wrapped OCI+zstd docker save analyzes identically to the unwrapped archive', async () => {
  const inner = await synthesizeRawAsync({
    format: 'oci-save',
    compression: 'zstd',
    layers: [
      [{ name: 'data/a.bin', content: randContent(4096, 3) }],
      [{ name: 'data/a.bin', content: randContent(4096, 4) }],
    ],
    history: [{ created_by: 'RUN a' }, { created_by: 'RUN b' }],
    repoTag: 'layerscope/wrap:test',
  });
  const wrapped = zlib.zstdCompressSync(inner, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
  const plain = await analyzeImage(new MemBlob(inner));
  const via = await analyzeImage(new MemBlob(wrapped));
  assert.deepEqual(deepFingerprint(via), deepFingerprint(plain));
  // layer compression auto-detected through the wrapper
  assert.deepEqual(via.layers.map((l) => l.compression), ['zstd', 'zstd']);
});

test('a gzip-wrapped OCI archive with gzip layers analyzes identically', async () => {
  const inner = await synthesizeRawAsync({
    format: 'oci-save',
    compression: 'gzip',
    layers: [
      [{ name: 'data/a.bin', content: randContent(4096, 5) }],
      [{ name: 'data/b.bin', content: randContent(4096, 6) }],
    ],
    history: [{ created_by: 'RUN a' }, { created_by: 'RUN b' }],
    repoTag: 'layerscope/wrap:test',
  });
  const wrapped = gzipSync(inner);
  const plain = await analyzeImage(new MemBlob(inner));
  const via = await analyzeImage(new MemBlob(wrapped));
  assert.deepEqual(deepFingerprint(via), deepFingerprint(plain));
  assert.deepEqual(via.layers.map((l) => l.compression), ['gzip', 'gzip']);
});
