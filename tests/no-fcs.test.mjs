// zstd frames WITHOUT a content size in the header — as produced by
// streamed compression (containerd/buildx). zstdFrameContentSize() returns
// null for them, so the up-front FCS refusal cannot fire; the decode itself
// must enforce the byte cap. These tests pin that behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import { zstdFrameContentSize, nativeZstdStream, decompressZstd } from '../src/core/zstd.js';
import { decodeZstdCapped, LayerLimitError } from '../src/core/zstd-decode.js';
import { synthesizeRawAsync } from '../tools/synth-lib.mjs';
import zlib from 'node:zlib';

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

// spec.zstdContentSizeFlag is honored by synth-lib: 0 emits no-FCS frames.
function buildArchive({ contentSizeFlag = null, layers }) {
  const spec = {
    format: 'oci-save',
    compression: 'zstd',
    layers,
    history: [{ created_by: 'RUN dd if=/dev/urandom of=/data/big.bin' }],
    repoTag: 'layerscope/no-fcs:latest',
  };
  if (contentSizeFlag !== null) spec.zstdContentSizeFlag = contentSizeFlag;
  return synthesizeRawAsync(spec);
}

const layer = () => [{ name: 'data/big.bin', content: Buffer.from('0123456789abcdef'.repeat(131072)), mode: 0o644 }]; // 2 MiB, compressible
const randLayer = (size = 2 * 1024 * 1024) => {
  const r = (() => { let s = 1234; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; }; })();
  const c = Buffer.alloc(size);
  for (let i = 0; i < size; i++) c[i] = r() % 256;
  return [{ name: 'data/big.bin', content: c, mode: 0o644 }];
};

test('zstdFrameContentSize: no-FCS frame parses as null', async () => {
  const buf = Buffer.from(zlib.zstdCompressSync(Buffer.alloc(1024, 65), {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_contentSizeFlag]: 0 },
  }));
  assert.equal(zstdFrameContentSize(buf), null);
});

test('env supports falling back (no native DecompressionStream zstd in node runtimes)', () => {
  // informational only — the fallback path is what these tests exercise
  assert.equal(typeof nativeZstdStream(), 'boolean');
});

test('capped streaming decode: exact-limit boundary passes, one byte under refuses', () => {
  const payload = Buffer.alloc(1024 * 1024, 66);
  const frame = zlib.zstdCompressSync(payload, { params: { [zlib.constants.ZSTD_c_contentSizeFlag]: 0 } });
  const at = decodeZstdCapped(new Uint8Array(frame), { maxBytes: payload.length });
  assert.equal(at.length, payload.length);
  assert.throws(() => decodeZstdCapped(new Uint8Array(frame), { maxBytes: payload.length - 1 }), (err) => {
    assert.ok(err instanceof LayerLimitError);
    assert.equal(err.code, 'LAYER_LIMIT');
    assert.match(err.message, /during decode/);
    return true;
  });
});

test('no-FCS archive analyzes identically to the FCS variant (same layer, same digestIds)', async () => {
  const fcs = await buildArchive({ contentSizeFlag: null, layers: [randLayer()] });
  const nofcs = await buildArchive({ contentSizeFlag: 0, layers: [randLayer()] });
  const a = await analyzeImage(new MemBlob(fcs));
  const b = await analyzeImage(new MemBlob(nofcs));
  assert.deepEqual(b.layers.map((l) => l.digestId), a.layers.map((l) => l.digestId));
  assert.equal(b.totalSizeBytes, a.totalSizeBytes);
  assert.equal(b.wastedBytes, a.wastedBytes);
  assert.equal(b.efficiency, a.efficiency);
  assert.equal(b.layerCount, a.layerCount);
});

test('no-FCS over-limit: refusal happens DURING decode with a clear error', async () => {
  const buf = await buildArchive({ contentSizeFlag: 0, layers: [randLayer(2 * 1024 * 1024)] });
  await assert.rejects(
    () => analyzeImage(new MemBlob(buf), { maxLayerBytes: 1024 * 1024 }),
    (err) => {
      assert.match(err.message, /fallback limit during decode/);
      assert.doesNotMatch(err.message, /before allocating/); // the FCS fast path cannot fire here
      assert.match(err.message, /gzip/);
      return true;
    },
  );
});

test('huge-claims no-FCS: a tiny archive declaring nothing, decoding to 600 MiB of zeros, is cut off mid-decode', async () => {
  // Under the default 8 GiB ceiling this decodes fine — the cut-off is exercised
  // here with a smaller caller-supplied ceiling instead (analyzeImage accepts
  // maxLayerBytes), which is also how the browser-limit path is configured.
  const zeros = Buffer.alloc(600 * 1024 * 1024, 0);
  const buf = await synthesizeRawAsync({
    format: 'oci-save',
    compression: 'zstd',
    zstdContentSizeFlag: 0,
    layers: [[{ name: 'data/zeros.bin', content: zeros, mode: 0o644 }]],
    history: [{ created_by: 'RUN dd if=/dev/zero of=/data/zeros.bin bs=1M count=600' }],
    repoTag: 'layerscope/huge-claims:latest',
  });
  assert.ok(buf.length < 1024 * 1024, `archive must be tiny, got ${buf.length}`);
  await assert.rejects(
    () => analyzeImage(new MemBlob(buf), { maxLayerBytes: 100 * 1024 * 1024 }),
    (err) => {
      assert.match(err.message, /during decode/);
      assert.match(err.message, /fallback limit/);
      assert.match(err.message, /100 MiB/);
      return true;
    },
  );
});

test('huge-claims no-FCS: a frame with a 17 GiB declared content size is refused before decoding under the default ceiling', async () => {
  // The pre-decode refusal path (FCS present, over the default 8 GiB budget):
  // declared = 17 GiB >= Number.MAX_SAFE_INTEGER guard? No — 17 GiB fits easily.
  // The archive itself is tiny; the refusal happens on the header alone.
  // Hand-build a frame header claiming 17 GiB (explicit window descriptor
  // frame, fcsFlag 3 = 8-byte FCS) with a REAL 1 MiB frame's block bytes as
  // the body — the refusal must fire on the header, before any decode.
  const payload = Buffer.alloc(1024 * 1024, 65);
  const donor = zlib.zstdCompressSync(payload, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  const donorFhd = donor[4];
  const donorFcsFlag = (donorFhd >> 6) & 3;
  const donorSingleSegment = (donorFhd >> 5) & 1;
  let donorHeaderLen = 5;
  if (!donorSingleSegment) donorHeaderLen += 1;
  donorHeaderLen += [0, 1, 2, 4][donorFhd & 0x3];
  if (donorFcsFlag === 0) donorHeaderLen += donorSingleSegment ? 1 : 0;
  else if (donorFcsFlag === 1) donorHeaderLen += 2;
  else if (donorFcsFlag === 2) donorHeaderLen += 4;
  else donorHeaderLen += 8;
  const blocks = donor.subarray(donorHeaderLen);
  const frame = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), // magic
    Buffer.from([0xc0]),                   // FHD: fcsFlag 3 (8-byte FCS), no single-segment, no dict id
    Buffer.from([0x58]),                   // window descriptor: 2 MiB window (valid)
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(17n * 1024n * 1024n * 1024n); return b; })(),
    blocks,
  ]);
  const buf = await synthesizeRawAsync({
    format: 'oci-save',
    compression: 'zstd',
    rawLayerBlobs: [frame],
    layers: [[{ name: 'data/zeros.bin', content: Buffer.alloc(1024, 65), mode: 0o644 }]],
    history: [{ created_by: 'RUN dd if=/dev/zero of=/data/zeros.bin bs=1G count=17' }],
    repoTag: 'layerscope/huge-claims:latest',
  });
  await assert.rejects(
    () => analyzeImage(new MemBlob(buf)),
    (err) => {
      assert.match(err.message, /exceeding the 8192 MiB/);
      assert.match(err.message, /before allocating memory/);
      return true;
    },
  );
});

test('decompressZstd accepts the session facade used by analyzeImage', async () => {
  const buf = await buildArchive({ contentSizeFlag: 0, layers: [layer()] });
  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.layerCount, 1);
});
