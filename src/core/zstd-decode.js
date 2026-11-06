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

import { Decompress } from '../../assets/vendor/fzstd/index.mjs';

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
 * Decompress one zstd frame (or a concatenation of frames, which zstd
 * permits) using the streaming decoder, enforcing a hard byte budget.
 *
 * @param {Uint8Array} frame   raw compressed bytes (the whole layer)
 * @param {object}      opts
 * @param {number}      opts.maxBytes  hard cap on DECOMPRESSED bytes
 * @returns {Uint8Array} the decompressed layer
 * @throws {LayerLimitError} if the decode crosses maxBytes
 */
export function decodeZstdCapped(frame, { maxBytes }) {
  let total = 0;
  const chunks = [];
  const d = new Decompress((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new LayerLimitError(maxBytes);
    // fzstd may reuse internal buffers between blocks — always copy.
    chunks.push(chunk.slice());
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
