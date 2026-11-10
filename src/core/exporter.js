// Export an analysis result as JSON or CSV. Pure functions — no DOM, no I/O,
// no network. The JSON object is the single source of truth; the CSV is a
// flat rendering of the same document.
//
// Schema is documented in docs/EXPORT.md. `schemaVersion` is the contract:
// additive changes keep it, breaking changes bump it. The CSV deliberately
// carries no timestamp so exports are byte-for-byte reproducible for the
// same analysis; the JSON carries `exportedAt`.

export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_TOOL = 'layerscope';

/** Kind filter semantics mirror the UI: "deleted" covers whiteouts AND opaque markers. */
const KIND_MATCH = {
  all: () => true,
  added: (kind) => kind === 'added',
  modified: (kind) => kind === 'modified',
  deleted: (kind) => kind === 'deleted' || kind === 'opaque',
};

function passesPathFilter(path, filter) {
  if (!filter) return true;
  return path.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Build the export document for an analysis.
 * opts.generatedAt — ISO timestamp for `exportedAt` (defaults to now; pass a
 *   fixed value for reproducible tests).
 * opts.label — the label the caller used (file name), recorded as image.name
 *   when the analysis itself carries no name.
 * opts.filters — {
 *   selectedLayer, fileKind, pathFilter, wastedPathFilter, topScope, rowLimit
 * } — recorded verbatim under `filters`; `fileKind`/`pathFilter` narrow the
 * `diffs` section, `wastedPathFilter` narrows `wastedPaths`. `selectedLayer`,
 * `topScope` and `rowLimit` are recorded but never limit the export (every
 * layer's diffs are included).
 */
export function buildExport(a, opts = {}) {
  if (!a || !Array.isArray(a.layers)) {
    throw new TypeError('buildExport needs an analysis result');
  }
  const {
    generatedAt = new Date().toISOString(),
    label = '',
    filters = {},
  } = opts;

  const fileKind = filters.fileKind || 'all';
  const pathFilter = (filters.pathFilter || '').trim();
  const wastedPathFilter = (filters.wastedPathFilter || '').trim();
  const kindMatch = KIND_MATCH[fileKind] || KIND_MATCH.all;

  const layers = a.layers.map((l) => ({
    index: l.index,
    command: l.command,
    digestId: l.digestId || null,
    sizeBytes: l.sizeBytes,
    compressedBytes: l.compressedBytes,
    compression: l.compression,
    entryCount: l.entryCount,
    counts: {
      added: l.added.length,
      modified: l.modified.length,
      deleted: l.deleted.length,
      opaqued: l.opaqued.length,
    },
  }));

  const diffs = [];
  for (const l of a.layers) {
    for (const e of l.added) {
      diffs.push({ layer: l.index, kind: 'added', path: e.path, sizeBytes: e.size });
    }
    for (const e of l.modified) {
      diffs.push({ layer: l.index, kind: 'modified', path: e.path, sizeBytes: e.size, oldSizeBytes: e.oldSize });
    }
    for (const e of l.deleted) {
      diffs.push({
        layer: l.index,
        kind: 'deleted',
        path: e.path,
        removedBytes: e.removedBytes,
        whiteoutPath: e.whiteoutPath,
        targetKnown: e.targetKnown,
        directory: e.directory,
      });
    }
    for (const e of l.opaqued) {
      diffs.push({ layer: l.index, kind: 'opaque', path: e.path, opaque: true });
    }
  }
  const filteredDiffs = diffs
    .filter((d) => kindMatch(d.kind) && passesPathFilter(d.path, pathFilter))
    .sort((x, y) => x.layer - y.layer || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) || (x.kind < y.kind ? -1 : 1));

  const wastedPaths = a.inefficiencies
    .filter((i) => passesPathFilter(i.path, wastedPathFilter))
    .map((i) => ({ path: i.path, count: i.count, sizeBytes: i.sizeBytes }));

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    tool: EXPORT_TOOL,
    exportedAt: generatedAt,
    image: {
      name: a.imageName || label || null,
      format: a.format,
    },
    summary: {
      layerCount: a.layerCount,
      totalSizeBytes: a.totalSizeBytes,
      userSizeBytes: a.userSizeBytes,
      wastedBytes: a.wastedBytes,
      reclaimableBytes: a.reclaimableBytes,
      wastedUserPercent: a.wastedUserPercent,
      efficiency: a.efficiency,
      compressedArchiveBytes: a.compressedArchiveBytes,
      platforms: Array.isArray(a.platforms) ? a.platforms : null,
      selectedPlatform: a.selectedPlatform || null,
    },
    filters: {
      selectedLayer: Number.isInteger(filters.selectedLayer) ? filters.selectedLayer : null,
      fileKind,
      pathFilter,
      wastedPathFilter,
      topScope: filters.topScope || null,
      rowLimit: Number.isInteger(filters.rowLimit) ? filters.rowLimit : null,
    },
    layers,
    diffs: filteredDiffs,
    wastedPaths,
  };
}

export function exportToJSON(doc) {
  return JSON.stringify(doc, null, 2) + '\n';
}

// ---------------- CSV ----------------
// RFC 4180, UTF-8, LF line endings, no BOM. The first column is
// `schemaVersion` so every row is self-describing. Column applicability:
//   layer   — section=layer;   sizeBytes, compressedBytes
//   diff    — section=diff;    kind/path; sizeBytes (added/modified),
//             oldSizeBytes (modified), removedBytes/whiteoutPath/
//             targetKnown/directory (deleted)
//   wasted  — section=wasted;  path, copies, cumulativeBytes
// Empty cells mean "not applicable for this row kind" — never fabricated.
const CSV_HEADER = 'schemaVersion,section,layer,kind,path,sizeBytes,oldSizeBytes,compressedBytes,copies,cumulativeBytes,removedBytes,whiteoutPath,targetKnown,directory,opaque';

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

export function exportToCSV(doc) {
  const lines = [CSV_HEADER];
  for (const l of doc.layers) {
    lines.push(csvRow([
      doc.schemaVersion, 'layer', l.index, '', '', l.sizeBytes, '', l.compressedBytes, '', '', '', '', '', '', '',
    ]));
  }
  for (const d of doc.diffs) {
    lines.push(csvRow([
      doc.schemaVersion, 'diff', d.layer, d.kind, d.path,
      d.sizeBytes ?? '', d.oldSizeBytes ?? '', '', '', '',
      d.removedBytes ?? '', d.whiteoutPath ?? '',
      d.targetKnown === undefined ? '' : String(d.targetKnown),
      d.directory === undefined ? '' : String(d.directory),
      d.opaque === undefined ? '' : String(d.opaque),
    ]));
  }
  for (const w of doc.wastedPaths) {
    lines.push(csvRow([
      doc.schemaVersion, 'wasted', '', '', w.path, '', '', '', w.count, w.sizeBytes, '', '', '', '', '',
    ]));
  }
  return lines.join('\n') + '\n';
}

/** Sanitised download filename: layerscope-<image>-<yyyymmdd-hhmmss>.<ext> (UTC). */
export function exportFilename(doc, ext, now = new Date()) {
  const raw = (doc && doc.image && doc.image.name) || 'image';
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'image';
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `layerscope-${slug}-${stamp}.${ext}`;
}
