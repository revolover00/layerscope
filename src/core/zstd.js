// zstd support.
//
// Strategy per environment:
//   browser:  one module Web Worker per analysis (src/core/zstd.worker.js)
//             around the pure-JS fzstd streaming decoder (see
//             src/core/zstd-decode.js) — never blocks the UI, and the
//             terminate() in analyzeImage()'s finally destroys it with the
//             analysis. Compressed bytes stream INTO the worker and decoded
//             blocks stream OUT — a layer is never held in memory on either
//             side (each block is an exact-size fresh copy; ~128 KiB).
//   node:     the same decoder inline (decompressReadable) — fzstd is
//             stateless across decodes, so a fresh "session" object holds no
//             memory worth releasing; the reference is simply dropped in
//             analyzeImage()'s finally.
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
//      (zstdFrameContentSize in analyze.js); a frame whose window descriptor
//      exceeds 32 MiB is refused with WINDOW_TOO_BIG before decoding
//      (zstdFrameWindowSize in analyze.js);
//   2. every decode — with or without a content size — streams through
//      createZstdDecompressor with maxBytes, which throws the moment the
//      running total crosses the cap (zstd blocks are ≤128 KiB, so a frame
//      without a content size can overshoot by at most one block).

import { zstdFrameContentSize } from './zstd-decode.js';

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * The decoder analyzeImage() should use for ONE analysis.
 *  - browser: a one-module Web Worker per analysis (see zstd.worker.js).
 *  - node:    a stateless inline adapter around decompressReadable.
 * Both return { decompressStream(readable, { maxBytes }) → Promise<ReadableStream<Uint8Array>>, terminate() }.
 */
export async function createZstd() {
  if (isBrowser()) {
    const worker = new Worker(new URL('./zstd.worker.js', import.meta.url), { type: 'module' });
    let seq = 0;
    // one in-flight stream session at a time per worker (analyzeImage decodes layers sequentially)
    const sessions = new Map();
    // cap on compressed bytes posted to the worker but not yet consumed —
    // keeps a fast blob reader from queueing a whole layer of postMessages
    const MAX_INFLIGHT_BYTES = 32 * 1024 * 1024; // 32 MiB (8 x 4 MiB chunks)
    worker.onerror = (e) => {
      for (const s of sessions.values()) s.fail(new Error(`zstd worker failed: ${e.message || 'unknown error'}`));
      sessions.clear();
    };
    worker.onmessage = (e) => {
      const { id, type, bytes, byteOffset, byteLength, error, code } = e.data || {};
      const s = sessions.get(id);
      if (!s) return;
      if (type === 'data') {
        s.pushChunk(new Uint8Array(bytes, byteOffset || 0, byteLength ?? bytes.byteLength));
      } else if (type === 'ack') {
        s.ack(byteLength ?? 0);
      } else if (type === 'done') {
        sessions.delete(id);
        s.finish();
      } else if (type === 'error') {
        sessions.delete(id);
        const err = new Error(error);
        if (code) err.code = code;
        s.fail(err);
      }
    };
    return {
      /**
       * Decompress `readable` (compressed bytes) through the worker, as a
       * stream of decoded blocks. Never buffers the whole layer on either
       * side of the boundary: each side holds at most a few 128 KiB blocks
       * plus fzstd's window buffer.
       */
      decompressStream: (readable, { maxBytes } = {}) => {
        const id = ++seq;
        const reader = readable.getReader();
        let controller = null;
        let pumping = false;
        const session = {
          inflight: 0,
          waiters: [],
          closed: false,
          pushChunk(chunk) {
            if (!controller) return;
            controller.enqueue(chunk);
          },
          ack(bytes) {
            this.inflight = Math.max(0, this.inflight - bytes);
            if (this.inflight < MAX_INFLIGHT_BYTES) {
              const w = this.waiters.shift();
              if (w) w();
            }
          },
          async waitForCredit(bytes) {
            while (this.inflight + bytes > MAX_INFLIGHT_BYTES) {
              if (this.closed) throw new Error('zstd worker session closed before the layer was fully fed');
              await new Promise((resolve) => this.waiters.push(resolve));
              if (this.closed) throw new Error('zstd worker session closed before the layer was fully fed');
            }
          },
          close() {
            this.closed = true;
            for (const w of this.waiters.splice(0)) w();
          },
          finish() {
            this.close();
            if (controller) controller.close();
            controller = null;
          },
          fail(err) {
            this.close();
            if (controller) controller.error(err);
            controller = null;
            reader.cancel(err).catch(() => {});
          },
        };
        sessions.set(id, session);
        const pump = async () => {
          if (pumping) return;
          pumping = true;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                worker.postMessage({ type: 'feed', id, chunk: new ArrayBuffer(0), final: true });
                break;
              }
              if (value && value.byteLength) {
                await session.waitForCredit(value.byteLength);
                const copy = value.slice(); // exact-size copy: transferred zero-copy, no offsets to track
                session.inflight += copy.byteLength;
                worker.postMessage({ type: 'feed', id, chunk: copy.buffer, final: false }, [copy.buffer]);
              }
            }
          } catch (err) {
            sessions.delete(id);
            session.fail(err);
          } finally {
            pumping = false;
          }
        };
        return new ReadableStream({
          async start(c) {
            controller = c;
            worker.postMessage({ type: 'start', id, maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER });
            await pump();
          },
          async cancel(reason) {
            sessions.delete(id);
            session.close();
            try { await reader.cancel(reason); } catch { /* best effort */ }
            worker.postMessage({ type: 'cancel', id });
            controller = null;
          },
        });
      },
      terminate: () => worker.terminate(),
    };
  }
  const { decompressReadable } = await import('./zstd-decode.js');
  return {
    decompressStream: (readable, { maxBytes } = {}) =>
      Promise.resolve(decompressReadable(readable, { maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER })),
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
 * One-shot convenience wrapper for tooling and tests (NOT used by the layer
 * pipeline — analyze.js streams). Routes through the same
 * createZstdDecompressor core, bounded by opts.maxBytes mid-flight.
 */
export { zstdFrameContentSize } from './zstd-decode.js';

export async function decompressZstd(bytes, { module: modOverride = null, maxBytes = null } = {}) {
  const max = maxBytes ?? Number.MAX_SAFE_INTEGER;
  // inline assembly through the shared streaming core — one-shot callers only;
  // analyze.js never buffers a layer (it streams through decompressStream)
  const { decompressReadable } = await import('./zstd-decode.js');
  const src = new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); },
  });
  const reader = decompressReadable(src, { maxBytes: max }).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
