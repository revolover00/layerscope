import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import nodeCrypto from 'node:crypto';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://revolover00.github.io/layerscope/', pretendToBeVisual: true });
const { window } = dom;

window.scrollTo = () => {};
window.Blob = Blob;
try { Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto }); } catch { /* keep jsdom default */ }
try { Object.defineProperty(window, 'DecompressionStream', { value: DecompressionStream }); } catch { /* optional */ }

// node 22 provides Blob, crypto (webcrypto), DecompressionStream and navigator globally
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

await import(new URL('../src/app.js', import.meta.url));
console.log('app.js init() ran');

const $ = (id) => window.document.getElementById(id);
const assert = (cond, msg) => { if (!cond) { console.error('SMOKE FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

assert(!$('analysis').hidden === false, 'analysis hidden initially');
assert($('landing').hidden === false, 'landing visible initially');
assert($('progress-overlay').hidden === true, 'progress overlay hidden initially');

$('demo-btn').click();

let ready = false;
for (let i = 0; i < 400; i++) {
  await new Promise((r) => setTimeout(r, 50));
  if ($('analysis').hidden === false) { ready = true; break; }
}
assert(ready, 'analysis view shown after demo analysis');
assert($('progress-overlay').hidden === true, 'progress overlay hidden after analysis');

if (ready) {
  assert($('image-name').textContent.includes('layerscope/demo'), `image name rendered: ${$('image-name').textContent}`);
  assert($('chip-layers').textContent.includes('4'), `chip layers: ${$('chip-layers').textContent}`);
  const layerRows = window.document.querySelectorAll('#layer-table tbody tr');
  assert(layerRows.length === 4, `layer table rows: ${layerRows.length}`);
  const gauge = $('gauge-fill').style.strokeDashoffset;
  assert(gauge && parseFloat(gauge) < 326.7, `gauge offset animated target: ${gauge}`);
  assert($('stat-wasted').textContent.length > 0, `wasted stat: ${$('stat-wasted').textContent}`);

  // layer detail defaults to layer 0
  assert($('ld-command').textContent.includes('echo'), `layer command: ${$('ld-command').textContent}`);
  const fileRows = window.document.querySelectorAll('#ld-file-list .file-row');
  assert(fileRows.length > 0, `file rows rendered for layer 0: ${fileRows.length}`);

  // select layer 2 (index 2) and count deleted rows
  const tr = window.document.querySelector('#layer-table tbody tr[data-index="2"]');
  tr.click();
  const deletedChip = $('cnt-deleted').textContent;
  console.log('   layer 2 counts:', deletedChip, '| added:', $('cnt-added').textContent, '| modified:', $('cnt-modified').textContent);
  assert(/1 deleted|[1-9]\d* deleted/.test(deletedChip), `deleted count non-zero: ${deletedChip}`);

  // wasted tab
  $('tab-wasted').click();
  assert(!$('panel-wasted').hidden, 'wasted panel visible after tab click');
  assert($('panel-layers').hidden, 'layers panel hidden after tab click');
  const wasteRows = window.document.querySelectorAll('#wasted-tbody tr');
  const emptyHidden = $('wasted-empty').hidden;
  console.log(`   wasted rows: ${wasteRows.length} | empty-state hidden: ${emptyHidden} | efficiency: ${$('ws-efficiency').textContent} | wasted: ${$('ws-wasted').textContent}`);
  assert(wasteRows.length > 0 || !emptyHidden, 'wasted panel has rows or empty state');
  assert($('ws-wasted').textContent.trim().length > 0, `wasted scorecard: ${$('ws-wasted').textContent}`);

  // top files tab
  $('tab-top').click();
  assert(!$('panel-top').hidden, 'top panel visible');
  const topRows = window.document.querySelectorAll('#top-tbody tr');
  assert(topRows.length >= 1 && topRows.length <= 20, `top files rows within range: ${topRows.length}`);
  assert(topRows.length === 6, `demo image has exactly 6 largest-entry rows (whiteouts excluded): ${topRows.length}`);
  console.log('   top file row 1:', window.document.querySelector('#top-tbody tr').textContent.replace(/\s+/g, ' ').trim());

  // switch top scope to final image
  const finalBtn = window.document.querySelector('#top-scope .seg-btn[data-scope="final"]');
  finalBtn.click();
  const topRowsFinal = window.document.querySelectorAll('#top-tbody tr');
  assert(topRowsFinal.length > 0, `final-scope rows: ${topRowsFinal.length}`);
  assert($('top-col-context').textContent === 'Type', `context column header: ${$('top-col-context').textContent}`);

  // wasted filter narrows rows
  $('tab-wasted').click();
  const filter = $('wasted-filter');
  filter.value = 'data.bin';
  filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  const filtered = window.document.querySelectorAll('#wasted-tbody tr');
  console.log(`   wasted rows matching "data.bin": ${filtered.length}`);
  assert(filtered.length >= 1, 'wasted filter keeps matching rows');
}

console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
process.exit(process.exitCode || 0);
