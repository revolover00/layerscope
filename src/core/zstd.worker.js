// ESM module worker — the browser's zstd fallback decoder runtime.
//
// One worker per analysis. It decodes every zstd-fallback layer of ONE
// analysis with the pure-JS fzstd streaming decoder (src/core/zstd-decode.js)
// and is terminated when the analysis ends (analyzeImage's finally). fzstd
// carries no shared linear memory — every decode builds a fresh internal
// state object — so cross-analysis decoder degradation is structurally
// impossible. The worker still isolates the decode from the page: blocking
// multi-hundred-MB decodes never freeze the UI, and a decoder bug cannot
// corrupt the app's own heap.

import { decodeZstdCapped } from './zstd-decode.js';

self.onmessage = (e) => {
  const { id, buffer, offset, length, maxBytes } = e.data || {};
  try {
    const frame = new Uint8Array(buffer, offset || 0, length ?? buffer.byteLength);
    const out = decodeZstdCapped(frame, { maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER });
    // NOTE: the one-shot decode tier may return a VIEW onto a larger internal
    // buffer (fzstd subarrays its window at offset 12). Transfer the whole
    // buffer but carry the view's placement — flattening with `out.buffer`
    // alone prepends fzstd's 12 sentinel bytes to the layer (corrupting the
    // tar at offset 0) and the caller would see trailing garbage too.
    self.postMessage(
      { id, ok: true, bytes: out.buffer, byteOffset: out.byteOffset, byteLength: out.byteLength },
      [out.buffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err), code: err && err.code });
  }
};
