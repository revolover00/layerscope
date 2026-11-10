// ESM module worker — the browser's zstd fallback decoder runtime.
//
// One worker per analysis. It decodes every zstd-fallback layer of ONE
// analysis with the pure-JS fzstd streaming decoder (src/core/zstd-decode.js)
// and is terminated when the analysis ends (analyzeImage's finally). fzstd
// carries no shared linear memory — every decode builds a fresh internal
// state object — so cross-analysis decoder degradation is structurally
// impossible. The worker isolates the decode from the page: blocking
// multi-hundred-MB decodes never freeze the UI, and a decoder bug cannot
// corrupt the app's own heap.
//
// Streaming protocol (id-scoped, one analysis at a time per worker):
//   page -> worker  { type: 'start',  id, maxBytes }
//   page -> worker  { type: 'feed',   id, chunk: ArrayBuffer, final: boolean }
//                   (each chunk is an exact-size copy; ownership is transferred)
//   page -> worker  { type: 'cancel', id }  — abandon the session mid-stream
//   worker -> page  { type: 'data',   id, bytes: ArrayBuffer, byteOffset: 0, byteLength }
//                   (always an exact-size fresh copy — never a view into fzstd's
//                    window, so no 12-byte sentinel can leak into the layer)
//   worker -> page  { type: 'done',   id }
//   worker -> page  { type: 'error',  id, error: string, code: string|undefined }

import { createZstdDecompressor } from './zstd-decode.js';

const sessions = new Map(); // id -> { feed(chunk, final), cancel() }

self.onmessage = (e) => {
  const msg = e.data || {};
  const { type, id } = msg;
  try {
    if (type === 'start') {
      if (sessions.has(id)) throw new Error(`zstd worker: duplicate session id ${id}`);
      let decoder = null;
      sessions.set(id, {
        feed(chunk, final) {
          if (!decoder) {
            decoder = createZstdDecompressor({
              maxBytes: msg.maxBytes ?? Number.MAX_SAFE_INTEGER,
              onChunk: (blk) => {
                // exact-size fresh copy, transferred — no views, no sentinel bytes
                const copy = blk.slice();
                self.postMessage({ type: 'data', id, bytes: copy.buffer, byteOffset: 0, byteLength: copy.byteLength }, [copy.buffer]);
              },
            });
          }
          decoder.push(new Uint8Array(chunk), !!final);
          if (final) {
            sessions.delete(id);
            self.postMessage({ type: 'done', id });
          }
        },
        cancel() {
          sessions.delete(id);
        },
        // (no ack needed for 'start'/'cancel'; feeds ack inline above)
      });
      return;
    }
    const session = sessions.get(id);
    if (type === 'feed') {
      if (!session) return; // late chunk after error — drop silently
      session.feed(msg.chunk, msg.final);
      // ack consumption so the page can bound its in-flight compressed bytes
      self.postMessage({ type: 'ack', id, ackBytes: msg.chunk ? msg.chunk.byteLength || 0 : 0 });
      return;
    }
    if (type === 'cancel') {
      if (session) session.cancel();
      return;
    }
  } catch (err) {
    sessions.delete(id);
    self.postMessage({ type: 'error', id, error: String((err && err.message) || err), code: err && err.code });
  }
};
