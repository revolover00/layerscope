// layerscope — UI orchestration. All analysis happens locally in the tab.

import { analyzeImage, formatPlatform } from './core/analyze.js';
import { formatBytes, formatPercent, formatCount, formatPercentBig } from './core/format.js';
import { buildSuggestions } from './core/insights.js';
import { compareAnalyses } from './core/compare.js';
import { buildExport, exportToJSON, exportToCSV, exportFilename } from './core/exporter.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  analysis: null,
  selectedLayer: 0,
  fileKind: 'all',
  fileFilter: '',
  topScope: 'layers',
  wastedFilter: '',
  rowLimit: 400,
  blob: null,       // kept so a multi-platform OCI index can be re-analyzed on demand
  label: '',
  platform: null,
  compare: { a: null, b: null, running: false, queue: [] },  // per side: { analysis, label }
};

// ---------------- helpers ----------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showView(name) {
  $('#landing').hidden = name !== 'landing';
  $('#analysis').hidden = name !== 'analysis';
  $('#compare').hidden = name !== 'compare';
  window.scrollTo({ top: 0 });
}

function setProgress(fraction, text, detail) {
  $('#progress-fill').style.width = `${Math.round(Math.min(0.99, Math.max(0.03, fraction)) * 100)}%`;
  if (text) $('#progress-text').textContent = text;
  if (detail !== undefined) $('#progress-file').textContent = detail;
}

function showError(message) {
  let box = $('#error-box');
  if (!box) {
    box = el('div', 'warnings error-box');
    box.id = 'error-box';
    // place it directly below the dropzone so the failure is visible without scrolling
    const dropzone = $('#dropzone');
    if (dropzone && dropzone.parentNode) dropzone.parentNode.insertBefore(box, dropzone.nextSibling);
    else $('#landing .hero').appendChild(box);
  }
  box.innerHTML = '';
  const title = el('strong', '', 'Could not analyze that archive. ');
  box.appendChild(title);
  box.appendChild(document.createTextNode(message));
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------- analysis flow ----------------

async function analyze(blob, label, platform = null) {
  const overlay = $('#progress-overlay');
  overlay.hidden = false;
  setProgress(0.02, 'Reading archive index…', label || '');

  try {
    const analysis = await analyzeImage(blob, {
      topLimit: 20,
      platform,
      onProgress: (p) => {
        if (p.phase === 'scan') setProgress(0.06, p.detail || 'Reading archive index…', label);
        else if (p.phase === 'layer') {
          const frac = 0.1 + 0.82 * ((p.index + (p.done ? 1 : 0)) / Math.max(1, p.total));
          setProgress(frac, p.detail || `Layer ${p.index + 1}/${p.total}`, label);
        } else if (p.phase === 'finalize') setProgress(0.95, 'Computing efficiency…', label);
      },
    });
    state.analysis = analysis;
    state.blob = blob;
    state.label = label || '';
    state.platform = platform;
    state.selectedLayer = 0;
    state.fileKind = 'all';
    state.fileFilter = '';
    state.topScope = 'layers';
    state.wastedFilter = '';
    setProgress(1, 'Done', label);
    renderAnalysis(analysis, label);
    overlay.hidden = true;
    showView('analysis');
    activateTab('tab-layers');
  } catch (err) {
    console.error('analyze failed', err);
    overlay.hidden = true;
    showView('landing');
    showError(err && err.message ? err.message : String(err));
  }
}

// ---------------- render: platform picker (multi-platform OCI indexes) ----------------

function renderPlatformPicker(a) {
  const row = $('#platform-row');
  if (!row) return;
  const platforms = Array.isArray(a.platforms) ? a.platforms : [];
  if (platforms.length < 2) { row.hidden = true; return; }
  const selected = (platforms.find((p) => p.selected) || platforms[0]);
  $('#platform-title').textContent = `Multi-platform image — analyzed ${formatPlatform(selected)}.`;
  const chips = $('#platform-chips');
  chips.innerHTML = '';
  for (const p of platforms) {
    const name = formatPlatform(p);
    const btn = el('button', 'platform-chip' + (p.selected ? ' is-active' : ''), name);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', p.selected ? 'true' : 'false');
    if (p.selected) btn.disabled = true;
    btn.addEventListener('click', () => {
      if (p.selected || !state.blob) return;
      analyze(state.blob, state.label, name);
    });
    chips.appendChild(btn);
  }
  row.hidden = false;
}

// ---------------- render: overview ----------------

function renderAnalysis(a, label) {
  const fullName = a.imageName || label || 'unnamed image';
  const nameEl = $('#image-name');
  nameEl.textContent = fullName;
  nameEl.title = fullName; // full name on hover; the head pins to one ellipsized line
  $('#chip-format').textContent = a.format;
  $('#chip-layers').textContent = `${a.layerCount} layer${a.layerCount === 1 ? '' : 's'}`;
  $('#chip-compressed').textContent = `${formatBytes(a.compressedArchiveBytes)} archive`;

  $('#stat-total').textContent = formatBytes(a.totalSizeBytes);
  $('#stat-wasted').textContent = formatBytes(a.wastedBytes);
  $('#stat-reclaimable').textContent = formatBytes(a.reclaimableBytes);

  // gauge
  const score = a.efficiency;
  const gauge = $('#gauge-fill');
  const C = 326.7;
  gauge.style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, score))));
  gauge.classList.remove('good', 'ok', 'bad');
  gauge.classList.add(score >= 0.95 ? 'good' : score >= 0.8 ? 'ok' : 'bad');
  $('#gauge-value').textContent = `${(score * 100).toFixed(1)}%`;

  renderPlatformPicker(a);

  // warnings
  const warnBox = $('#warnings');
  warnBox.innerHTML = '';
  if (a.warnings.length) {
    const title = el('strong', '', 'Notes:');
    const ul = el('ul');
    for (const w of a.warnings) ul.appendChild(el('li', '', w));
    warnBox.appendChild(title);
    warnBox.appendChild(ul);
    warnBox.hidden = false;
  } else {
    warnBox.hidden = true;
  }

  renderLayerTable(a);
  selectLayer(0);
  renderTopFiles();
  renderWasted();
  renderSuggestions(a);
}

// ---------------- render: suggestions ----------------

function suggestionLayersText(layers) {
  return `Layer${layers.length === 1 ? '' : 's'} ${layers.map((i) => i + 1).join(', ')}`;
}

function renderSuggestions(a) {
  const list = $('#suggestions-list');
  if (!list) return;
  const empty = $('#suggestions-empty');
  const count = $('#suggestions-count');
  const suggestions = buildSuggestions(a);
  list.innerHTML = '';

  if (count) count.textContent = suggestions.length === 0 ? '0 found' : `${suggestions.length} found`;
  if (empty) empty.hidden = suggestions.length !== 0;

  const frag = document.createDocumentFragment();
  for (const s of suggestions) {
    const card = el('article', 'suggestion');
    card.dataset.suggestionId = s.id;

    const head = el('div', 'suggestion-head');
    const sev = el('span', `severity severity-${s.severity}`, s.severity);
    sev.setAttribute('aria-label', `severity: ${s.severity}`);
    const title = el('h4', 'suggestion-title', s.title);
    const bytes = el('span', 'suggestion-bytes', `up to ${formatBytes(s.bytesReclaimable)} reclaimable`);
    head.append(sev, title, bytes);

    const detail = el('p', 'suggestion-detail', s.detail);

    const meta = el('div', 'suggestion-meta');
    meta.appendChild(el('span', 'suggestion-layers', suggestionLayersText(s.layers)));
    if (s.paths && s.paths.length) {
      const ul = el('ul', 'suggestion-paths');
      ul.setAttribute('aria-label', 'Affected paths');
      for (const p of s.paths) {
        const li = el('li');
        const code = el('code', '', p);
        li.appendChild(code);
        ul.appendChild(li);
      }
      meta.appendChild(ul);
      if (s.morePaths > 0) {
        meta.appendChild(el('span', 'suggestion-more', `+${s.morePaths} more path${s.morePaths === 1 ? '' : 's'}`));
      }
    }

    const fix = el('p', 'suggestion-fix');
    const fixLabel = el('strong', '', 'Fix. ');
    fix.appendChild(fixLabel);
    fix.appendChild(document.createTextNode(s.fix));

    card.append(head, detail, meta, fix);
    frag.appendChild(card);
  }
  list.appendChild(frag);
}

// ---------------- render: layers ----------------

function renderLayerTable(a) {
  const tbody = $('#layer-table tbody');
  tbody.innerHTML = '';
  const maxSize = Math.max(1, ...a.layers.map((l) => l.sizeBytes));
  const frag = document.createDocumentFragment();
  for (const layer of a.layers) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.index = String(layer.index);
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `Select layer ${layer.index}`);

    const tdIdx = el('td', 'idx', String(layer.index));
    const tdBar = el('td', 'size-bar-cell');
    const bar = el('div', 'layer-size-bar');
    const fill = el('span');
    fill.style.width = `${Math.max(2, (layer.sizeBytes / maxSize) * 100)}%`;
    bar.appendChild(fill);
    tdBar.appendChild(bar);
    const tdSize = el('td', 'num', formatBytes(layer.sizeBytes));
    const tdCmd = el('td', 'layer-cmd', layer.command);
    tdCmd.title = layer.command;

    tr.append(tdIdx, tdBar, tdSize, tdCmd);
    tr.addEventListener('click', () => selectLayer(layer.index));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLayer(layer.index); }
    });
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function selectLayer(index) {
  const a = state.analysis;
  if (!a) return;
  state.selectedLayer = index;
  const layer = a.layers[index];

  $$('#layer-table tbody tr').forEach((tr) => {
    tr.classList.toggle('is-selected', Number(tr.dataset.index) === index);
  });

  $('#ld-index').textContent = `${index + 1} / ${a.layerCount}`;
  $('#ld-command').textContent = layer.command;
  $('#ld-command').title = layer.command;
  const copyBtn = $('#ld-copy-command');
  copyBtn.classList.remove('is-done', 'is-fail');
  copyBtn.querySelector('.copy-btn-label').textContent = 'Copy';
  $('#ld-digest').textContent = layer.digestId || 'digest unavailable (config has no diff_ids)';
  $('#ld-size').textContent = formatBytes(layer.sizeBytes);
  $('#ld-blob').textContent = formatBytes(layer.compressedBytes);
  $('#ld-comp').textContent = layer.compression;
  $('#ld-entries').textContent = formatCount(layer.entryCount);

  const added = layer.added.length;
  const modified = layer.modified.length;
  const deleted = layer.deleted.length + layer.opaqued.length;
  $('#cnt-added').textContent = `${formatCount(added)} added`;
  $('#cnt-modified').textContent = `${formatCount(modified)} modified`;
  $('#cnt-deleted').textContent = `${formatCount(deleted)} deleted`;
  const total = Math.max(1, added + modified + deleted);
  $('#seg-added').style.width = `${(added / total) * 100}%`;
  $('#seg-modified').style.width = `${(modified / total) * 100}%`;
  $('#seg-deleted').style.width = `${(deleted / total) * 100}%`;

  $('#ld-filter').value = state.fileFilter;
  renderFileList();
}

function currentRows() {
  const layer = state.analysis.layers[state.selectedLayer];
  const rows = [];
  for (const e of layer.added) rows.push({ kind: 'added', path: e.path, size: e.size });
  for (const e of layer.modified) rows.push({ kind: 'modified', path: e.path, size: e.size, oldSize: e.oldSize, oldType: e.oldType, type: e.type });
  for (const e of layer.deleted) rows.push({ kind: 'deleted', path: e.path, size: 0, whiteout: e.whiteoutPath, directory: e.directory, targetKnown: e.targetKnown, removedBytes: e.removedBytes });
  for (const e of layer.opaqued) rows.push({ kind: 'deleted', path: e.path, size: 0, opaque: true });
  rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return rows;
}

function renderFileList() {
  const list = $('#ld-file-list');
  const trunc = $('#ld-truncated');
  list.innerHTML = '';

  const f = state.fileFilter.trim().toLowerCase();
  const rows = currentRows().filter((r) => {
    if (state.fileKind !== 'all' && r.kind !== state.fileKind) return false;
    if (f && !r.path.toLowerCase().includes(f)) return false;
    return true;
  });

  if (!rows.length) {
    list.appendChild(el('div', 'file-list-empty', 'No changes match this filter.'));
    trunc.hidden = true;
    return;
  }

  const shown = rows.slice(0, state.rowLimit);
  const frag = document.createDocumentFragment();
  for (const r of shown) {
    const row = el('div', 'file-row');
    const kind = el('span', `file-kind kind-${r.kind}`, r.kind.toUpperCase());
    const path = el('span', 'file-path', r.path);
    path.title = r.opaque ? `opaque marker — contents of ${r.path} hidden from lower layers` : r.whiteout ? `whiteout: ${r.whiteout}` : r.path;
    let meta;
    if (r.kind === 'modified' && (r.type === 'dir' || r.oldType === '5')) {
      meta = el('span', 'file-meta', 'directory');
    } else if (r.kind === 'modified') {
      meta = el('span', 'file-meta');
      const old = el('s', '', formatBytes(r.oldSize));
      meta.appendChild(old);
      meta.appendChild(document.createTextNode(` → ${formatBytes(r.size)}`));
    } else if (r.opaque) {
      meta = el('span', 'file-meta', 'opaque dir');
    } else if (r.kind === 'deleted') {
      meta = el('span', 'file-meta', r.targetKnown ? `${r.directory ? 'dir' : 'file'} · ${formatBytes(r.removedBytes)} hidden below` : 'no target below');
    } else {
      meta = el('span', 'file-meta', formatBytes(r.size));
    }
    row.append(kind, path, meta);
    frag.appendChild(row);
  }
  list.appendChild(frag);
  trunc.hidden = rows.length <= shown.length;
  trunc.textContent = `Showing first ${shown.length} of ${formatCount(rows.length)} matching changes — narrow with the filter.`;
}

// ---------------- render: top files ----------------

function renderTopFiles() {
  const a = state.analysis;
  if (!a) return;
  const scope = state.topScope;
  const tbody = $('#top-tbody');
  tbody.innerHTML = '';
  $('#top-scope-note').textContent = scope === 'layers'
    ? 'Largest individual layer entries — the same path can appear once per layer.'
    : 'Largest files present in the final squashed image.';
  $('#top-col-context').textContent = scope === 'layers' ? 'Layer' : 'Type';

  const data = scope === 'layers' ? a.topLayerEntries : a.topFinalFiles;
  const max = Math.max(1, ...data.map((d) => d.size));
  const frag = document.createDocumentFragment();
  data.forEach((d, i) => {
    const tr = document.createElement('tr');
    const share = a.totalSizeBytes ? d.size / a.totalSizeBytes : 0;
    tr.append(
      el('td', 'rank', String(i + 1)),
      (() => { const td = el('td', 'path', d.path); td.title = d.path; return td; })(),
      el('td', 'num', formatBytes(d.size)),
      (() => { const td = el('td'); const bar = el('div', 'share-bar'); const fill = el('span'); fill.style.width = `${(d.size / max) * 100}%`; bar.appendChild(fill); bar.title = formatPercent(share, 2); td.appendChild(bar); return td; })(),
      el('td', 'num', scope === 'layers' ? `#${d.layer + 1}` : d.type),
    );
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

// ---------------- render: wasted space ----------------

function renderWasted() {
  const a = state.analysis;
  if (!a) return;

  $('#ws-efficiency').textContent = formatPercent(a.efficiency, 1);
  $('#ws-wasted').textContent = formatBytes(a.wastedBytes);
  $('#ws-reclaimable').textContent = formatBytes(a.reclaimableBytes);
  $('#ws-userpct').textContent = formatPercentBig(a.wastedUserPercent);
  $('#ws-paths').textContent = formatCount(a.inefficiencies.length);

  const tbody = $('#wasted-tbody');
  tbody.innerHTML = '';
  const empty = $('#wasted-empty');
  $('#wasted-filter').value = state.wastedFilter;

  const f = state.wastedFilter.trim().toLowerCase();
  const rows = a.inefficiencies.filter((r) => !f || r.path.toLowerCase().includes(f));
  const maxShare = a.wastedBytes || 1;

  empty.hidden = a.inefficiencies.length !== 0;
  const maxCum = Math.max(1, ...a.inefficiencies.map((r) => r.sizeBytes));
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 300)) {
    const tr = document.createElement('tr');
    tr.append(
      (() => { const td = el('td', 'path', r.path); td.title = r.path; return td; })(),
      el('td', 'num', String(r.count)),
      el('td', 'num', formatBytes(r.sizeBytes)),
      el('td', 'num', formatPercent(r.sizeBytes / maxShare, 1)),
      (() => { const td = el('td', 'bar-cell'); const bar = el('div', 'waste-bar'); const fill = el('span'); fill.style.width = `${(r.sizeBytes / maxCum) * 100}%`; bar.appendChild(fill); td.appendChild(bar); return td; })(),
    );
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

// ---------------- export ----------------

function activeExportFilters() {
  return {
    selectedLayer: state.selectedLayer,
    fileKind: state.fileKind,
    pathFilter: state.fileFilter,
    wastedPathFilter: state.wastedFilter,
    topScope: state.topScope,
    rowLimit: state.rowLimit,
  };
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download in some builds.
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportAnalysis(kind) {
  const a = state.analysis;
  if (!a) return;
  const doc = buildExport(a, { label: state.label, filters: activeExportFilters() });
  if (kind === 'csv') {
    downloadText(exportFilename(doc, 'csv'), exportToCSV(doc), 'text/csv;charset=utf-8');
  } else {
    downloadText(exportFilename(doc, 'json'), exportToJSON(doc), 'application/json');
  }
}

// ---------------- compare view ----------------

function compareError(message) {
  let box = $('#compare-error');
  box.innerHTML = '';
  if (!message) { box.hidden = true; return; }
  box.appendChild(el('strong', '', 'Could not analyze that archive. '));
  box.appendChild(document.createTextNode(message));
  box.hidden = false;
}

// Uploads are enqueued instead of dropped: picking both files in quick
// succession must analyze both, not silently ignore the second.
function enqueueCompare(side, file) {
  state.compare.queue.push({ side, file });
  if (!state.compare.running) void runCompareQueue();
}

async function runCompareQueue() {
  state.compare.running = true;
  try {
    while (state.compare.queue.length) {
      const { side, file } = state.compare.queue.shift();
      await analyzeCompareSide(side, file);
    }
  } finally {
    state.compare.running = false;
  }
}

async function analyzeCompareSide(side, file) {
  compareError(null);
  const overlay = $('#progress-overlay');
  overlay.hidden = false;
  setProgress(0.02, `Reading ${side === 'a' ? 'A' : 'B'} archive index…`, file.name || '');
  try {
    const analysis = await analyzeImage(file, {
      topLimit: 20,
      onProgress: (p) => {
        if (p.phase === 'scan') setProgress(0.06, p.detail || 'Reading archive index…', file.name);
        else if (p.phase === 'layer') {
          const frac = 0.1 + 0.82 * ((p.index + (p.done ? 1 : 0)) / Math.max(1, p.total));
          setProgress(frac, p.detail || `Layer ${p.index + 1}/${p.total}`, file.name);
        } else if (p.phase === 'finalize') setProgress(0.95, 'Computing efficiency…', file.name);
      },
    });
    state.compare[side] = { analysis, label: file.name || '' };
    const status = $(`#compare-status-${side}`);
    status.textContent = `${file.name || 'image'} — ${analysis.layerCount} layer${analysis.layerCount === 1 ? '' : 's'} · ${formatBytes(analysis.totalSizeBytes)}`;
    status.classList.add('is-loaded');
    status.classList.remove('is-error');
    status.title = file.name || '';
    setProgress(1, 'Done', file.name);
    overlay.hidden = true;
    maybeRenderCompare();
  } catch (err) {
    console.error('compare side failed', err);
    state.compare[side] = null;
    const status = $(`#compare-status-${side}`);
    status.textContent = file.name ? `${file.name} — failed to analyze` : 'Failed to analyze';
    status.classList.add('is-error');
    status.classList.remove('is-loaded');
    overlay.hidden = true;
    compareError(err && err.message ? err.message : String(err));
    $(`#compare-results`).hidden = true;
  }
}

function signedBytes(delta) {
  if (delta === 0) return '0 B';
  return `${delta > 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`;
}

function signedPts(deltaRatio) {
  const pts = Math.abs(deltaRatio * 100);
  if (deltaRatio === 0) return '±0.0 pts';
  return `${deltaRatio > 0 ? '+' : '−'}${pts.toFixed(1)} pts`;
}

function signedCount(delta) {
  if (delta === 0) return '±0';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
}

function setDeltaClass(node, goodWhenNegative, delta) {
  node.classList.remove('delta-good', 'delta-bad', 'delta-neutral');
  if (delta === 0) { node.classList.add('delta-neutral'); return; }
  const good = goodWhenNegative ? delta < 0 : delta > 0;
  node.classList.add(good ? 'delta-good' : 'delta-bad');
}

function maybeRenderCompare() {
  const { a, b } = state.compare;
  if (a && b) renderCompare(a.analysis, b.analysis, a.label, b.label);
}

function renderCompare(aAnal, bAnal, aLabel, bLabel) {
  const cmp = compareAnalyses(aAnal, bAnal);
  $('#compare-results-title').textContent = `${aLabel || 'A'} → ${bLabel || 'B'}`;

  const total = $('#cd-total');
  total.textContent = signedBytes(cmp.delta.totalSizeBytes);
  setDeltaClass(total, true, cmp.delta.totalSizeBytes);
  $('#cd-total-sub').textContent = `${formatBytes(cmp.before.totalSizeBytes)} → ${formatBytes(cmp.after.totalSizeBytes)}`;

  const wasted = $('#cd-wasted');
  wasted.textContent = signedBytes(cmp.delta.wastedBytes);
  setDeltaClass(wasted, true, cmp.delta.wastedBytes);
  $('#cd-wasted-sub').textContent = `${formatBytes(cmp.before.wastedBytes)} → ${formatBytes(cmp.after.wastedBytes)}`;

  const reclaim = $('#cd-reclaimable');
  reclaim.textContent = signedBytes(cmp.delta.reclaimableBytes);
  setDeltaClass(reclaim, true, cmp.delta.reclaimableBytes);
  $('#cd-reclaimable-sub').textContent = `${formatBytes(cmp.before.reclaimableBytes)} → ${formatBytes(cmp.after.reclaimableBytes)}`;

  const eff = $('#cd-efficiency');
  eff.textContent = signedPts(cmp.delta.efficiency);
  setDeltaClass(eff, false, cmp.delta.efficiency);
  $('#cd-efficiency-sub').textContent = `${formatPercent(cmp.before.efficiency, 1)} → ${formatPercent(cmp.after.efficiency, 1)}`;

  const layers = $('#cd-layers');
  layers.textContent = signedCount(cmp.delta.layerCount);
  layers.classList.remove('delta-good', 'delta-bad');
  layers.classList.add('delta-neutral');
  $('#cd-layers-sub').textContent = `${cmp.before.layerCount} → ${cmp.after.layerCount} layer${cmp.after.layerCount === 1 ? '' : 's'}`;

  const tbody = $('#compare-tbody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const row of cmp.changedPaths) {
    const tr = document.createElement('tr');
    const tdPath = el('td', 'path', row.path);
    tdPath.title = row.path;
    const tdA = el('td', 'num');
    const tdB = el('td', 'num');
    for (const [td, size] of [[tdA, row.beforeSize], [tdB, row.afterSize]]) {
      if (size === 0) { td.textContent = '—'; td.classList.add('compare-path-absent'); td.title = 'absent in that image'; }
      else td.textContent = formatBytes(size);
    }
    const tdDelta = el('td', 'num', row.delta === 0 ? '0 B' : `${row.delta > 0 ? '+' : '−'}${formatBytes(Math.abs(row.delta))}`);
    tdDelta.classList.add('delta-neutral');
    tr.append(tdPath, tdA, tdB, tdDelta);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  $('#compare-empty').hidden = cmp.changedPathCount !== 0;
  const parts = [`${formatCount(cmp.changedPathCount)} path${cmp.changedPathCount === 1 ? '' : 's'} changed (${formatCount(cmp.addedPathCount)} added, ${formatCount(cmp.removedPathCount)} removed)`];
  parts.push('final manifests only — the biggest winners are the whiteouted bytes in the size deltas above');
  $('#compare-counts').textContent = parts.join(' · ');
  $('#compare-results').hidden = false;
  const title = $('#compare-results-title');
  if (title && typeof title.focus === 'function') title.focus({ preventScroll: true });
}

function swapCompareSides() {
  const { a, b } = state.compare;
  state.compare.a = b;
  state.compare.b = a;
  const statusA = $('#compare-status-a');
  const statusB = $('#compare-status-b');
  const tmpText = statusA.textContent;
  statusA.textContent = statusB.textContent;
  statusB.textContent = tmpText;
  const tmpTitle = statusA.title || '';
  statusA.title = statusB.title || '';
  statusB.title = tmpTitle;
  const tmpClass = statusA.className;
  statusA.className = statusB.className;
  statusB.className = tmpClass;
  maybeRenderCompare();
}

function openCompare() {
  showView('compare');
}

// ---------------- tabs ----------------

const tabs = ['tab-layers', 'tab-top', 'tab-wasted', 'tab-suggestions'];

function activateTab(tabId) {
  for (const id of tabs) {
    const tab = document.getElementById(id);
    const panel = document.getElementById(id.replace('tab-', 'panel-'));
    const active = id === tabId;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    panel.hidden = !active;
  }
}

// ---------------- init ----------------

function init() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Clipboard access with a non-secure-context fallback (file://, older WebViews).
async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function wireCopyButton(btn, textFn) {
  const label = btn.querySelector('.copy-btn-label');
  btn.addEventListener('click', async () => {
    const ok = await copyToClipboard(textFn());
    btn.classList.toggle('is-done', ok);
    btn.classList.toggle('is-fail', !ok);
    label.textContent = ok ? 'Copied!' : 'Ctrl+C';
    window.setTimeout(() => {
      btn.classList.remove('is-done', 'is-fail');
      label.textContent = 'Copy';
    }, 1600);
  });
}
wireCopyButton($('#ld-copy-command'), () => $('#ld-command').textContent);
wireCopyButton($('#hero-cmd-copy'), () => $('#hero-cmd').textContent);

$('#browse-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#file-input').click(); });
$('#file-input').addEventListener('change', () => {
  const file = $('#file-input').files[0];
  if (file) analyze(file, file.name);
  $('#file-input').value = '';
});

const dropzone = $('#dropzone');
dropzone.addEventListener('click', () => $('#file-input').click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); } });
for (const evt of ['dragenter', 'dragover']) {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
}
for (const evt of ['dragleave', 'drop']) {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('is-dragover'); });
}
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) analyze(file, file.name);
});

$('#sample-btn').addEventListener('click', async () => {
  const overlay = $('#progress-overlay');
  overlay.hidden = false;
  setProgress(0.05, 'Loading sample image…', 'bundled layerscope/sample:latest');
  try {
    const res = await fetch('assets/samples/layerscope-demo.tar', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`sample archive failed to load (HTTP ${res.status})`);
    const sample = await res.blob();
    await analyze(sample, 'layerscope/sample:latest');
  } catch (err) {
    console.error(err);
    overlay.hidden = true;
    showView('landing');
    showError(`Sample image could not be loaded: ${err && err.message ? err.message : err}`);
  }
});

$('#analyze-another').addEventListener('click', () => showView('landing'));

$('#export-json').addEventListener('click', () => exportAnalysis('json'));
$('#export-csv').addEventListener('click', () => exportAnalysis('csv'));

// --- compare mode ---
$('#compare-btn').addEventListener('click', openCompare);
$('#compare-back').addEventListener('click', () => showView('landing'));
$('#compare-swap').addEventListener('click', swapCompareSides);

for (const side of ['a', 'b']) {
  const drop = $(`#compare-drop-${side}`);
  const input = $(`#compare-file-${side}`);
  const browse = $(`#compare-browse-${side}`);
  browse.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) enqueueCompare(side, file);
    input.value = '';
  });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  for (const evt of ['dragenter', 'dragover']) {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('is-dragover'); });
  }
  for (const evt of ['dragleave', 'drop']) {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('is-dragover'); });
  }
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) enqueueCompare(side, file);
  });
}

for (const id of tabs) document.getElementById(id).addEventListener('click', () => activateTab(id));

$('#ld-filter').addEventListener('input', (e) => { state.fileFilter = e.target.value; renderFileList(); });
$('#ld-kind').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.fileKind = btn.dataset.kind;
  $$('#ld-kind .seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  renderFileList();
});

$('#top-scope').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.topScope = btn.dataset.scope;
  $$('#top-scope .seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  renderTopFiles();
});

$('#wasted-filter').addEventListener('input', (e) => { state.wastedFilter = e.target.value; renderWasted(); });
}

if (typeof document !== 'undefined') {
  init();
}
