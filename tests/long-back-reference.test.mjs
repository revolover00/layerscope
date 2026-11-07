// zstd frame with a back-reference distance LARGER than 8 MiB.
//
// A match distance of 10 MiB requires a >8 MiB zstd window (ZSTD_c_windowLog
// >= 24 for a 16 MiB window). The vendored fallback decoder (fzstd-based,
// byte-capped) must either decode this frame to byte-identical content, or
// fail with a clear, specific error naming the window/back-reference/limit —
// never a silent corruption nor a cryptic generic failure.
//
// NOTE (verified against node v22.22.3): Node's zlib ignores a plain
// `windowBits` option for zstd; the window must be set through
// `params: { [ZSTD_c_windowLog]: 24 }` to produce an actual long back-ref.
// The distance is pinned by construction: one 1 MiB marker, a 9 MiB filler,
// then the marker repeated — the pair of markers is exactly 10 MiB apart,
// and the frame is ~1 MiB (the repeat was captured, not stored twice).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { zstdFrameContentSize } from '../src/core/zstd.js';
import { decodeZstdCapped, LayerLimitError } from '../src/core/zstd-decode.js';

const C = zlib.constants;

function buildLongBackRefFixture({ withContentSize = true } = {}) {
  const marker = crypto.randomBytes(1024 * 1024);  // 1 MiB unique marker block
  const filler = Buffer.alloc(9 * 1024 * 1024, 0x41); // 9 MiB constant filler
  const original = Buffer.concat([marker, filler, marker]);
  const distance = original.length - marker.length;   // 10 MiB > 8 MiB
  assert.ok(distance > 8 * 1024 * 1024, `fixture must exceed 8 MiB back-reference, got ${distance}`);

  const params = {
    [C.ZSTD_c_compressionLevel]: 3,
    [C.ZSTD_c_windowLog]: 24, // 16 MiB window — required to cover a 10 MiB distance
  };
  if (!withContentSize) params[C.ZSTD_c_contentSizeFlag] = 0;
  const frame = zlib.zstdCompressSync(original, { params });
  return { original, frame, distance };
}

test('zstd frame with a 10 MiB back-reference decodes byte-identically', () => {
  const { original, frame } = buildLongBackRefFixture();
  assert.equal(zstdFrameContentSize(new Uint8Array(frame)), original.length);

  let out;
  try {
    out = decodeZstdCapped(new Uint8Array(frame), { maxBytes: original.length });
  } catch (err) {
    // Acceptable outcome B (per spec): a clear, specific error naming the
    // window/back-reference/limit — never a silent pass or generic noise.
    assert.match(
      err.message,
      /window|distance|back.?reference|long.?range|ultra|windowTooLarge|limit/i,
      `error message must name the actual constraint, got: ${err.message}`,
    );
    return;
  }
  assert.equal(Buffer.from(out).equals(original), true, 'roundtrip must be byte-identical');
});

test('same >8 MiB back-reference frame WITHOUT a content size also round-trips (fallback path covers no-FCS long window)', () => {
  const { original, frame } = buildLongBackRefFixture({ withContentSize: false });
  assert.equal(zstdFrameContentSize(new Uint8Array(frame)), null); // no FCS in header

  let out;
  try {
    out = decodeZstdCapped(new Uint8Array(frame), { maxBytes: original.length });
  } catch (err) {
    assert.ok(err instanceof LayerLimitError || /window|distance|back.?reference|windowTooLarge|limit/i.test(err.message), `expected LayerLimitError or an explicit window/limit message, got: ${err.message}`);
    return;
  }
  assert.equal(Buffer.from(out).equals(original), true, 'roundtrip must be byte-identical');
});
