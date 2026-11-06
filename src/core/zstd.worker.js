// ESM module worker — one fresh copy of the vendored zstd decoder for ONE
// analysis. Each page analysis spawns a worker (own global scope ⇒ own fresh
// WASM instance), decodes the layers, and the analysis terminates the worker
// afterwards, deterministically destroying the WASM linear memory — which can
// never shrink in place. Measured necessity: the shared module produced a
// DIFFERENT decompression of the same frame on its second analysis in
// Chromium (caught by the diff_ids integrity check).

import { init, decompress } from '../../assets/vendor/zstd/index.web.js';

const ready = init(); // fetches + compiles + instantiates once per worker

self.onmessage = async (e) => {
  const { id, buffer, offset, length, defaultHeapSize } = e.data || {};
  try {
    await ready;
    const bytes = new Uint8Array(buffer, offset || 0, length ?? buffer.byteLength);
    const out = decompress(bytes, { defaultHeapSize });
    // out is already an independent copy of the decoder's output
    self.postMessage({ id, ok: true, bytes: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
