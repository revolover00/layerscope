// Image archive orchestration and the dive-compatible analysis model.
//
// What this computes (and why):
//  - per layer: tar-header byte size (the same number dive reports as layer
//    "sizeBytes"), the creating command from config history, and the file
//    diff (added / modified / deleted) relative to the previous layers.
//  - image-level: total size, wasted bytes and efficiency score using the
//    same definition as dive (min-occurrence / cumulative-occurrence per
//    path, whiteouts sizing the directory they remove from the squashed
//    tree below, opaque markers ignored).
//
// File *contents* are never read; layer blobs are streamed and discarded.

import { iterTarEntries, readBlobSlice, blobReadableStream } from './tar.js';
import { nativeZstdStream, decompressZstd, createZstd, zstdFrameContentSize } from './zstd.js';
import {
  FileTree,
  treeAddEntry,
  applyTreeOnto,
  isWhiteout,
  isOpaqueMarker,
  unWhiteoutPath,
  parentPath,
  baseName,
} from './model.js';

// Keeps the biggest K items seen so far, bounded memory for huge images.
class TopK {
  constructor(k, cmp) { this.k = k; this.cmp = cmp; this.items = []; }
  add(item) {
    this.items.push(item);
    if (this.items.length > 4 * this.k) this.trim();
  }
  trim() {
    this.items.sort(this.cmp);
    if (this.items.length > this.k) this.items.length = this.k;
  }
  result() { this.trim(); return this.items; }
}

const SMALL_FILE_MAX = 4 * 1024 * 1024; // collect tiny metadata files in pass 1
// Hard upper bound for a single decompressed zstd layer on the fallback
// decode path (browsers without native DecompressionStream('zstd')). The
// fallback materializes the layer in memory (iterTarEntries needs the
// bytes), so an unbounded layer is an allocation-crash / tab-OOM risk.
// gzip layers are unaffected — they stream end-to-end. analyzeImage() callers
// may tune this with the `maxLayerBytes` option. Enforcement:
//   1. frames WITH a content size are refused BEFORE decoding;
//   2. every decode — with or without a content size — streams through a
//      byte-capped decoder that throws mid-flight past maxLayerBytes.
// Tested up to the limit on
// node (159 MiB content layer passes, rss ~1021 MB peak; a 160 MiB-content
// layer whose tar lands 2 KB over the limit is refused BEFORE allocating) and
// in real Chromium (150 MiB incompressible single layer, see browser-bench).
// Refusal produces a clear error, never a silent crash.
const DEFAULT_MAX_LAYER_BYTES = 160 * 1024 * 1024; // 160 MiB
const COLLECT_PATHS = new Set(['manifest.json', 'index.json', 'oci-layout', 'repositories']);
const ROOT_CONFIG_RE = /^[0-9a-f]{64}\.json$/;

async function sniffCompression(blob, offset) {
  const head = new Uint8Array(await blob.slice(offset, offset + 4).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return 'none';
}

async function sha256Hex(bytes) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function layerStream(blob, offset, size, compression, maxLayerBytes, zstdSessionHolder, layerHashes, layerIndex) {
  if (compression === 'none') {
    return blobReadableStream(blob, offset, offset + size);
  }
  if (compression === 'gzip') {
    return blobReadableStream(blob, offset, offset + size).pipeThrough(new DecompressionStream('gzip'));
  }
  // zstd: prefer the browser's native streaming decoder; otherwise fall back to
  // the pure-JS fzstd streaming decoder (bytes bounded mid-decode by maxLayerBytes;
  // gzip stays fully streaming).
  if (nativeZstdStream()) {
    return blobReadableStream(blob, offset, offset + size).pipeThrough(new DecompressionStream('zstd'));
  }
  const raw = new Uint8Array(await readBlobSlice(blob, offset, offset + size));
  // Enforce the limit BEFORE allocating: if the zstd frame header carries a
  // content size, refuse upfront without decoding. Otherwise (or in addition)
  // the decode streams through a byte-capped decoder that throws mid-flight
  // past maxLayerBytes — see src/core/zstd-decode.js.
  const declared = zstdFrameContentSize(raw);
  if (declared != null && declared > maxLayerBytes) {
    throw new Error(
      `zstd layer declares a decompressed size of ${(declared / 1048576).toFixed(1)} MiB (${declared} bytes), exceeding the ${(maxLayerBytes / 1048576).toFixed(0)} MiB (${maxLayerBytes} bytes) fallback limit — refusing to decode before allocating memory. ` +
      `The in-browser decoder must hold one layer in memory. Re-encode this layer as gzip (streaming, no fixed limit) or split it into smaller layers. ` +
      `analyzeImage() callers can tune the limit via the maxLayerBytes option.`,
    );
  }
  // one decoder session per analysis; released in analyzeImage's finally
  if (!zstdSessionHolder.session) zstdSessionHolder.session = await createZstd();
  const out = await decompressZstd(raw, { module: zstdSessionHolder.session, maxBytes: maxLayerBytes });
  if (out.byteLength > maxLayerBytes) {
    throw new Error(
      `zstd layer decompressed to ${(out.byteLength / 1048576).toFixed(1)} MiB (${out.byteLength} bytes), exceeding the ${(maxLayerBytes / 1048576).toFixed(0)} MiB (${maxLayerBytes} bytes) fallback limit. ` +
      `The in-browser decoder must hold one layer in memory. Re-encode this layer as gzip (streaming, no fixed limit) or split it into smaller layers. ` +
      `analyzeImage() callers can tune the limit via the maxLayerBytes option.`,
    );
  }
  // integrity: hash of the decompressed layer is checked against the config's
  // rootfs.diff_ids after the layer loop (only possible here — out is in memory)
  if (layerHashes) layerHashes[layerIndex] = await sha256Hex(out);
  return new ReadableStream({
    start(controller) { controller.enqueue(out); controller.close(); },
  });
}

/** Human label for a manifest: accepts an index descriptor ({platform:{...}}) or a flat {os, architecture, variant} entry. */
export function formatPlatform(m) {
  const p = (m && (m.platform || m)) || null;
  if (!p || !p.os || !p.architecture) return null;
  return `${p.os}/${p.architecture}${p.variant ? `/${p.variant}` : ''}`;
}

/** Strip the conventional docker exec wrapper dive strips. */
export function trimCommand(createdBy) {
  if (!createdBy) return '(missing)';
  return createdBy.startsWith('/bin/sh -c ') ? createdBy.slice('/bin/sh -c '.length) : createdBy;
}

function alignHistory(history, layerCount) {
  const commands = new Array(layerCount).fill('(missing)');
  if (!Array.isArray(history)) return commands;
  let li = 0;
  for (const entry of history) {
    if (entry && entry.empty_layer) continue;
    if (li >= layerCount) break;
    commands[li] = trimCommand(entry && entry.created_by);
    li++;
  }
  return commands;
}

export async function analyzeImage(blob, { onProgress = () => {}, topLimit = 20, platform = null, maxLayerBytes = DEFAULT_MAX_LAYER_BYTES } = {}) {
  const sessionHolder = { session: null }; // per-analysis decoder session — dropped in `finally`
  try {
  const warnings = [];
  const progress = (phase, detail) => onProgress({ phase, ...(detail || {}) });

  // ---------------- pass 0: reject gzip/zstd-wrapped outer archives with a targeted message ----------------
  // `docker save` emits an uncompressed .tar. Wrapping it in .tar.gz / .tar.zst makes the
  // random-access reads impossible, so fail fast and say exactly what is wrong instead of
  // the generic 'no manifest' error, which reads like the archive is corrupt.
  if (blob.size >= 4) {
    const head = new Uint8Array(await readBlobSlice(blob, 0, 4));
    if (head[0] === 0x1f && head[1] === 0x8b) {
      throw new Error('This archive is gzip-compressed (.tar.gz). Unpack it first (gzip -d), or re-run `docker save` without piping through gzip — docker save already emits an uncompressed .tar.');
    }
    if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) {
      throw new Error('This archive is zstd-compressed (.tar.zst). Unpack it first (zstd -d), or re-run `docker save` without outer compression.');
    }
  }

  // ---------------- pass 1: index the outer tar ----------------
  progress('scan', { detail: 'reading archive index' });
  const index = new Map(); // path -> { dataOffset, size }
  const collected = new Map(); // path -> Uint8Array (small metadata only)
  const scanStream = blobReadableStream(blob, 0, blob.size);
  try {
    for await (const { header, data, dataOffset } of iterTarEntries(scanStream, {
      collectData: (h) =>
        h.size <= SMALL_FILE_MAX && (COLLECT_PATHS.has(h.path.slice(1)) || ROOT_CONFIG_RE.test(h.path.slice(1))),
    })) {
      const rel = header.path.slice(1); // store relative keys
      index.set(rel, { dataOffset, size: header.size });
      if (data) collected.set(rel, data);
    }
  } catch (err) {
    throw new Error(`Failed to read the tar archive: ${err.message}`);
  }

  const readJson = (rel) => {
    const buf = collected.get(rel);
    if (!buf) throw new Error(`missing ${rel} in archive`);
    return JSON.parse(new TextDecoder().decode(buf));
  };

  const readJsonAt = async (rel) => {
    if (collected.has(rel)) return readJson(rel);
    const meta = index.get(rel);
    if (!meta) throw new Error(`missing ${rel} in archive`);
    const buf = await readBlobSlice(blob, meta.dataOffset, meta.dataOffset + meta.size);
    return JSON.parse(new TextDecoder().decode(buf));
  };

  // ---------------- resolve image config ----------------
  let format;
  let imageName = null;
  let layerPaths = [];
  let layerCompressionHints = [];
  let diffIds = [];
  let history = null;
  let configRaw = null;
  let platformsMeta = null;   // multi-manifest OCI: all descriptors (null otherwise)
  let selectedPlatform = null;

  if (index.has('manifest.json')) {
    const manifest = readJson('manifest.json');
    if (!Array.isArray(manifest) || manifest.length === 0) {
      throw new Error('manifest.json in archive is empty or invalid');
    }
    if (manifest.length > 1) warnings.push(`manifest.json lists ${manifest.length} images; analyzing the first one`);
    const item = manifest[0];
    format = index.has('index.json') ? 'docker-save (oci+legacy dual)' : 'docker-save (legacy)';
    imageName = (item.RepoTags && item.RepoTags[0]) || null;
    layerPaths = item.Layers || [];
    layerCompressionHints = layerPaths.map(() => 'auto'); // docker legacy layers are uncompressed; sniff anyway
    configRaw = await readJsonAt(item.Config);
  } else if (index.has('index.json')) {
    format = 'oci-archive';
    const idx = readJson('index.json');
    const manifests = idx.manifests || [];
    if (manifests.length === 0) throw new Error('index.json lists no manifests');
    const platOf = (m) => m.platform || null;
    const platforms = manifests.map((m) => {
      const p = platOf(m) || {};
      return { os: p.os || 'unknown', architecture: p.architecture || 'unknown', variant: p.variant || null, digest: m.digest, size: m.size || 0 };
    });
    const defaultIndex = (() => {
      const linuxAmd64 = manifests.findIndex((m) => (platOf(m) || {}).os === 'linux' && (platOf(m) || {}).architecture === 'amd64');
      return linuxAmd64 >= 0 ? linuxAmd64 : 0;
    })();
    let chosenIndex = defaultIndex;
    if (platform) {
      const [wantOs, wantArch, wantVariant] = String(platform).split('/');
      const found = manifests.findIndex((m) => {
        const p = platOf(m) || {};
        if (p.os !== wantOs || p.architecture !== wantArch) return false;
        if (wantVariant && p.variant) return p.variant === wantVariant;
        return true;
      });
      if (found >= 0) chosenIndex = found;
      else warnings.push(`requested platform ${platform} not present in index; analyzed ${formatPlatform(manifests[chosenIndex]) || 'the default manifest'} instead`);
    }
    const chosen = manifests[chosenIndex];
    const chosenPlatform = formatPlatform(chosen);
    platformsMeta = platforms.map((p, i) => ({ ...p, selected: i === chosenIndex }));
    selectedPlatform = chosenPlatform || null;
    if (manifests.length > 1) {
      const list = platforms.map((p, i) => `${p.os}/${p.architecture}${p.variant ? `/${p.variant}` : ''}${i === chosenIndex ? ' ✓' : ''}`).join(', ');
      warnings.push(`index.json lists ${manifests.length} manifests across platforms (${list}); analyzed ${chosenPlatform || 'manifest #' + chosenIndex}`);
    }
    imageName = chosen.annotations && (chosen.annotations['io.containerd.image.name'] || chosen.annotations['org.opencontainers.image.ref.name'] || null);
    const manifestRel = chosen.digest.replace(/^sha256:/, 'blobs/sha256/');
    const manifest = await readJsonAt(manifestRel);
    const configRel = manifest.config.digest.replace(/^sha256:/, 'blobs/sha256/');
    configRaw = await readJsonAt(configRel);
    layerPaths = (manifest.layers || []).map((l) => l.digest.replace(/^sha256:/, 'blobs/sha256/'));
    layerCompressionHints = (manifest.layers || []).map((l) => {
      const mt = l.mediaType || '';
      if (mt.includes('zstd')) return 'zstd';
      if (mt.includes('gzip')) return 'gzip';
      if (mt.includes('tar+gzip')) return 'gzip';
      if (mt.endsWith('missing')) return 'none';
      if (mt.includes('tar')) return 'none';
      return 'auto';
    });
  } else {
    throw new Error('Not a recognizable image archive: no manifest.json (docker save) and no index.json (OCI layout) found');
  }

  history = configRaw.history || null;
  diffIds = (configRaw.rootfs && Array.isArray(configRaw.rootfs.diff_ids)) ? configRaw.rootfs.diff_ids : [];
  if (!history) warnings.push('image config has no history; layer commands will show as (missing)');
  if (diffIds.length && diffIds.length !== layerPaths.length) {
    warnings.push(`config lists ${diffIds.length} diff_ids but ${layerPaths.length} layers; digests may be missing`);
  }

  const commands = alignHistory(history, layerPaths.length);
  const layerCount = layerPaths.length;
  const layerHashes = new Array(layerCount).fill(null); // zstd-fallback path only: sha256 of the decompressed layer

  // ---------------- pass 2: analyze each layer in order ----------------
  const squashed = new FileTree();
  const layers = [];
  const pathStats = new Map(); // path -> { count, cumulative, min }
  let pathOrder = [];
  let totalSizeBytes = 0;
  // top-N trackers: keep only the biggest K entries (bounded memory)
  const allLargestEntries = new TopK(topLimit, (a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
  const finalEntries = new TopK(topLimit, (a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));


  const recordOccurrence = (path, size, deleted = false) => {
    let s = pathStats.get(path);
    if (!s) {
      s = { count: 0, cumulative: 0, min: Infinity, last: null };
      pathStats.set(path, s);
      pathOrder.push(path);
    }
    s.count += 1;
    s.cumulative += size;
    if (size < s.min) s.min = size;
    s.last = { size, deleted };
  };

  for (let i = 0; i < layerCount; i++) {
    const rel = layerPaths[i];
    const meta = index.get(rel);
    if (!meta) throw new Error(`layer blob missing from archive: ${rel}`);

    let compression = layerCompressionHints[i];
    if (compression === 'auto') compression = await sniffCompression(blob, meta.dataOffset);

    progress('layer', { index: i, total: layerCount, detail: `decompressing layer ${i + 1}/${layerCount}` });

    // --- stream the layer tar, collecting header metadata only ---
    const entries = [];
    let entryBytes = 0;
    let sawAny = false;
    try {
      for await (const { header } of iterTarEntries(await layerStream(blob, meta.dataOffset, meta.size, compression, maxLayerBytes, sessionHolder, layerHashes, i), {
        collectData: () => false,
      })) {
        sawAny = true;
        entries.push(header);
        entryBytes += header.size;
      }
    } catch (err) {
      throw new Error(`Failed to unpack layer ${i + 1}/${layerCount} (${rel}): ${err.message}`);
    }
    if (!sawAny) warnings.push(`layer ${i} is empty`);

    // --- layer tree (for leaf detection + file list) ---
    const layerTree = new FileTree();
    for (const e of entries) treeAddEntry(layerTree, e);
    const sortedEntries = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // dive-compatible file list: walk leaves AND non-leaves, skipping opaque markers,
    // implicit dirs have no header and are skipped
    const fileList = [];
    for (const { node } of layerTree.walk((n) => isOpaqueMarker(n.path))) {
      if (!node.explicit) continue;
      const h = node.header;
      fileList.push({
        path: node.path.replace(/^\//, ''),
        typeFlag: h ? h.typeflag.charCodeAt(0) || 0 : 0,
        linkName: node.linkname || '',
        size: node.size,
        uid: h ? h.uid : 0,
        gid: h ? h.gid : 0,
        fileMode: h ? h.mode : 0,
        isDir: node.isDir,
      });
    }

    // --- diff vs squashed lower image (UI lists) ---
    const added = [];
    const modified = [];
    const deleted = [];
    const opaqued = [];
    const seenOpaque = new Set();
    for (const e of sortedEntries) {
      if (isOpaqueMarker(e.path)) {
        const dir = parentPath(e.path);
        if (!seenOpaque.has(dir)) {
          seenOpaque.add(dir);
          opaqued.push({ path: dir });
        }
        continue;
      }
      if (isWhiteout(e.path)) {
        const target = unWhiteoutPath(e.path);
        const lowerNode = i > 0 ? squashed.get(target) : null;
        let removedBytes = 0;
        let targetKnown = false;
        if (lowerNode) {
          targetKnown = true;
          // informative only (efficiency math sized by the caller contract: 0 for files, subtree for dirs)
          removedBytes = lowerNode.isDir ? squashed.headerSizeOfSubtree(target) : lowerNode.size;
        }
        deleted.push({
          path: target,
          whiteoutPath: e.path,
          targetKnown,
          directory: lowerNode ? lowerNode.isDir : false,
          removedBytes,
        });
        continue;
      }
      const lowerNode = squashed.get(e.path);
      if (lowerNode) {
        modified.push({ path: e.path, type: e.type, oldSize: lowerNode.size, size: e.size, oldType: lowerNode.type });
      } else {
        added.push({ path: e.path, type: e.type, size: e.size });
      }
    }

    // --- efficiency occurrences (whiteouts sizing lower dirs) ---
    for (const { node, leaf } of layerTree.walk((n) => isOpaqueMarker(n.path))) {
      if (!leaf) continue;
      const p = node.path;
      if (isWhiteout(p)) {
        if (i === 0) continue;
        const target = unWhiteoutPath(p);
        const lowerNode = squashed.get(target);
        if (!lowerNode) continue; // removes nothing below
        const size = lowerNode.isDir ? squashed.headerSizeOfSubtree(target) : 0;
        recordOccurrence(target, size);
        continue;
      }
      recordOccurrence(p, node.size);
    }

    // --- largest entries across the whole image (bounded to the biggest topLimit) ---
    // whiteout/opaque marker entries carry no bytes and mean nothing as "top files"
    for (const e of entries) {
      if (isWhiteout(e.path) || isOpaqueMarker(e.path)) continue;
      if (e.type === 'file' || e.type === 'hardlink') {
        allLargestEntries.add({ path: e.path, size: e.size, layer: i });
      }
    }

    // --- apply layer to squashed tree for the next iteration ---
    applyTreeOnto(squashed, layerTree);

    const sizeBytes = entryBytes;
    totalSizeBytes += sizeBytes;
    layers.push({
      index: i,
      digestId: diffIds[i] || null,
      command: commands[i],
      sizeBytes,
      compressedBytes: meta.size,
      compression,
      entryCount: entries.length,
      fileList,
      added,
      modified,
      deleted,
      opaqued,
    });

    progress('layer', { index: i, total: layerCount, detail: `layer ${i + 1}/${layerCount} done`, done: true });
  }

  // ---------------- integrity: decompressed zstd layers vs config rootfs.diff_ids ----------------
  // Only the in-memory decoder fallback path hashed layers (the layer is fully in memory
  // there). gzip / plain-tar / native-zstd layers are streamed and cannot be
  // hashed without buffering them — they remain unverified (see README).
  if (diffIds.length) {
    for (let i = 0; i < layerCount; i++) {
      const computed = layerHashes[i];
      if (!computed) continue; // streamed layer — nothing hashed
      const expected = String(diffIds[i] || '').toLowerCase().replace(/^sha256:/, '');
      if (!expected) continue; // no expectation for this index
      if (expected !== computed) {
        throw new Error(
          `Integrity check failed: layer ${i + 1}/${layerCount} (${layerPaths[i]}) decompressed to sha256:${computed}, ` +
          `but the image config rootfs.diff_ids expects sha256:${expected}. The archive does not match its own config ` +
          `(a layer was modified or the archive is corrupt) — refusing to trust this analysis.`,
        );
      }
    }
  } else {
    warnings.push('image config has no rootfs.diff_ids — layer integrity was NOT verified');
  }

  // ---------------- final image files (squashed) ----------------
  for (const node of squashed.map.values()) {
    if (!node.explicit) continue;
    if (node.type === 'file' || node.type === 'hardlink') {
      finalEntries.add({ path: node.path, size: node.size, type: node.type });
    }
  }

  // ---------------- efficiency score ----------------
  let minimum = 0;
  let discovered = 0;
  let reclaimableBytes = 0;
  const inefficiencies = [];
  for (const path of pathOrder) {
    const s = pathStats.get(path);
    minimum += s.min;
    discovered += s.cumulative;
    if (s.count > 1) {
      inefficiencies.push({ path, count: s.count, sizeBytes: s.cumulative });
      // The surviving copy is the payload that remains in the final squashed
      // image: the last occurrence, unless it is a deletion marker (whiteout /
      // opaque dir), in which case nothing of this path survives.
      const surviving = s.last && !s.last.deleted ? s.last.size : 0;
      reclaimableBytes += s.cumulative - surviving;
    }
  }
  inefficiencies.sort((a, b) => b.sizeBytes - a.sizeBytes || (a.path < b.path ? -1 : 1));

  const efficiency = discovered !== 0 ? minimum / discovered : 1;
  const wastedBytes = inefficiencies.reduce((acc, x) => acc + x.sizeBytes, 0);
  const firstLayerSize = layers.length ? layers[0].sizeBytes : 0;
  const userSizeBytes = totalSizeBytes - firstLayerSize;
  const wastedUserPercent = userSizeBytes > 0 ? wastedBytes / userSizeBytes : 0;


  return {
    format,
    imageName,
    warnings,
    layerCount,
    totalSizeBytes,
    userSizeBytes,
    wastedBytes,
    reclaimableBytes,
    wastedUserPercent,
    efficiency,
    inefficiencies,
    layers,
    topLayerEntries: allLargestEntries.result(),
    topFinalFiles: finalEntries.result(),
    compressedArchiveBytes: blob.size,
    platforms: platformsMeta,       // null for legacy docker-save archives
    selectedPlatform,
  };
  } finally {
    // The decode worker holds the only decoder state for this analysis; the
    // platform may not reclaim that memory until the worker is dropped for the
    // engine to GC (node) or explicitly terminated (browser).
    const session = sessionHolder.session;
    sessionHolder.session = null;
    if (session && typeof session.terminate === 'function') {
      try { await session.terminate(); } catch { /* best effort — memory dies with the worker either way */ }
    }
  }
}
