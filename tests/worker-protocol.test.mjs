// Regression pin for the browser zstd worker ↔ page protocol.
//
// The one-shot decode tier (fzstd `decompress`) may return a VIEW onto a
// larger internal buffer — fzstd's window subarray starts at byteOffset 12
// (behind its sentinel header). The worker transfers the underlying
// ArrayBuffer, so the placement MUST travel with it: flattening with
// `out.buffer` alone silently prepends 12 sentinel bytes to the layer and the
// tar parser fails at offset 0 in the browser (CI: "tar: bad header checksum
// at offset 0"), while node-side tests that called decodeZstdCapped()
// directly all passed. This test pins:
//   1. the one-shot tier CAN return a non-zero-offset view (test premise),
//   2. the page/worker re-assembly (byteOffset/byteLength) round-trips
//      byte-exact, and
//   3. the naive (buggy) re-assembly is caught by the same check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

import { decodeZstdCapped } from '../src/core/zstd-decode.js';

const content = Buffer.concat([
  Buffer.alloc(900000, 0),
  Buffer.from('musl libc 1.2.5 /lib/ld-musl-x86_64.so.1 alpine 3.20\n'.repeat(9000)),
  Buffer.alloc(400000, 0),
  Buffer.from('ELF header .interp .note.ABI-tag .gnu.hash .dynsym .rodata '.repeat(12000)),
  Buffer.alloc(200000, 0),
]);
const frame = zlib.zstdCompressSync(content, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('one-shot tier returns a view the worker must re-place byte-exact', () => {
  const out = decodeZstdCapped(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), {
    maxBytes: content.length,
  });
  assert.equal(out.byteLength, content.length);
  assert.equal(sha(out), sha(content)); // the view itself is always correct
});

test('worker protocol round-trip: bytes travel as (buffer, byteOffset, byteLength)', () => {
  const out = decodeZstdCapped(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), {
    maxBytes: content.length,
  });
  // exactly what zstd.worker.js posts and zstd.js's onmessage consumes
  const posted = { bytes: out.buffer, byteOffset: out.byteOffset, byteLength: out.byteLength };
  const received = new Uint8Array(posted.bytes, posted.byteOffset || 0, posted.byteLength ?? posted.bytes.byteLength);
  assert.equal(received.byteLength, content.length);
  assert.equal(sha(received), sha(content));
});

test('naive flatten (out.buffer only) is detected — this was the CI failure', () => {
  const out = decodeZstdCapped(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), {
    maxBytes: content.length,
  });
  const flat = new Uint8Array(out.buffer); // the old, broken re-assembly
  assert.notEqual(sha(flat), sha(content)); // sentinel-prefixed: tar would fail at offset 0
});

test('worker and page source carry the placement (protocol pin)', () => {
  const worker = readFileSync(new URL('../src/core/zstd.worker.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/core/zstd.js', import.meta.url), 'utf8');
  assert.match(worker, /byteOffset: out\.byteOffset/);
  assert.match(worker, /byteLength: out\.byteLength/);
  assert.match(main, /new Uint8Array\(bytes, byteOffset \|\| 0, byteLength \?\? bytes\.byteLength\)/);
});
