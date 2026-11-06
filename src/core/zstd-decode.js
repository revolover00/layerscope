// Shared zstd decode core — pure JavaScript, no WASM, no platform APIs.
// Used by BOTH the node inline path and the browser Web Worker.
//
// Why pure JS (fzstd, MIT) instead of the vendored WASM decoder:
//   1. The WASM fallback proved unsafe for cross-analysis reuse in Chromium —
//      the SAME frame decoded to DIFFERENT bytes on its second analysis in a
//      page (caught by the rootfs.diff_ids integrity check; see README
//      "Decoder integrity"). fzstd carries no shared linear memory: every
//      decode runs on a fresh internal state object, so cross-analysis
//      degradation is structurally impossible.
//   2. The WASM build exports _ZSTD_getFrameContentSize as (i32,i32)->i32
//      (low 32 bits only — the unknown-size sentinel -1 happens to round-trip,
//      but frames without a content size decode one-shot with a pre-allocated
//      worst-case heap). fzstd streams instead: bytes flow through an ondata
//      handler, so a caller-enforced byte budget can cut ANY decode off
//      mid-flight.
//
// The decoder is byte-cap ENFORCING, not merely bounded at the end: every
// ondata call adds the chunk's byte length to the running total BEFORE the
// chunk is kept, and throws the moment the total crosses maxBytes — so a
// frame with no content size in its header (streamed compression, e.g.
// containerd/buildx) can never allocate more than maxBytes. Zstd blocks are
// at most 128 KiB, so the overshoot beyond maxBytes is at most one block.

import { Decompress, decompress as fzDecompress } from '../../assets/vendor/fzstd/index.mjs';

export const zstdLimitMessage = (maxBytes) => (
  `zstd layer decompressed past the ${(maxBytes / 1048576).toFixed(0)} MiB (${maxBytes} bytes) fallback limit during decode — refusing. ` +
  `The in-browser decoder cannot bound memory for frames without a content size beyond this limit. ` +
  `Re-encode this layer as gzip (fully streaming) or split it into smaller layers. ` +
  `analyzeImage() callers can tune the limit via the maxLayerBytes option.`
);

export class LayerLimitError extends Error {
  constructor(maxBytes) {
    super(zstdLimitMessage(maxBytes));
    this.name = 'LayerLimitError';
    this.code = 'LAYER_LIMIT';
    this.maxBytes = maxBytes;
  }
}

/**
 * Read the frame content size from a zstd frame header, if present.
 * Returns the declared decompressed byte size, or null when the frame
 * carries no FCS field (e.g. streamed compression, containerd/buildx).
 * (Moved here from zstd.js so this module stays self-contained for the
 * Web Worker; zstd.js re-exports it.)
 */
export function zstdFrameContentSize(bytes) {
  if (!bytes || bytes.length < 6) return null;
  // magic: 28 b5 2f fd
  if (bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) return null;
  const descriptor = bytes[4];
  const fcsFlag = (descriptor >> 6) & 0x3;      // 0: <=1 B field, 1: 2 B, 2: 4 B, 3: 8 B
  const singleSegment = (descriptor >> 5) & 0x1;
  const dictIdFlag = descriptor & 0x3;          // 0/1/2/4 dictionary bytes follow
  let offset = 5;
  if (!singleSegment) offset += 1;              // window_descriptor
  offset += [0, 1, 2, 4][dictIdFlag];
  const at = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  if (fcsFlag === 0) {
    if (!singleSegment) return null;            // no FCS field at all
    if (bytes.length < offset + 1) return null;
    return bytes[offset];                        // 1 byte
  }
  if (fcsFlag === 1) {
    if (bytes.length < offset + 2) return null;
    return (bytes[offset] | (bytes[offset + 1] << 8)) + 256; // 2 bytes, biased by 256
  }
  if (fcsFlag === 2) {
    if (bytes.length < offset + 4) return null;
    return at(offset);                           // 4 bytes LE
  }
  // fcsFlag === 3: 8 bytes LE
  if (bytes.length < offset + 8) return null;
  const v = BigInt(at(offset + 4)) * 4294967296n + BigInt(at(offset));
  return v > 9007199254740991n ? Number.MAX_SAFE_INTEGER : Number(v);
}

/**
 * Decompress one zstd frame (or a concatenation of frames, which zstd
 * permits), enforcing a hard byte budget on decompressed output.
 *
 * Two tiers:
 *   - Frame WITH a content size: refused immediately if it exceeds maxBytes
 *     (nothing is decoded — same rule as analyze.js's upfront FCS check);
 *     otherwise the one-shot decoder (single internal assembly) — fastest.
 *   - Frame WITHOUT a content size: the streaming decoder with the cap
 *     enforced mid-flight, byte by byte, so it can never allocate past
 *     maxBytes (zstd blocks are ≤ 128 KiB, overshoot ≤ one block).
 *
 * @param {Uint8Array} frame   raw compressed bytes (the whole layer)
 * @param {object}      opts
 * @param {number}      opts.maxBytes  hard cap on DECOMPRESSED bytes
 * @returns {Uint8Array} the decompressed layer
 * @throws {LayerLimitError} if the (declared or decoded) size crosses maxBytes
 */
export function decodeZstdCapped(frame, { maxBytes }) {
  const fcs = zstdFrameContentSize(frame);
  if (fcs !== null) {
    if (fcs > maxBytes) throw new LayerLimitError(maxBytes);
    try {
      return fzDecompress(frame);
    } catch (err) {
      throw new Error(`Failed to decompress zstd layer with code: ${(err && err.message) || err}`);
    }
  }
  let total = 0;
  const chunks = [];
  const d = new Decompress((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new LayerLimitError(maxBytes);
    // fzstd emits a fresh buffer per block (verified: 64/64 unique underlying
    // ArrayBuffers on a 4 MiB frame, byte-exact across repeated decodes), and
    // the assembly below copies into `out` before returning — no aliasing
    // ever escapes this function.
    chunks.push(chunk);
  });
  try {
    d.push(frame, true);
  } catch (err) {
    if (err instanceof LayerLimitError) throw err;
    throw new Error(`Failed to decompress zstd layer with code: ${(err && err.message) || err}`);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
