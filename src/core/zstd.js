// zstd support.
//
// Strategy per environment:
//   browser:  one module Web Worker per analysis (src/core/zstd.worker.js)
//             around the pure-JS fzstd streaming decoder (see
//             src/core/zstd-decode.js) — never blocks the UI, and the
//             terminate() in analyzeImage()'s finally destroys it with the
//             analysis.
//   node:     the same decoder inline — fzstd is stateless across decodes,
//             so a fresh "session" object holds no memory worth releasing;
//             the reference is simply dropped in analyzeImage()'s finally.
//
// Decoder history (see README "Decoder integrity"): the vendored WASM
// decoder was REMOVED because in real Chromium the SAME frame decoded to
// DIFFERENT bytes on its second use in a shared page-wide instance — caught
// by the rootfs.diff_ids integrity check. fzstd is pure JavaScript with no
// linear memory, so this failure class cannot occur.
//
// Enforcing the limit (both paths):
//   1. if the zstd frame header carries a content size (it does for CLI-
//      produced layers), a layer over the limit is refused BEFORE decoding
//      (zstdFrameContentSize in analyze.js);
//   2. every decode — with or without a content size — streams through
//      decodeZstdCapped with maxBytes, which throws the moment the running
//      total crosses the cap (zstd blocks are ≤128 KiB, so a frame without
//      a content size can overshoot by at most one block).

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * The decoder analyzeImage() should use for ONE analysis.
 *  - browser: a one-module Web Worker per analysis (see zstd.worker.js).
 *  - node:    a stateless inline adapter around decodeZstdCapped.
 * Both return { decompress(u8, { maxBytes }) → Promise<Uint8Array>, terminate() }.
 */
export async function createZstd() {
  if (isBrowser()) {
    const worker = new Worker(new URL('./zstd.worker.js', import.meta.url), { type: 'module' });
    let seq = 0;
    const pending = new Map();
    const failAll = (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    worker.onmessage = (e) => {
      const { id, ok, bytes, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(new Uint8Array(bytes));
      else p.reject(new Error(error));
    };
    worker.onerror = (e) => failAll(new Error(`zstd worker failed: ${e.message || 'unknown error'}`));
    return {
      decompress: (u8, { maxBytes } = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        // zero-copy hand-off of the layer bytes into the worker
        worker.postMessage({ id, buffer: u8.buffer, offset: u8.byteOffset, length: u8.byteLength, maxBytes }, [u8.buffer]);
      }),
      terminate: () => worker.terminate(),
    };
  }
  const { decodeZstdCapped } = await import('./zstd-decode.js');
  return {
    decompress: async (u8, { maxBytes } = {}) => decodeZstdCapped(u8, { maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER }),
    terminate: () => {},
  };
}

/** True if a native streaming zstd decoder exists in this environment. */
export function nativeZstdStream() {
  try {
    // constructing throws where the format is unsupported
    new DecompressionStream('zstd');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the frame content size from a zstd frame header, if present.
 * Returns the declared decompressed byte size, or null when the frame
 * carries no FCS field (e.g. streamed compression, containerd/buildx).
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
 * Streaming-capped decompress used only when no native streaming decoder
 * exists. Always routes through decodeZstdCapped (browser: the per-analysis
 * worker; node: inline), so EVERY frame — with or without a content size —
 * is bounded by opts.maxBytes mid-flight.
 */
export async function decompressZstd(bytes, { module: modOverride = null, maxBytes = null } = {}) {
  const mod = modOverride ?? (await createZstd());
  return mod.decompress(bytes, { maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER });
}
