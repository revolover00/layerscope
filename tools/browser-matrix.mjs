#!/usr/bin/env node
// Browser-compatibility matrix runner (TASK 4, part A). Measures the site in
// REAL engines via playwright-core: Chromium, Firefox and WebKit. Nothing in
// src/ or index.html is modified — this is a read-only probe.
//
// Per engine, on desktop (1440x900) and mobile (390x844):
//   1. landing page loads; #sample-btn visible + enabled;
//   2. "Try a sample image" click drives a real analysis to completion;
//   3. test1-waste.tar (legacy) and test3-zstd.tar (OCI + zstd) analyze to the
//      exact expected numbers, three uploads per page, all identical;
//   4. test4-longname.tar: the 78-char repository tag never leaks into the
//      summary-stats card (text/title/ellipsis/no overlap);
//   5. the fzstd fallback path works with native zstd DecompressionStream
//      disabled (forced by init script; gzip DecompressionStream kept);
//   6. console/page errors are collected everywhere.
//
// Screenshots (per check) and a JSON result file land in --out for artifact
// upload. Every check is attempted independently (failures are recorded, not
// thrown) so one run reports the full picture. Exit code 0 = all checks pass.
//
// Usage:
//   node tools/browser-matrix.mjs --browser chromium|firefox|webkit --url URL
//      --test1 tar --test3 tar --longname tar --out DIR

import { chromium, firefox, webkit } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LONG_TAG } from './test-fixtures.mjs';

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const browserName = getArg('--browser');
const url = getArg('--url') || 'http://127.0.0.1:8323';
const test1 = getArg('--test1');
const test3 = getArg('--test3');
const longname = getArg('--longname');
const outDir = getArg('--out');
for (const [flag, value] of [['--browser', browserName], ['--url', url], ['--test1', test1], ['--test3', test3], ['--longname', longname], ['--out', outDir]]) {
  if (!value) { console.error(`usage: --browser chromium|firefox|webkit --url URL --test1 tar --test3 tar --longname tar --out DIR (missing ${flag})`); process.exit(2); }
}
for (const [label, p] of [['test1', test1], ['test3', test3], ['longname', longname]]) {
  if (!existsSync(p)) { console.error(`${label} fixture not found: ${p}`); process.exit(2); }
}
const engines = { chromium, firefox, webkit };
const engine = engines[browserName];
if (!engine) { console.error(`--browser must be one of chromium, firefox, webkit (got '${browserName}')`); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const EXPECTED = {
  layers: '4 layers',
  wasted: '5.39 MB',       // 5,652,480 bytes
  reclaimable: '5.20 MB',  // 5,447,680 bytes
  efficiency: '3.6%',      // 3.6248%
};

const checks = [];
const screenshots = [];
const consoleErrors = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, status: ok ? 'pass' : 'fail', detail });
  console.log(`::${ok ? 'notice' : 'error'}::browser-matrix ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
};
const shot = async (page, name) => {
  const file = join(outDir, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    screenshots.push(`${name}.png`);
  } catch (e) {
    console.log(`::notice::browser-matrix screenshot ${name}.png failed: ${e.message}`);
  }
};
const shortErr = (e) => String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 500);

let browser;
try {
  browser = await engine.launch();
} catch (e) {
  const msg = `browser launch failed (${browserName}): ${shortErr(e)} — is the browser installed? (npx playwright-core install --with-deps ${browserName})`;
  console.error(`::error::browser-matrix ${msg}`);
  writeFileSync(join(outDir, `browser-matrix-${browserName}.json`), `${JSON.stringify({
    browser: browserName, url, nativeZstd: null, os: process.platform,
    totals: { pass: 0, fail: 1, all: 1 },
    checks: [{ name: 'launch', status: 'fail', detail: msg }],
    consoleErrors: [], screenshots: [],
  }, null, 2)}\n`);
  process.exit(2);
}

// Native zstd probe on a clean page (no init script).
const nativeZstd = await (async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    return await page.evaluate(() => {
      try {
        // eslint-disable-next-line no-undef
        if (typeof DecompressionStream !== 'function') return false;
        // eslint-disable-next-line no-undef
        new DecompressionStream('zstd');
        return true;
      } catch {
        return false;
      }
    });
  } catch (e) {
    return null; // could not determine — engine never loaded the page
  } finally {
    await page.close();
  }
})();
console.log(`::notice::browser-matrix native-zstd-stream[${browserName}]=${nativeZstd}`);

const withPage = async (label, viewport, fn, { disableZstd = false } = {}) => {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  if (disableZstd) {
    await page.addInitScript(() => {
      try {
        const Native = window.DecompressionStream;
        if (typeof Native === 'function') {
          const Forced = function (format, options) {
            if (String(format).toLowerCase() === 'zstd') {
              throw new TypeError('zstd streaming disabled for browser-matrix (forced fzstd fallback)');
            }
            // called with `new`; must return an object — return the native one
            return new Native(format, options);
          };
          Forced.prototype = Native.prototype;
          window.DecompressionStream = Forced;
        }
        // no DecompressionStream at all => app already takes the fzstd path
      } catch { /* probe below records the truth */ }
    });
  }
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await fn(page, errors);
  } catch (e) {
    record(label, false, shortErr(e));
    await shot(page, `${label.replace(/[^a-z0-9-]+/gi, '_')}-error`);
  } finally {
    consoleErrors.push(...errors.map((e) => `[${label}] ${e}`));
    await page.close();
  }
};

const waitForAnalysis = async (page, imgLabel) => {
  const outcome = await Promise.race([
    page.waitForFunction(() => {
      const a = document.getElementById('analysis');
      const o = document.getElementById('progress-overlay');
      return a && !a.hidden && o && o.hidden;
    }, null, { timeout: 120000, polling: 100 }).then(() => 'ok'),
    page.waitForSelector('#error-box', { state: 'visible', timeout: 120000 }).then(() => 'error'),
  ]);
  if (outcome === 'error') {
    const text = await page.$eval('#error-box', (el) => el.textContent.trim());
    throw new Error(`analysis failed (${imgLabel}): ${text}`);
  }
};
const dumpStats = () => (page) => page.evaluate(() => ({
  chipLayers: document.getElementById('chip-layers')?.textContent ?? null,
  statWasted: document.getElementById('stat-wasted')?.textContent ?? null,
  wsWasted: document.getElementById('ws-wasted')?.textContent ?? null,
  statReclaimable: document.getElementById('stat-reclaimable')?.textContent ?? null,
  wsReclaimable: document.getElementById('ws-reclaimable')?.textContent ?? null,
  gaugeValue: document.getElementById('gauge-value')?.textContent ?? null,
  wsEfficiency: document.getElementById('ws-efficiency')?.textContent ?? null,
}));
const statsMatch = (dump) =>
  dump.chipLayers === EXPECTED.layers &&
  dump.statWasted === EXPECTED.wasted &&
  dump.wsWasted === EXPECTED.wasted &&
  dump.statReclaimable === EXPECTED.reclaimable &&
  dump.wsReclaimable === EXPECTED.reclaimable &&
  dump.gaugeValue === EXPECTED.efficiency &&
  dump.wsEfficiency === EXPECTED.efficiency;

const fixtureRun = async (page, viewportLabel, img, tag) => {
  const dumps = [];
  for (let run = 1; run <= 3; run++) {
    if (run > 1) {
      await page.click('#analyze-another');
      await page.waitForFunction(() => !document.getElementById('landing').hidden, null, { timeout: 30000, polling: 100 });
    }
    await page.setInputFiles('#file-input', img);
    await waitForAnalysis(page, tag);
    dumps.push(await dumpStats()(page));
    console.log(`::notice::browser-matrix ${browserName} ${viewportLabel} ${tag} run${run}: ${JSON.stringify(dumps[run - 1])}`);
  }
  const allExpected = dumps.every(statsMatch);
  record(`${viewportLabel} ${tag} exact-3/3`, allExpected, allExpected ? '' : `runs: ${JSON.stringify(dumps)}`);
  const identical = dumps.every((d) => JSON.stringify(d) === JSON.stringify(dumps[0]));
  record(`${viewportLabel} ${tag} identical-runs`, identical, identical ? '' : `runs differ: ${JSON.stringify(dumps)}`);
};

for (const [viewportLabel, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  await withPage(`${viewportLabel} landing`, viewport, async (page) => {
    const btn = page.locator('#sample-btn');
    const visible = await btn.isVisible();
    const enabled = await btn.isEnabled();
    await shot(page, `${viewportLabel}-landing`);
    record(`${viewportLabel} landing-idle`, visible && enabled, `#sample-btn visible=${visible} enabled=${enabled}`);
  });

  await withPage(`${viewportLabel} sample`, viewport, async (page) => {
    await page.click('#sample-btn');
    await waitForAnalysis(page, 'sample');
    const chips = await page.evaluate(() => document.getElementById('chip-layers')?.textContent ?? null);
    await shot(page, `${viewportLabel}-sample`);
    record(`${viewportLabel} sample-analysis`, chips === '4 layers', `chip-layers=${JSON.stringify(chips)}`);
  });

  await withPage(`${viewportLabel} test1`, viewport, async (page) => {
    await fixtureRun(page, viewportLabel, test1, 'test1-waste');
    await shot(page, `${viewportLabel}-test1`);
  });

  await withPage(`${viewportLabel} test3`, viewport, async (page) => {
    await fixtureRun(page, viewportLabel, test3, 'test3-zstd');
    await shot(page, `${viewportLabel}-test3`);
  });

  await withPage(`${viewportLabel} longname`, viewport, async (page) => {
    await page.setInputFiles('#file-input', longname);
    await waitForAnalysis(page, 'longname');
    const r = await page.evaluate(() => {
      const nameEl = document.getElementById('image-name');
      const stats = document.querySelector('.summary-stats');
      const n = nameEl.getBoundingClientRect();
      const st = stats.getBoundingClientRect();
      const cs = window.getComputedStyle(nameEl);
      // True rect intersection works on the desktop side-by-side layout AND
      // the <=1080px single-column layout (horizontal "right <= statsLeft"
      // only makes sense when both sit in one row).
      const intersects = !(n.right <= st.left || st.right <= n.left || n.bottom <= st.top || st.bottom <= n.top);
      const clipped = n.left < -1 || n.right > window.innerWidth + 1;
      return {
        text: nameEl.textContent,
        title: nameEl.getAttribute('title'),
        nameRect: { left: Math.round(n.left), right: Math.round(n.right), top: Math.round(n.top), bottom: Math.round(n.bottom) },
        statsRect: { left: Math.round(st.left), right: Math.round(st.right), top: Math.round(st.top), bottom: Math.round(st.bottom) },
        rectIntersects: intersects,
        viewportClipped: clipped,
        whiteSpace: cs.whiteSpace,
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
      };
    });
    const ok =
      r.text === LONG_TAG &&
      r.title === LONG_TAG &&
      !r.rectIntersects &&
      !r.viewportClipped &&
      r.whiteSpace === 'nowrap' &&
      r.overflow === 'hidden' &&
      r.textOverflow === 'ellipsis';
    await shot(page, `${viewportLabel}-longname`);
    record(`${viewportLabel} longname-header`, ok, ok ? '' : JSON.stringify(r));
  });
}

// Forced fzstd-fallback pass: native zstd DecompressionStream is disabled by
// an init script (gzip kept). Desktop only — this checks the decoder path,
// not layout; it runs even when the engine ships native zstd.
await withPage('fallback test3', { width: 1440, height: 900 }, async (page) => {
  await page.setInputFiles('#file-input', test3);
  await waitForAnalysis(page, 'test3 (forced fzstd fallback)');
  const dump = await dumpStats()(page);
  const ok = statsMatch(dump);
  await shot(page, 'fallback-test3');
  record('fallback-forced-zstd', ok, ok ? '' : JSON.stringify(dump));
}, { disableZstd: true });

await browser.close();

record('no-console-errors', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(' | ').slice(0, 1200) : '');

const failed = checks.filter((c) => c.status === 'fail');
const result = {
  browser: browserName,
  url,
  nativeZstd,
  os: process.platform,
  totals: { pass: checks.length - failed.length, fail: failed.length, all: checks.length },
  checks,
  consoleErrors,
  screenshots,
};
writeFileSync(join(outDir, `browser-matrix-${browserName}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(`::notice::browser-matrix ${browserName}: ${checks.length - failed.length}/${checks.length} checks passed; native-zstd=${nativeZstd}; consoleErrors=${consoleErrors.length}`);
if (failed.length) process.exit(1);
