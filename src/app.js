// layerscope — UI orchestration. All analysis happens locally in the tab.

import { analyzeImage } from './core/analyze.js';
import { formatBytes, formatPercent, formatCount, formatPercentBig } from './core/format.js';
import { buildDemoImage } from './demo.js';

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
    $('#landing .hero').appendChild(box);
  }
  box.innerHTML = '';
  const title = el('strong', '', 'Could not analyze that archive. ');
  box.appendChild(title);
  box.appendChild(document.createTextNode(message));
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------- analysis flow ----------------

async function analyze(blob, label) {
  const overlay = $('#progress-overlay');
  overlay.hidden = false;
  setProgress(0.02, 'Reading archive index…', label || '');

  try {
    const analysis = await analyzeImage(blob, {
      topLimit: 20,
      onProgress: (p) => {
        if (p.phase === 'scan') setProgress(0.06, p.detail || 'Reading archive index…', label);
        else if (p.phase === 'layer') {
          const frac = 0.1 + 0.82 * ((p.index + (p.done ? 1 : 0)) / Math.max(1, p.total));
          setProgress(frac, p.detail || `Layer ${p.index + 1}/${p.total}`, label);
        } else if (p.phase === 'finalize') setProgress(0.95, 'Computing efficiency…', label);
      },
    });
    state.analysis = analysis;
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

// ---------------- render: overview ----------------

function renderAnalysis(a, label) {
  $('#image-name').textContent = a.imageName || label || 'unnamed image';
  $('#chip-format').textContent = a.format;
  $('#chip-layers').textContent = `${a.layerCount} layer${a.layerCount === 1 ? '' : 's'}`;
  $('#chip-compressed').textContent = `${formatBytes(a.compressedArchiveBytes)} archive`;

  $('#stat-total').textContent = formatBytes(a.totalSizeBytes);
  $('#stat-wasted').textContent = formatBytes(a.wastedBytes);

  // gauge
  const score = a.efficiency;
  const gauge = $('#gauge-fill');
  const C = 326.7;
  gauge.style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, score))));
  gauge.classList.remove('good', 'ok', 'bad');
  gauge.classList.add(score >= 0.95 ? 'good' : score >= 0.8 ? 'ok' : 'bad');
  $('#gauge-value').textContent = `${(score * 100).toFixed(1)}%`;

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
    const tdBar = el('td');
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
    const kind = el('span', `file-kind kind-${r.kind}`, r.kind.toUpperCase().slice(0, 4));
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

// ---------------- tabs ----------------

const tabs = ['tab-layers', 'tab-top', 'tab-wasted'];

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

$('#demo-btn').addEventListener('click', async () => {
  const overlay = $('#progress-overlay');
  overlay.hidden = false;
  setProgress(0.05, 'Building demo image…', 'synthetic docker save archive');
  try {
    const demo = await buildDemoImage();
    await analyze(demo, 'layerscope/demo:latest');
  } catch (err) {
    console.error(err);
    overlay.hidden = true;
    showError(`Demo image could not be built: ${err.message}`);
  }
});

$('#analyze-another').addEventListener('click', () => showView('landing'));

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
