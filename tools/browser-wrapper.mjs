#!/usr/bin/env node
// Outer-wrapper (.tar.gz) equivalence, self-consistent IN THE BROWSER:
// uploads a fixture twice in one Chromium session — once plain, once as a
// gzip-wrapped .tar.gz of the same docker save — and asserts the rendered
// analysis numbers are byte-identical. Both runs must be error-free.
//
//   node tools/browser-wrapper.mjs --url http://127.0.0.1:8321 \
//     --image /tmp/bench/test1-waste.tar --wrapped /tmp/bench/test1-waste.tar.gz
// Exits non-zero on any mismatch, error box, or console/page error.

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const url = getArg('--url') || 'http://127.0.0.1:8321';
const image = getArg('--image');
const wrapped = getArg('--wrapped');
if (!image || !wrapped) { console.error('usage: node tools/browser-wrapper.mjs --url URL --image TAR --wrapped TAR.GZ'); process.exit(2); }
for (const [label, p] of [['--image', image], ['--wrapped', wrapped]]) {
  if (!existsSync(p)) { console.error(`${label} not found: ${p}`); process.exit(2); }
}

const DESKTOP = { width: 1440, height: 900 };
const browser = await chromium.launch();
const failures = [];

async function analyzeOnce(file) {
  const page = await browser.newPage({ viewport: DESKTOP });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.setInputFiles('#file-input', file);
  const t0 = Date.now();
  const outcome = await Promise.race([
    page.waitForFunction(() => {
      const a = document.getElementById('analysis');
      const o = document.getElementById('progress-overlay');
      return a && !a.hidden && o && o.hidden;
    }, null, { timeout: 5 * 60 * 1000, polling: 100 }).then(() => 'ok'),
    page.waitForSelector('#error-box', { state: 'visible', timeout: 5 * 60 * 1000 }).then(() => 'error'),
  ]);
  const elapsedMs = Date.now() - t0;
  if (outcome !== 'ok') {
    const text = await page.$eval('#error-box', (el) => el.textContent.trim()).catch(() => '(no error box text)');
    await page.close();
    return { outcome, elapsedMs, consoleErrors, display: null, errorText: text };
  }
  const display = await page.evaluate(() => ({
    chipLayers: document.getElementById('chip-layers')?.textContent ?? null,
    statTotal: document.getElementById('stat-total')?.textContent ?? null,
    statWasted: document.getElementById('stat-wasted')?.textContent ?? null,
    statReclaimable: document.getElementById('stat-reclaimable')?.textContent ?? null,
    gaugeValue: document.getElementById('gauge-value')?.textContent ?? null,
    wsEfficiency: document.getElementById('ws-efficiency')?.textContent ?? null,
    wsWasted: document.getElementById('ws-wasted')?.textContent ?? null,
    wsReclaimable: document.getElementById('ws-reclaimable')?.textContent ?? null,
    wsPaths: document.getElementById('ws-paths')?.textContent ?? null,
  }));
  await page.close();
  return { outcome, elapsedMs, consoleErrors, display, errorText: null };
}

const plain = await analyzeOnce(image);
console.log(`::notice::browser-wrapper plain  outcome=${plain.outcome} elapsedMs=${plain.elapsedMs} consoleErrors=${plain.consoleErrors.length}`);
const via = await analyzeOnce(wrapped);
console.log(`::notice::browser-wrapper wrapped outcome=${via.outcome} elapsedMs=${via.elapsedMs} consoleErrors=${via.consoleErrors.length}`);
console.log(`::notice::browser-wrapper display(plain)   ${JSON.stringify(plain.display)}`);
console.log(`::notice::browser-wrapper display(wrapped) ${JSON.stringify(via.display)}`);

if (plain.outcome !== 'ok') failures.push(`plain fixture failed: ${plain.errorText}`);
if (via.outcome !== 'ok') failures.push(`wrapped fixture failed: ${via.errorText}`);
if (plain.consoleErrors.length) failures.push(`plain console/page errors: ${plain.consoleErrors.join(' | ')}`);
if (via.consoleErrors.length) failures.push(`wrapped console/page errors: ${via.consoleErrors.join(' | ')}`);
if (plain.display && via.display) {
  for (const key of Object.keys(plain.display)) {
    if (plain.display[key] !== via.display[key]) {
      failures.push(`${key}: plain=${JSON.stringify(plain.display[key])} wrapped=${JSON.stringify(via.display[key])}`);
    }
  }
}

await browser.close();
if (failures.length) {
  console.error(`BROWSER WRAPPER TEST FAILED — ${failures.join(' || ')}`);
  process.exit(1);
}
console.log('::notice::browser-wrapper PASS — plain and .tar.gz analyses are identical');
