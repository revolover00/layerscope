// Shared WASM zstd support.
//
// Strategy per environment (per-analysis isolation — see README "Decoder
// integrity"):
//   browser:  a one-module Web Worker per analysis (src/core/zstd.worker.js);
//             own global scope ⇒ a fresh, pristine WASM instance; the analysis
//             terminates the worker in analyzeImage()'s finally, which
//             deterministically destroys the linear memory (it never shrinks
//             in place).
//   node:     require() the "@bokuweb/zstd-wasm" CJS build (devDependency,
//             installed by `npm ci` for the tools) fresh per analysis — the
//             whole package require-cache subtree is busted, and evicted
//             again after the require so the instance is collectable.
//
// Two instance flavors:
//   createZstd() — a fresh decoder per analysis (see above).
//   loadZstd()   — a cached process-wide instance for tools/verifiers that
//                  decompress many times on purpose.
//
// A note on one-shot decoding: the vendored decoder is one-shot (no streaming
// API), so the fallback can never decode "chunk by chunk". Bounds are enforced
// before/at allocation instead:
//   1. if the zstd frame header carries a content size (it almost always does
//      for CLI-produced layers), a layer over the limit is refused BEFORE any
//      buffer or WASM allocation happens;
//   2. otherwise the decode is retried with the hard cap — the attempt cannot
//      allocate more than maxBytes no matter how big the real output is.

let zstdModulePromise = null;

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

async function importFresh() {
  const { createRequire } = await import('node:module');
  const { sep } = await import('node:path');
  const require = createRequire(import.meta.url);
  // bust the WHOLE package subtree — the entry alone re-exports the same
  // cached internals, which would leave every "fresh" instance sharing one
  // wasm heap (observed: after a few analyses layer-2 decompression failed
  // with zstd code -72)
  const marker = `@bokuweb${sep}zstd-wasm${sep}`;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(marker)) delete require.cache[key];
  }
  const mod = require('@bokuweb/zstd-wasm');
  // and evict it again: an important side effect of keeping a fresh instance
  // OUT of the require cache is that once the analysis drops its reference,
  // the engine can actually reclaim the WASM heap (until GC, it stays live)
  for (const key of Object.keys(require.cache)) {
    if (key.includes(marker)) delete require.cache[key];
  }
  await mod.init();
  return mod;
}

/**
 * The decoder analyzeImage() should use, FRESH per analysis.
 *  - node:    a FRESH CJS instance (the whole require subtree is busted and
 *             evicted). analyzeImage()'s `finally` drops the reference; node
 *             reclaims the WASM heap at GC. Measured: arrayBuffers after GC
 *             returns to the archive size (+0.01 MiB retained, 150 MiB layer).
 *  - browser: a one-module Web Worker per analysis, terminated in
 *             analyzeImage()'s `finally` — the WASM linear memory is destroyed
 *             with the worker (never shrinks in place), so no page reload is
 *             needed to release it. Warm does NOT get a decoder cache for
 *             this reason: cross-analysis reuse demonstrably produced
 *             different bytes for the same frame in Chromium.
 * A fresh page-wide instance per analysis also means: zero degradation on any
 * number of analyses in one tab (browser soak: 50/50 identical fingerprints).
 */
export async function createZstd() {
  if (isBrowser()) {
    // One module worker per analysis — see src/core/zstd.worker.js. The
    // worker owns a FRESH WASM instance and is terminated after the analysis,
    // deterministically releasing the linear memory (it never shrinks in
    // place). A shared page-wide instance is NOT safe here: Chromium produced
    // different bytes decoding the same frame on its second use.
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
      decompress: (u8, { defaultHeapSize } = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        // zero-copy hand-off of the layer bytes into the worker
        worker.postMessage({ id, buffer: u8.buffer, offset: u8.byteOffset, length: u8.byteLength, defaultHeapSize }, [u8.buffer]);
      }),
      terminate: () => worker.terminate(),
    };
  }
  try {
    return await importFresh();
  } catch (err) {
    throw new Error(`zstd decoder failed to load: ${err.message || err}`);
  }
}

export function loadZstd() {
  if (!zstdModulePromise) {
    zstdModulePromise = importFresh().catch((err) => {
      zstdModulePromise = null; // allow a later retry; report the real reason
      throw new Error(`zstd decoder failed to load: ${err.message || err}`);
    });
  }
  return zstdModulePromise;
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
 * carries no FCS field (or cannot be parsed).
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
 * One-shot decompress used only when no native streaming decoder exists.
 * opts:
 *   module         — a specific instance (e.g. one created by createZstd())
 *   defaultHeapSize— decode capacity to try first for frames WITHOUT FCS
 *   maxBytes       — hard cap; unknown-FCS frames are retried at this bound so
 *                    the decoder can never allocate more than this
 */
export async function decompressZstd(bytes, { module: modOverride = null, defaultHeapSize = 16 * 1024 * 1024, maxBytes = null } = {}) {
  const mod = modOverride ?? await loadZstd();
  try {
    return await mod.decompress(bytes, { defaultHeapSize });
  } catch (err) {
    if (maxBytes != null && defaultHeapSize < maxBytes) {
      // FCS was absent and the real output did not fit the first attempt.
      // Retry at the cap: memory stays bounded by maxBytes no matter what.
      return await mod.decompress(bytes, { defaultHeapSize: maxBytes });
    }
    throw err;
  }
}
