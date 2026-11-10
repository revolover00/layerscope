#!/usr/bin/env node
// Captures PR-preview screenshots of the three post-launch features
// (Suggestions tab, Compare view, Export actions) at desktop (1280x800) and
// mobile (390x844) widths. These are reviewer conveniences, not assertions —
// the numbers are verified by tools/browser-fixtures.mjs in the same job.
//
// Usage:
//   node tools/capture-ui-screenshots.mjs --url http://127.0.0.1:8321 \
//     --test5 /tmp/bench/test5-compare-a.tar --test6 /tmp/bench/test6-compare-b.tar \
//     --out-dir ui-screenshots
//
// Exits non-zero if any screenshot cannot be captured.

import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const url = getArg('--url') || 'http://127.0.0.1:8321';
const test5 = getArg('--test5');
const test6 = getArg('--test6');
const outDir = getArg('--out-dir') || 'ui-screenshots';
if (!test5 || !test6) { console.error('usage: node tools/capture-ui-screenshots.mjs --url URL --test5 tar --test6 tar [--out-dir dir]'); process.exit(2); }
if (!existsSync(test5)) { console.error(`test5-compare-a.tar not found: ${test5}`); process.exit(2); }
if (!existsSync(test6)) { console.error(`test6-compare-b.tar not found: ${test6}`); process.exit(2); }

mkdirSync(outDir, { recursive: true });
const VIEWPORTS = [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
];

const waitForAnalysis = async (page) => {
  const outcome = await Promise.race([
    page.waitForFunction(() => {
      const a = document.getElementById('analysis');
      const o = document.getElementById('progress-overlay');
      return a && !a.hidden && o && o.hidden;
    }, null, { timeout: 600000, polling: 100 }).then(() => 'ok'),
    page.waitForSelector('#error-box', { state: 'visible', timeout: 600000 }).then(() => 'error'),
  ]);
  if (outcome === 'error') {
    const text = await page.$eval('#error-box', (el) => el.textContent.trim());
    throw new Error(`analysis failed in the browser: ${text}`);
  }
};

const browser = await chromium.launch();
let failures = 0;

for (const [label, viewport] of VIEWPORTS) {
  // --- suggestions: demo sample analyzed, Suggestions tab active ---
  {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.click('#sample-btn');
      await waitForAnalysis(page);
      await page.click('#tab-suggestions');
      await page.waitForFunction(() => !document.getElementById('panel-suggestions').hidden, null, { timeout: 30000 });
      await page.locator('#panel-suggestions').screenshot({ path: join(outDir, `suggestions-${label}.png`) });
      console.log(`::notice::screenshot suggestions-${label}.png captured`);
    } catch (e) {
      failures++;
      console.error(`::error::screenshot suggestions-${label}: ${e.message}`);
    }
    await page.close();
  }

  // --- compare: known-delta fixture pair, results rendered ---
  {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.click('#compare-btn');
      await page.waitForFunction(() => !document.getElementById('compare').hidden, null, { timeout: 30000 });
      await page.setInputFiles('#compare-file-a', test5);
      await page.setInputFiles('#compare-file-b', test6);
      const outcome = await Promise.race([
        page.waitForFunction(() => {
          const r = document.getElementById('compare-results');
          const o = document.getElementById('progress-overlay');
          return r && !r.hidden && o && o.hidden;
        }, null, { timeout: 600000, polling: 100 }).then(() => 'ok'),
        page.waitForSelector('#compare-error', { state: 'visible', timeout: 600000 }).then(() => 'error'),
      ]);
      if (outcome === 'error') {
        const text = await page.$eval('#compare-error', (el) => el.textContent.trim());
        throw new Error(`compare analysis failed in the browser: ${text}`);
      }
      await page.locator('#compare').screenshot({ path: join(outDir, `compare-${label}.png`) });
      console.log(`::notice::screenshot compare-${label}.png captured`);
    } catch (e) {
      failures++;
      console.error(`::error::screenshot compare-${label}: ${e.message}`);
    }
    await page.close();
  }

  // --- export: analysis view with the Export actions in the summary bar ---
  {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.click('#sample-btn');
      await waitForAnalysis(page);
      await page.locator('.summary-bar').screenshot({ path: join(outDir, `export-${label}.png`) });
      console.log(`::notice::screenshot export-${label}.png captured`);
    } catch (e) {
      failures++;
      console.error(`::error::screenshot export-${label}: ${e.message}`);
    }
    await page.close();
  }
}

await browser.close();
if (failures > 0) {
  console.error(`capture-ui-screenshots FAILED with ${failures} failure(s)`);
  process.exit(1);
}
console.log('::notice::capture-ui-screenshots PASS — 6 screenshots written to ' + outDir);
