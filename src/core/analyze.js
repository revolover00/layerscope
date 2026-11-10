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
// File *contents* are only read when a layer is compressed — reading the
// file list requires full local decompression (gzip via tar iteration, zstd
// via the streaming worker decoder). Uncompressed tar layers are parsed by
// skipping header blocks; their contents are never read. zstd layers decoded
// through the pure-JS fallback (browsers without native zstd) are also
// sha256-hashed incrementally against the image config's rootfs.diff_ids —
// gzip / plain-tar / native-zstd layers remain unhashed. Everything decodes
// in this process; nothing is uploaded.

import { iterTarEntries, readBlobSlice, blobReadableStream, openTarEntryDataStream } from './tar.js';
import { nativeZstdStream, createZstd, zstdFrameContentSize } from './zstd.js';
import { enforceZstdWindowLimit, decompressReadable, LayerLimitError } from './zstd-decode.js';
import { createSha256 } from './sha256.js';
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
// Hard upper bound for the DECOMPRESSED size of a single zstd layer on the
// fallback decode path (browsers without native DecompressionStream('zstd')).
// The fallback now streams end to end — decoded blocks flow straight into
// the tar parser, so an unbounded layer is bounded here only by this budget,
// not by available memory. analyzeImage() callers may tune this with the
// `maxLayerBytes` option. Enforcement:
//   1. frames WITH a content size are refused BEFORE decoding;
//   2. every decode — with or without a content size — streams through a
//      byte-capped decoder that throws mid-flight past maxLayerBytes;
//   3. frames with an explicit window descriptor larger than 32 MiB are
//      refused before decoding (WINDOW_TOO_BIG) — see zstd-decode.js.
// gzip layers are unaffected — they stream end-to-end. Tested up to the
// limit on node (300 MiB single incompressible layer passes, see
// docs/BENCHMARKS.md) and in real Chromium (browser-bench fixture job).
// Refusal produces a clear error, never a silent crash.
const DEFAULT_MAX_LAYER_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB
const COLLECT_PATHS = new Set(['manifest.json', 'index.json', 'oci-layout', 'repositories']);
const ROOT_CONFIG_RE = /^[0-9a-f]{64}\.json$/;

function compressionFromHead(head) {
  if (!head || head.length < 2) return 'none';
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return 'none';
}

// Passthrough that feeds every chunk through `hasher` (incremental sha256).
function hashingStream(readable, hasher) {
  const reader = readable.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      hasher.update(value);
      controller.enqueue(value);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* best effort */ }
    },
  });
}

// Layer bytes -> a stream of DECOMPRESSED tar bytes for the layer pipeline.
// `compressed` is a ReadableStream positioned at the layer's first byte;
// `head` carries the first (up to) 32 bytes of the layer (already fetched for
// sniffing — reused here for the window / content-size pre-checks, so no
// second read or decode is needed).
//
// Every path streams end to end: nothing here buffers the layer. Only the
// fzstd fallback path hashes the decompressed bytes (rootfs.diff_ids
// integrity) — gzip / plain-tar / native-zstd remain unhashed, as before.
async function layerStreamFrom({ compressed, head, compression, maxLayerBytes, sessionHolder, hashSink, layerIndex }) {
  if (compression === 'none') return compressed;
  if (compression === 'gzip') return compressed.pipeThrough(new DecompressionStream('gzip'));
  // zstd
  if (nativeZstdStream()) {
    return compressed.pipeThrough(new DecompressionStream('zstd'));
  }
  // ---- pure-JS fzstd streaming fallback ----
  // 1) window policy on the frame head BEFORE any allocation: a frame whose
  //    window descriptor exceeds 32 MiB is refused with a specific error.
  enforceZstdWindowLimit(head);
  // 2) content-size policy: refuse upfront when the frame header declares a
  //    decompressed size over the budget (before any allocation). Frames
  //    without a content size are capped mid-flight by createZstdDecompressor.
  const declared = zstdFrameContentSize(head);
  if (declared != null && declared > maxLayerBytes) {
    throw new LayerLimitError(maxLayerBytes, 'before', declared);
  }
  // 3) stream through the byte-capped decoder; hash as bytes flow past.
  const hasher = createSha256();
  if (hashSink) hashSink[layerIndex] = hasher;
  if (!sessionHolder.session) sessionHolder.session = await createZstd();
  const decoded = await sessionHolder.session.decompressStream(compressed, { maxBytes: maxLayerBytes });
  return hashingStream(decoded, hasher);
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

  // ---------------- pass 0: detect a gzip/zstd-wrapped outer archive ----------------
  // `docker save` emits an uncompressed .tar, but people pipe it through gzip/zstd
  // (`docker save x | gzip > x.tar.gz`). Random access into the tar is impossible on a
  // compressed stream, so the whole outer archive is decompressed on the fly: pass 1
  // walks one streaming decompression, and pass 2 re-decompresses from the top for each
  // layer (O(outer + layers) — the wrapper is decoded once per layer; see HOW-IT-WORKS).
  // Layer bytes are drained with bounded memory — nothing is buffered whole.
  let outerCompression = 'none';
  let outerHead = null;
  if (blob.size >= 4) {
    outerHead = new Uint8Array(await readBlobSlice(blob, 0, Math.min(32, blob.size)));
    outerCompression = compressionFromHead(outerHead);
  }
  // outer zstd wrapper: same window policy as layers, checked before any allocation
  if (outerCompression === 'zstd') enforceZstdWindowLimit(outerHead);

  const outerFreshStream = () => {
    const raw = blobReadableStream(blob, 0, blob.size);
    if (outerCompression === 'gzip') return raw.pipeThrough(new DecompressionStream('gzip'));
    if (outerCompression === 'zstd') {
      if (nativeZstdStream()) return raw.pipeThrough(new DecompressionStream('zstd'));
      // outer wrapper has no size budget of its own (it is the whole image) —
      // decoding is still window-bounded by the decoder; nothing else accumulates
      return decompressReadable(raw, { maxBytes: Number.MAX_SAFE_INTEGER });
    }
    return raw;
  };
  // Compressed (or plain) outer bytes for one layer / member, plus its first bytes for sniffing.
  const outerLayerSource = async (meta) => {
    if (outerCompression === 'none') {
      const head = new Uint8Array(await blob.slice(meta.dataOffset, Math.min(meta.dataOffset + 32, meta.dataOffset + meta.size)).arrayBuffer());
      return { stream: blobReadableStream(blob, meta.dataOffset, meta.dataOffset + meta.size), head };
    }
    return openTarEntryDataStream(outerFreshStream(), meta.dataOffset, meta.size);
  };
  const outerReadSlice = async (start, end) => {
    if (outerCompression === 'none') return readBlobSlice(blob, start, end);
    const { stream } = await openTarEntryDataStream(outerFreshStream(), start, end - start);
    const reader = stream.getReader();
    const out = new Uint8Array(end - start);
    let off = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, off);
      off += value.byteLength;
    }
    return out;
  };
  const outerNote = outerCompression === 'none' ? '' : ` (while decompressing the outer .tar.${outerCompression === 'gzip' ? 'gz' : 'zst'} wrapper)`;

  // ---------------- pass 1: index the outer tar ----------------
  progress('scan', { detail: 'reading archive index' });
  const index = new Map(); // path -> { dataOffset, size }
  const collected = new Map(); // path -> Uint8Array (small metadata only)
  try {
    for await (const { header, data, dataOffset } of iterTarEntries(outerFreshStream(), {
      collectData: (h) =>
        h.size <= SMALL_FILE_MAX && (COLLECT_PATHS.has(h.path.slice(1)) || ROOT_CONFIG_RE.test(h.path.slice(1))),
    })) {
      const rel = header.path.slice(1); // store relative keys
      index.set(rel, { dataOffset, size: header.size });
      if (data) collected.set(rel, data);
    }
  } catch (err) {
    throw new Error(outerCompression === 'none'
      ? `Failed to read the tar archive: ${err.message}`
      : `Failed to decompress the outer ${outerCompression === 'gzip' ? 'gzip (.tar.gz)' : 'zstd (.tar.zst)'} wrapper or the tar inside it: ${err.message}`);
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
    const buf = await outerReadSlice(meta.dataOffset, meta.dataOffset + meta.size);
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
  const hashSinks = new Array(layerCount).fill(null);   // incremental hashers, hex'd after each layer drains

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

    progress('layer', { index: i, total: layerCount, detail: `decompressing layer ${i + 1}/${layerCount}` });

    // --- stream the layer tar, collecting header metadata only ---
    const entries = [];
    let entryBytes = 0;
    let sawAny = false;
    try {
      const { stream: layerBytes, head: layerHead } = await outerLayerSource(meta);
      if (compression === 'auto') compression = compressionFromHead(layerHead);
      for await (const { header } of iterTarEntries(await layerStreamFrom({
        compressed: layerBytes, head: layerHead, compression, maxLayerBytes,
        sessionHolder, hashSink: hashSinks, layerIndex: i,
      }), {
        collectData: () => false,
      })) {
        sawAny = true;
        entries.push(header);
        entryBytes += header.size;
      }
    } catch (err) {
      throw new Error(`Failed to unpack layer ${i + 1}/${layerCount} (${rel}): ${err.message}`);
    }
    if (hashSinks[i]) layerHashes[i] = hashSinks[i].digestHex();
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
