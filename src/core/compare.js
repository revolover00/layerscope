// Compare two analysis results (an "before" and an "after" image) and report
// the deltas. Pure functions — no DOM, no I/O. Both inputs are analysis
// objects as produced by analyze.js; nothing about them is modified.
//
// File-level deltas are computed against the squashed "final filesystem" of
// each image (files and symlinks only — directories carry no payload), so a
// path that exists in both images at different sizes shows one row, a path
// that exists in only one shows as added/removed with the other side 0.

/**
 * Squash an analysis into a Map(path -> size) of its final manifest.
 * Layers apply in order; whiteouts remove the target subtree, opaque dirs
 * remove everything below them.
 */
export function squashFiles(a) {
  const files = new Map();
  for (const layer of a.layers) {
    for (const e of layer.added) {
      if (e.type === 'directory') continue;
      files.set(e.path, e.size);
    }
    for (const e of layer.modified) {
      if (e.type === 'directory') continue;
      files.set(e.path, e.size);
    }
    for (const d of layer.deleted) {
      if (d.directory) {
        const prefix = d.path + '/';
        for (const p of [...files.keys()]) {
          if (p === d.path || p.startsWith(prefix)) files.delete(p);
        }
      } else {
        files.delete(d.path);
      }
    }
    for (const o of layer.opaqued) {
      const prefix = (o.path === '/' ? '' : o.path) + '/';
      for (const p of [...files.keys()]) {
        if (p.startsWith(prefix)) files.delete(p);
      }
    }
  }
  return files;
}

function summaryOf(a) {
  return {
    imageName: a.imageName || null,
    format: a.format,
    layerCount: a.layerCount,
    totalSizeBytes: a.totalSizeBytes,
    userSizeBytes: a.userSizeBytes,
    wastedBytes: a.wastedBytes,
    reclaimableBytes: a.reclaimableBytes,
    wastedUserPercent: a.wastedUserPercent,
    efficiency: a.efficiency,
    compressedArchiveBytes: a.compressedArchiveBytes,
  };
}

export const COMPARE_PATH_LIMIT = 10;

/**
 * Compare analysis `before` with analysis `after`.
 * Returns {
 *   before, after:            per-image summary picks,
 *   delta: {                  after − before for each metric,
 *     totalSizeBytes, wastedBytes, reclaimableBytes, userSizeBytes,
 *     compressedArchiveBytes, efficiency (ratio points), layerCount,
 *   },
 *   changedPaths: [ { path, beforeSize, afterSize, delta } ] — sorted by
 *                 |delta| desc then path asc, limited to `topPaths`,
 *   changedPathCount, addedPathCount, removedPathCount,
 * }
 */
export function compareAnalyses(before, after, { topPaths = COMPARE_PATH_LIMIT } = {}) {
  if (!before || !after) throw new TypeError('compareAnalyses needs two analysis results');
  const beforeFiles = squashFiles(before);
  const afterFiles = squashFiles(after);

  const allPaths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  const changed = [];
  let addedPathCount = 0;
  let removedPathCount = 0;
  for (const path of allPaths) {
    const b = beforeFiles.get(path) ?? 0;
    const x = afterFiles.get(path) ?? 0;
    if (b === x) continue;
    if (b === 0 && x > 0) addedPathCount += 1;
    else if (x === 0 && b > 0) removedPathCount += 1;
    changed.push({ path, beforeSize: b, afterSize: x, delta: x - b });
  }
  changed.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta) || (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));

  return {
    before: summaryOf(before),
    after: summaryOf(after),
    delta: {
      totalSizeBytes: after.totalSizeBytes - before.totalSizeBytes,
      userSizeBytes: after.userSizeBytes - before.userSizeBytes,
      wastedBytes: after.wastedBytes - before.wastedBytes,
      reclaimableBytes: after.reclaimableBytes - before.reclaimableBytes,
      compressedArchiveBytes: after.compressedArchiveBytes - before.compressedArchiveBytes,
      efficiency: after.efficiency - before.efficiency,
      layerCount: after.layerCount - before.layerCount,
    },
    changedPaths: changed.slice(0, Math.max(0, topPaths)),
    changedPathCount: changed.length,
    addedPathCount,
    removedPathCount,
  };
}
