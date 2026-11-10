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

// Maximum zstd window the in-browser (pure-JS) decoder accepts for frames
// with an EXPLICIT window descriptor. fzstd back-references reach at most 32
// MiB here by policy — a frame declaring a larger window needs "ultra"/
// --long compression settings and fails with WindowSizeError, never a
// generic decoder error. Single-segment frames are exempt (window == content
// size, bounded by the maxLayerBytes budget — see README).
export const ZSTD_MAX_WINDOW_BYTES = 32 * 1024 * 1024; // 32 MiB

export class WindowSizeError extends Error {
  constructor(windowBytes) {
    const mib = windowBytes / 1048576;
    super(
      `zstd layer declares a ${mib.toFixed(1)} MiB decode window (window descriptor), exceeding the 32 MiB window ` +
      `the in-browser decoder supports — refusing to decode. ` +
      `Re-encode this layer with a smaller window (e.g. zstd --long=25 or the default settings) or as gzip (streaming, no window limit), ` +
      `or analyze it with a native build. Frames with a window this large are produced by ultra/long-range compression modes.`,
    );
    this.name = 'WindowSizeError';
    this.code = 'WINDOW_TOO_BIG';
    this.windowBytes = windowBytes;
  }
}

/**
 * Window size of the FIRST zstd frame in `bytes`, following the frame header
 * spec (RFC 8878 §3.1.1.2):
 *   single_segment_flag = 1 -> window == frame content size
 *   otherwise             -> windowBase = 2^(10 + (wd >> 3)),
 *                           window = windowBase + (windowBase / 8) * (wd & 0x07)
 * Returns null when the bytes don't start a zstd frame or are truncated /
 * have no determinable window. Bytes beyond the frame header are not read.
 * (Callers wanting multi-frame enforcement must check each frame — see
 * analyze.js, which enforces on the first frame; later frames are bounded by
 * the byte budget and fzstd's own ~2 GB hard allocation cap.)
 */
export function zstdFrameWindowSize(bytes) {
  if (!bytes || bytes.length < 6) return null;
  if (bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) return null;
  const descriptor = bytes[4];
  const singleSegment = (descriptor >> 5) & 0x1;
  if (singleSegment) {
    // window == frame content size (spec §3.1.1.2.3.2)
    return zstdFrameContentSize(bytes);
  }
  const windowDescriptor = bytes[5];
  const windowBase = 2 ** (10 + (windowDescriptor >> 3));
  return windowBase + Math.floor(windowBase / 8) * (windowDescriptor & 0x07);
}

/** Enforce the 32 MiB window policy on a frame head (>= 6 bytes). */
export function enforceZstdWindowLimit(head) {
  const ws = zstdFrameWindowSize(head);
  if (ws !== null && ws > ZSTD_MAX_WINDOW_BYTES) throw new WindowSizeError(ws);
  return ws;
}

// Message for the refusal that fires BEFORE decoding, when the frame header
// carries a content size over the budget. Kept textually stable — CI and
// user docs reference it.
export const zstdLimitBeforeMessage = (maxBytes, declaredBytes) => (
  `zstd layer declares a decompressed size of ${(declaredBytes / 1048576).toFixed(1)} MiB (${declaredBytes} bytes), exceeding the ${(maxBytes / 1048576).toFixed(0)} MiB (${maxBytes} bytes) fallback limit — refusing to decode before allocating memory. ` +
  `Re-encode this layer as gzip (streaming, no fixed limit) or split it into smaller layers. ` +
  `analyzeImage() callers can tune the limit via the maxLayerBytes option.`
);

export class LayerLimitError extends Error {
  constructor(maxBytes, phase = 'decode', declaredBytes = null) {
    super(phase === 'before' && declaredBytes != null ? zstdLimitBeforeMessage(maxBytes, declaredBytes) : zstdLimitMessage(maxBytes));
    this.name = 'LayerLimitError';
    this.code = 'LAYER_LIMIT';
    this.maxBytes = maxBytes;
    this.phase = phase;
    if (declaredBytes != null) this.declaredBytes = declaredBytes;
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


/**
 * Push-based streaming decompressor: feed COMPRESSED chunks, collect DECODED
 * chunks via `onChunk`. Memory scales with chunk/window size — never with
 * the layer size. fzstd emits a fresh buffer per block (verified), and the
 * running byte total is enforced BEFORE the chunk reaches the sink, so a
 * frame with no content size can never allocate more than maxBytes (plus at
 * most one 128 KiB block).
 *
 * The 32 MiB window policy is NOT re-checked here — it must be enforced on
 * the frame head BEFORE the first push (see enforceZstdWindowLimit). fzstd
 * has no back-reference distance cap of its own.
 */
export function createZstdDecompressor({ maxBytes, onChunk }) {
  let total = 0;
  const d = new Decompress((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new LayerLimitError(maxBytes);
    onChunk(chunk);
  });
  return {
    totalBytesDecoded: () => total,
    push(chunk, final = false) {
      try {
        d.push(chunk, final);
      } catch (err) {
        if (err instanceof LayerLimitError) throw err;
        throw new Error(`Failed to decompress zstd layer with code: ${(err && err.message) || err}`);
      }
    },
  };
}

/**
 * Bridge a compressed-byte ReadableStream to a decompressed-byte
 * ReadableStream using fzstd's streaming decoder. Pure JS (runs on the UI
 * thread in node tooling; the browser fallback routes through
 * zstd.worker.js instead to keep the page responsive, but the worker runs
 * the same createZstdDecompressor core).
 */
export function decompressReadable(readable, { maxBytes }) {
  const reader = readable.getReader();
  let pending = [];
  let finished = false;
  const d = createZstdDecompressor({ maxBytes, onChunk: (chunk) => pending.push(chunk) });
  return new ReadableStream({
    async pull(controller) {
      if (finished) { controller.close(); return; }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          d.push(new Uint8Array(0), true);
          for (const chunk of pending) if (chunk.byteLength) controller.enqueue(chunk);
          pending = [];
          controller.close();
          return;
        }
        pending = [];
        d.push(value, false);
        if (pending.length > 0) {
          const out = pending;
          pending = [];
          for (const chunk of out) controller.enqueue(chunk);
          return;
        }
        // no output from this block (e.g. header-only push) — keep reading
      }
    },
    async cancel(reason) {
      finished = true;
      try { await reader.cancel(reason); } catch { /* best effort */ }
    },
  });
}
