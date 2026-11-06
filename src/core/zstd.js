// Shared lazy loader for the vendored zstd decoder (assets/vendor/zstd).
// Strategy per environment:
//   browser:  dynamic-import the vendored ESM web build; it fetches zstd.wasm
//             relative to its own URL — works on any static host (Pages).
//   node:     require() the "@bokuweb/zstd-wasm" CJS build (devDependency,
//             installed by `npm ci` for the tools).
// In both cases the wasm is loaded lazily on first zstd layer and once.

let zstdModulePromise = null;

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function loadZstd() {
  if (!zstdModulePromise) {
    zstdModulePromise = (async () => {
      if (isBrowser()) {
        const mod = await import('../../assets/vendor/zstd/index.web.js');
        await mod.init(); // resolves assets/vendor/zstd/zstd.wasm next to the module
        return mod;
      }
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const mod = require('@bokuweb/zstd-wasm');
      await mod.init();
      return mod;
    })().catch((err) => {
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

/** One-shot decompress used only when no native streaming decoder exists. */
export async function decompressZstd(bytes) {
  const mod = await loadZstd();
  return mod.decompress(bytes);
}
