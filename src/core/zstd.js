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

import { zstdFrameContentSize } from './zstd-decode.js';

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
      const { id, ok, bytes, byteOffset, byteLength, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(new Uint8Array(bytes, byteOffset || 0, byteLength ?? bytes.byteLength));
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
 * Streaming-capped decompress used only when no native streaming decoder
 * exists. Always routes through decodeZstdCapped (browser: the per-analysis
 * worker; node: inline), so EVERY frame — with or without a content size —
 * is bounded by opts.maxBytes mid-flight.
 */
export { zstdFrameContentSize } from './zstd-decode.js';

export async function decompressZstd(bytes, { module: modOverride = null, maxBytes = null } = {}) {
  const mod = modOverride ?? (await createZstd());
  return mod.decompress(bytes, { maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER });
}
