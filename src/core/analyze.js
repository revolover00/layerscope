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
const COLLECT_PATHS = new Set(['manifest.json', 'index.json', 'oci-layout', 'repositories']);
const ROOT_CONFIG_RE = /^[0-9a-f]{64}\.json$/;

async function sniffCompression(blob, offset) {
  const head = new Uint8Array(await blob.slice(offset, offset + 4).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return 'none';
}

function layerStream(blob, offset, size, compression) {
  const base = blobReadableStream(blob, offset, offset + size);
  if (compression === 'gzip') {
    return base.pipeThrough(new DecompressionStream('gzip'));
  }
  if (compression === 'zstd') {
    try {
      return base.pipeThrough(new DecompressionStream('zstd'));
    } catch (err) {
      throw new Error(`zstd-compressed layer is not supported by this browser (${err.message}). Convert layers to gzip.`);
    }
  }
  return base;
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

export async function analyzeImage(blob, { onProgress = () => {}, topLimit = 20 } = {}) {
  const warnings = [];
  const progress = (phase, detail) => onProgress({ phase, ...(detail || {}) });

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
    let chosen = manifests[0];
    if (manifests.length > 1) {
      const amd64 = manifests.find((m) => {
        const a = m.annotations || {};
        return (a['io.containerd.image.name'] || '').includes('amd64') || false;
      });
      if (amd64) chosen = amd64;
      warnings.push(`index.json lists ${manifests.length} manifests; analyzing the first${chosen === amd64 ? ' (linux/amd64 annotation matched)' : ''}`);
      imageName = chosen.annotations && (chosen.annotations['io.containerd.image.name'] || chosen.annotations['org.opencontainers.image.ref.name'] || null);
    } else {
      imageName = chosen.annotations && (chosen.annotations['io.containerd.image.name'] || chosen.annotations['org.opencontainers.image.ref.name'] || null);
    }
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

  // ---------------- pass 2: analyze each layer in order ----------------
  const squashed = new FileTree();
  const layers = [];
  const pathStats = new Map(); // path -> { count, cumulative, min }
  let pathOrder = [];
  let totalSizeBytes = 0;
  // top-N trackers: keep only the biggest K entries (bounded memory)
  const allLargestEntries = new TopK(topLimit, (a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
  const finalEntries = new TopK(topLimit, (a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));


  const recordOccurrence = (path, size) => {
    let s = pathStats.get(path);
    if (!s) {
      s = { count: 0, cumulative: 0, min: Infinity };
      pathStats.set(path, s);
      pathOrder.push(path);
    }
    s.count += 1;
    s.cumulative += size;
    if (size < s.min) s.min = size;
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
      for await (const { header } of iterTarEntries(layerStream(blob, meta.dataOffset, meta.size, compression), {
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
  const inefficiencies = [];
  for (const path of pathOrder) {
    const s = pathStats.get(path);
    minimum += s.min;
    discovered += s.cumulative;
    if (s.count > 1) {
      inefficiencies.push({ path, count: s.count, sizeBytes: s.cumulative });
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
    wastedUserPercent,
    efficiency,
    inefficiencies,
    layers,
    topLayerEntries: allLargestEntries.result(),
    topFinalFiles: finalEntries.result(),
    compressedArchiveBytes: blob.size,
  };
}
