// Actionable suggestions derived from an analysis result.
//
// Pure functions over the analysis object produced by analyze.js — no DOM, no
// I/O, no network. Every claim in a suggestion is backed by tar-header
// evidence recorded in the analysis (added/modified/deleted entries). When
// the data only supports an upper bound, the wording says "up to".
//
// Byte accounting convention: for a path that is eventually deleted, every
// earlier copy is dead weight, so the reclaimable upper bound equals the sum
// of all write sizes (deletions carry 0 payload bytes). For a path that
// survives, at most all copies before the last are reclaimable.

import { formatBytes, formatCount } from './format.js';

// ---------------- cache-path recognition ----------------
// Directory-style markers: a whiteout of the directory or any path below it
// covers the whole subtree.
const CACHE_DIR_MARKERS = [
  { marker: '/var/lib/apt/lists', label: 'apt package lists' },
  { marker: '/var/cache/apt', label: 'apt cache' },
  { marker: '/var/cache/apk', label: 'apk cache' },
  { marker: '/var/cache/dnf', label: 'dnf cache' },
  { marker: '/var/cache/yum', label: 'yum cache' },
  { marker: '/var/cache/pacman', label: 'pacman cache' },
  { marker: '/var/cache/zypp', label: 'zypper cache' },
];
// Segment-style markers: match any path containing the segment (any user).
const CACHE_SEGMENT_MARKERS = [
  { marker: '/.cache/pip/', label: 'pip cache' },
  { marker: '/.npm/_cacache/', label: 'npm cache' },
  { marker: '/.cache/yarn/', label: 'yarn cache' },
];

function cacheLabelFor(path) {
  for (const { marker, label } of CACHE_DIR_MARKERS) {
    if (path === marker || path.startsWith(marker + '/')) return label;
  }
  for (const { marker, label } of CACHE_SEGMENT_MARKERS) {
    if (path.includes(marker)) return label;
  }
  return null;
}

const METADATA_COMMAND_RE = /(^|[\s/._-])(chown|chmod|chgrp)([\s/._-]|$)|--(chown|chmod)\b/i;
const REWRITE_MIN_BYTES = 16 * 1024; // rule 3 stays silent below 16 KiB of duplicated payload
const METADATA_ONLY_MIN_BYTES = 4 * 1024 * 1024; // uncommanded equal-size rewrites need to be large to be worth flagging
const MAX_LISTED_PATHS = 25;

function severityFor(bytes) {
  if (bytes >= 8 * 1024 * 1024) return 'high';
  if (bytes >= 256 * 1024) return 'medium';
  return 'low';
}

// ---------------- shared per-path write accounting ----------------
// For every path that is ever written (added or modified) or deleted, record
// write count, cumulative payload bytes, the layers involved and whether the
// last event was a deletion. Directory entries carry no payload and are
// skipped.
function pathWriteStats(a) {
  const stats = new Map();
  const get = (p) => {
    let s = stats.get(p);
    if (!s) {
      s = {
        path: p,
        writeCount: 0,
        cumulativeBytes: 0,
        lastWriteSize: 0,
        writeLayers: [],
        writes: [],
        deletedLayers: [],
        deletedLast: false,
        reclaimableBytes: 0,
      };
      stats.set(p, s);
    }
    return s;
  };
  for (const layer of a.layers) {
    const i = layer.index;
    for (const e of layer.added) {
      if (!isFileLike(e.type)) continue;
      const s = get(e.path);
      s.writeCount += 1;
      s.cumulativeBytes += e.size;
      s.lastWriteSize = e.size;
      s.writeLayers.push(i);
      s.writes.push({ layer: i, size: e.size });
      s.deletedLast = false;
    }
    for (const e of layer.modified) {
      if (!isFileLike(e.type)) continue;
      const s = get(e.path);
      s.writeCount += 1;
      s.cumulativeBytes += e.size;
      s.lastWriteSize = e.size;
      s.writeLayers.push(i);
      s.writes.push({ layer: i, size: e.size });
      s.deletedLast = false;
    }
    for (const d of layer.deleted) {
      const s = get(d.path);
      s.deletedLayers.push(i);
      s.deletedLast = true;
    }
  }
  for (const s of stats.values()) {
    s.reclaimableBytes = Math.max(0, s.cumulativeBytes - (s.deletedLast ? 0 : s.lastWriteSize));
  }
  return stats;
}

function isFileLike(type) {
  return type !== 'directory';
}

function uniqSorted(nums) {
  return [...new Set(nums)].sort((x, y) => x - y);
}

function capPaths(paths) {
  const sorted = [...paths];
  const truncated = sorted.length > MAX_LISTED_PATHS;
  return { paths: sorted.slice(0, MAX_LISTED_PATHS), morePaths: truncated ? sorted.length - MAX_LISTED_PATHS : 0 };
}

// ---------------- rule 1: add then delete in a later layer ----------------
function ruleAddThenDelete(a, stats) {
  const matches = [];
  for (const s of stats.values()) {
    if (!s.deletedLast || s.writeCount === 0) continue;
    if (cacheLabelFor(s.path)) continue; // cache paths get their own, better-worded suggestion
    if (Math.max(...s.deletedLayers) <= Math.min(...s.writeLayers)) continue; // created and removed in the same layer — nothing stranded across layers
    matches.push({
      path: s.path,
      bytes: s.reclaimableBytes,
      firstLayer: Math.min(...s.writeLayers),
      deleteLayer: Math.max(...s.deletedLayers),
    });
  }
  if (!matches.length) return null;
  matches.sort((x, y) => y.bytes - x.bytes || (x.path < y.path ? -1 : 1));
  const bytes = matches.reduce((sum, m) => sum + m.bytes, 0);
  const { paths, morePaths } = capPaths(matches.map((m) => m.path));
  const layers = uniqSorted(matches.flatMap((m) => [m.firstLayer, m.deleteLayer]));
  const first = matches[0];
  return {
    id: 'add-then-delete',
    severity: severityFor(bytes),
    title: matches.length === 1
      ? 'A file is added in one layer and deleted in a later one'
      : `${formatCount(matches.length)} files are added in one layer and deleted in a later one`,
    detail:
      `${first.path} is written in layer ${first.firstLayer + 1} and removed in layer ${first.deleteLayer + 1}. ` +
      `Up to ${formatBytes(bytes)} of earlier-layer bytes for these paths disappear only if creation and removal ` +
      `happen in the same step. (Upper bound — it assumes nothing of these files is needed between the layers.)`,
    layers,
    paths,
    morePaths,
    bytesReclaimable: bytes,
    fix:
      'Create and delete the file inside a single RUN instruction (e.g. "RUN build && … && rm -rf build/"), or use a ' +
      'multi-stage build and copy only the result into the final image — the intermediate bytes then never enter any layer.',
  };
}

// ---------------- rule 2: package-manager caches removed across layers ----------------
// A cache is "cleaned across layers" when a cache-labeled file/dir written in
// an earlier layer is wiped by a whiteout in a later layer. Directory
// whiteouts cover everything written below them; file whiteouts cover only
// themselves.
function ruleCacheCleanup(a, stats) {
  const wipes = [];
  for (const layer of a.layers) {
    for (const d of layer.deleted) {
      const label = cacheLabelFor(d.path);
      if (label) wipes.push({ index: layer.index, path: d.path, isDir: Boolean(d.directory), label });
    }
  }
  if (!wipes.length) return null;

  const best = new Map(); // path -> { bytes, label, firstLayer, wipeLayer }
  for (const [path, s] of stats) {
    if (!s.writeCount) continue;
    for (const w of wipes) {
      const covers = path === w.path || (w.isDir && path.startsWith(w.path + '/'));
      if (!covers) continue;
      let bytes = 0;
      let firstLayer = Infinity;
      // only writes strictly before the wiping layer are stranded
      for (const wri of s.writes) {
        if (wri.layer < w.index) {
          bytes += wri.size;
          if (wri.layer < firstLayer) firstLayer = wri.layer;
        }
      }
      if (firstLayer === Infinity || bytes <= 0) continue; // cache recreated after the wipe — not waste
      const cur = best.get(path);
      if (!cur || bytes > cur.bytes) {
        best.set(path, { bytes, label: w.label, firstLayer, wipeLayer: w.index });
      }
    }
  }
  const matches = [...best.entries()].map(([path, m]) => ({ path, ...m }));
  if (!matches.length) return null;
  matches.sort((x, y) => y.bytes - x.bytes || (x.path < y.path ? -1 : 1));
  const bytes = matches.reduce((sum, m) => sum + m.bytes, 0);
  const labels = [...new Set(matches.map((m) => m.label))].sort();
  const { paths, morePaths } = capPaths(matches.map((m) => m.path));
  const layers = uniqSorted(matches.flatMap((m) => [m.firstLayer, m.wipeLayer]));
  return {
    id: 'cache-cleanup',
    severity: severityFor(bytes),
    title: `Package-manager ${labels.length === 1 ? labels[0] : 'caches'} created in one layer and removed in a later one`,
    detail:
      `Cache files under ${labels.join(', ')} are written in one layer and whited-out in a later layer. ` +
      `Up to ${formatBytes(bytes)} of cache bytes remain in the image although the caches were meant to be temporary. ` +
      `(Upper bound — only writes strictly before the removal are counted.)`,
    layers,
    paths,
    morePaths,
    bytesReclaimable: bytes,
    fix:
      'Run the install and the cleanup in the same RUN (e.g. "apt-get update && apt-get install -y … && rm -rf /var/lib/apt/lists/*"), ' +
      'or use the package manager’s no-cache option (apk add --no-cache, pip install --no-cache-dir). ' +
      'The cache then never reaches a layer in the first place.',
  };
}

// ---------------- rule 3: same path rewritten in multiple layers ----------------
function ruleRewrittenPaths(a, stats) {
  const candidates = [];
  for (const s of stats.values()) {
    if (s.writeCount < 2) continue;
    if (s.deletedLast) continue; // rules 1/2 cover paths that are deleted later
    if (s.reclaimableBytes < REWRITE_MIN_BYTES) continue;
    candidates.push({ path: s.path, reclaimable: s.reclaimableBytes, count: s.writeCount, layers: uniqSorted(s.writeLayers) });
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => y.reclaimable - x.reclaimable || (x.path < y.path ? -1 : 1));
  const shown = candidates.slice(0, 5);
  const bytes = shown.reduce((sum, c) => sum + c.reclaimable, 0);
  const layers = uniqSorted(shown.flatMap((c) => c.layers));
  const { paths, morePaths } = capPaths(candidates.map((c) => c.path));
  const top = shown[0];
  return {
    id: 'rewritten-paths',
    severity: severityFor(bytes),
    title: `${candidates.length === 1 ? 'A path is' : `${formatCount(candidates.length)} paths are`} rewritten in multiple layers`,
    detail:
      `${top.path} is written ${top.count}×; earlier copies are fully replaced later. ` +
      `Up to ${formatBytes(bytes)} across the ${shown.length === 1 ? 'listed path' : `${shown.length} largest paths`} ` +
      `lives only in overwritten layers.`,
    layers,
    paths,
    morePaths,
    bytesReclaimable: bytes,
    fix:
      'Rewrite the file in a single RUN (combine the steps that produce it), or copy it in from an earlier stage. ' +
      'Docker layers are immutable — even a one-byte change re-stores the entire file.',
  };
}

// ---------------- rule 4: chown/chmod-style layers duplicating payloads ----------------
// The tar format cannot express "only the owner/mode changed": a separate
// chown/chmod layer re-stores full payloads. Detected via modified entries
// whose size is unchanged inside a metadata-looking layer; without a
// metadata-looking command only very large equal-size rewrites are reported
// (and worded cautiously — the data cannot prove intent).
function ruleMetadataLayer(a, stats) {
  const suspects = new Map(); // path -> { path, size, layers: [], commandBacked }
  for (const layer of a.layers) {
    const commandBacked = METADATA_COMMAND_RE.test(layer.command || '');
    for (const e of layer.modified) {
      if (!isFileLike(e.type)) continue;
      if (e.oldSize !== e.size || e.size <= 0) continue;
      if (!commandBacked && e.size < METADATA_ONLY_MIN_BYTES) continue;
      const cur = suspects.get(e.path);
      if (cur) {
        cur.layers.push(layer.index);
        cur.commandBacked = cur.commandBacked || commandBacked;
        if (e.size > cur.size) cur.size = e.size;
      } else {
        suspects.set(e.path, { path: e.path, size: e.size, layers: [layer.index], commandBacked });
      }
    }
  }
  if (!suspects.size) return null;
  // Byte bound comes from the full write history of the suspect paths (the
  // original ADD is what actually duplicates the payload), not from the
  // modified entries alone — otherwise the bound collapses to zero.
  let bytes = 0;
  for (const path of suspects.keys()) bytes += stats.get(path)?.reclaimableBytes ?? 0;
  if (bytes <= 0) return null;
  const matches = [...suspects.values()];
  const anyCommandBacked = matches.some((m) => m.commandBacked);
  matches.sort((x, y) => y.size - x.size || (x.path < y.path ? -1 : 1));
  const { paths, morePaths } = capPaths(matches.map((m) => m.path));
  const layers = uniqSorted(matches.flatMap((m) => m.layers));
  const layerList = layers.map((i) => i + 1).join(', ');
  return {
    id: 'metadata-only-rewrite',
    severity: severityFor(bytes),
    title: anyCommandBacked
      ? 'Metadata-only layer(s) re-store full file payloads'
      : 'Large file(s) rewritten without a size change',
    detail: anyCommandBacked
      ? `Layers ${layerList} run a chown/chmod/chgrp-style command; ${formatCount(matches.length)} file(s) are re-stored ` +
        `byte-identically in size because tar cannot express "metadata only". Up to ${formatBytes(bytes)} are duplicated.`
      : `Layers ${layerList} re-store ${formatCount(matches.length)} file(s) with the same size. If only ownership or ` +
        `permissions changed, the tar format still forces a full re-store; if the content changed at the same length, the earlier ` +
        `copies are equally dead. Up to ${formatBytes(bytes)} are duplicated.`,
    layers,
    paths,
    morePaths,
    bytesReclaimable: bytes,
    fix:
      'Set ownership/permissions in the same step that creates the files (COPY --chown=… / --chmod=…, or chown inside the same RUN). ' +
      'A separate chown/chmod layer duplicates every payload it touches.',
  };
}

// ---------------- rule 5: largest wasted paths ----------------
function ruleTopWastedPaths(a, stats) {
  const top = a.inefficiencies.filter((i) => i.sizeBytes > 0).slice(0, 5);
  if (!top.length) return null;
  let bytes = 0;
  const pathSet = new Set(top.map((i) => i.path));
  const layers = new Set();
  for (const [path, s] of stats) {
    if (!pathSet.has(path)) continue;
    bytes += s.reclaimableBytes;
    for (const l of s.writeLayers) layers.add(l);
    for (const l of s.deletedLayers) layers.add(l);
  }
  if (bytes <= 0) return null;
  return {
    id: 'top-wasted-paths',
    severity: severityFor(bytes),
    title: 'Largest wasted paths',
    detail:
      `These ${top.length} path(s) account for the most duplicated bytes in the image. Each appears in at least two layers ` +
      `(or was deleted); only the newest copy survives — up to ${formatBytes(bytes)} disappears if each path is built once.`,
    layers: uniqSorted([...layers]),
    paths: top.map((i) => i.path),
    morePaths: 0,
    bytesReclaimable: bytes,
    fix:
      'Reorder the Dockerfile so each file is written once — combine related RUN steps, produce artifacts in an earlier ' +
      '"builder" stage and COPY only the result, or mount caches (RUN --mount=type=cache) instead of writing them into the image.',
  };
}

// ---------------- entry point ----------------
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Build the list of suggestions for an analysis result.
 * Returns a new array (possibly empty), sorted by severity then bytes.
 */
export function buildSuggestions(a) {
  if (!a || !Array.isArray(a.layers)) return [];
  const stats = pathWriteStats(a);
  const out = [];
  for (const rule of [ruleAddThenDelete, ruleCacheCleanup, ruleRewrittenPaths, ruleMetadataLayer, ruleTopWastedPaths]) {
    const s = rule(a, stats);
    if (s) out.push(s);
  }
  out.sort((x, y) =>
    SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
    y.bytesReclaimable - x.bytesReclaimable ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  return out;
}
