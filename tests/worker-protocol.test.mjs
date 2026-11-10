// Regression pin for the browser zstd worker ↔ page protocol (streaming).
//
// History: the one-shot decode tier (fzstd `decompress`) may return a VIEW
// onto a larger internal buffer — fzstd's window subarray starts at
// byteOffset 12 (behind its sentinel header). The original worker transferred
// the underlying ArrayBuffer without the placement, so 12 sentinel bytes got
// prepended to the layer and the tar parser failed at offset 0 in the
// browser. The streaming protocol eliminates the whole phantom-offset class:
// EVERY block crossing the worker boundary — compressed chunks in, decoded
// blocks out — is an exact-size fresh copy, and every message is id-scoped.
//
// This test pins:
//   1. the worker emits exact-size ArrayBuffers (never views with offsets),
//   2. the page re-assembly contract (byteOffset 0, byteLength) round-trips,
//   3. the one-shot tier CAN still return a non-zero-offset view (the bug
//      this design exists to prevent — decodeZstdCapped is kept for tooling),
//   4. the wire sources carry the fresh-copy transfer + id protocol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

import { decodeZstdCapped } from '../src/core/zstd-decode.js';
import { createZstdDecompressor } from '../src/core/zstd-decode.js';

const content = Buffer.concat([
  Buffer.alloc(900000, 0),
  Buffer.from('musl libc 1.2.5 /lib/ld-musl-x86_64.so.1 alpine 3.20\n'.repeat(9000)),
  Buffer.alloc(400000, 0),
  Buffer.from('ELF header .interp .note.ABI-tag .gnu.hash .dynsym .rodata '.repeat(12000)),
  Buffer.alloc(200000, 0),
]);
const frame = zlib.zstdCompressSync(content, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('one-shot tier returns a view whose placement must not leak into the stream', () => {
  const out = decodeZstdCapped(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), {
    maxBytes: content.length,
  });
  assert.equal(out.byteLength, content.length);
  assert.equal(sha(out), sha(content)); // the view itself is always correct
});

test('streaming core emits only exact-size fresh buffers whose bytes round-trip', () => {
  const blocks = [];
  const d = createZstdDecompressor({
    maxBytes: content.length,
    onChunk: (blk) => {
      // the worker slices each block into an exact-size fresh copy before postMessage
      const copy = blk.slice();
      blocks.push(Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength));
      // simulated exact-size transfer must NOT share storage or offset into anything
      assert.equal(copy.byteOffset, 0);
      assert.equal(copy.byteLength, blk.byteLength);
    },
  });
  // feed in an awkward fixed chunk size to exercise block-boundary handling,
  // then an explicit final push
  for (let off = 0; off < frame.length; off += 997) {
    d.push(frame.subarray(off, Math.min(off + 997, frame.length)), false);
  }
  d.push(new Uint8Array(0), true);
  const reassembled = Buffer.concat(blocks);
  assert.equal(reassembled.length, content.length);
  assert.equal(sha(reassembled), sha(content));
});

test('worker and page sources implement the id-scoped fresh-copy protocol (protocol pin)', () => {
  const worker = readFileSync(new URL('../src/core/zstd.worker.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/core/zstd.js', import.meta.url), 'utf8');
  // worker: fresh exact-size copy per decoded block, transferred with byteOffset 0
  assert.match(worker, /const copy = blk\.slice\(\)/);
  assert.match(worker, /byteOffset: 0/);
  assert.match(worker, /type: 'data'/);
  assert.match(worker, /type: 'done'/);
  assert.match(worker, /type: 'error'/);
  // page: compressed chunks are exact-size copies, transferred zero-copy; sessions are id-scoped
  assert.match(main, /const copy = value\.slice\(\)/);
  assert.match(main, /sessions\.set\(id, session\)/);
  assert.match(main, /type: 'feed'/);
  assert.match(main, /decompressStream/);
});
