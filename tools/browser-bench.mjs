#!/usr/bin/env node
// Real-browser benchmark for layerscope's analysis path.
//
// Drives headless Chromium (playwright-core) against the locally served site,
// uploads an image archive through the real file input, and measures
// wall-clock time from upload to the analysis view being fully rendered:
//   cold — first analysis in the page (includes fetching + compiling +
//          initializing the vendored WASM decoder, which only happens on the
//          first zstd layer)
//   warm — second analysis of the same image (module already initialized)
//
// Usage:
//   node tools/browser-bench.mjs --url http://127.0.0.1:8321 --image /path/a.tar [--image /path/b.tar]
// Exits non-zero if any console/page error occurs during the run.

import { chromium } from 'playwright-core';
import { statSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const url = urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8321';
const images = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--image') images.push(args[i + 1]);
if (images.length === 0) { console.error('usage: node tools/browser-bench.mjs --url URL --image tar [--image tar...]'); process.exit(2); }
for (const img of images) if (!existsSync(img)) { console.error(`image not found: ${img}`); process.exit(2); }

const browser = await chromium.launch();
let anyErrors = false;
const results = [];

for (const imagePath of images) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  const waitForAnalysis = () => page.waitForFunction(() => {
    const a = document.getElementById('analysis');
    const o = document.getElementById('progress-overlay');
    return a && !a.hidden && o && o.hidden;
  }, null, { timeout: 600000, polling: 100 });

  // ---- cold: first analysis in this page (WASM fetch + compile + init included)
  const coldT0 = Date.now();
  await page.setInputFiles('#file-input', imagePath);
  await waitForAnalysis();
  const coldMs = Date.now() - coldT0;
  const afterCold = await page.evaluate(() => ({
    heapUsedMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    totalHeapMB: performance.memory ? +(performance.memory.totalJSHeapSize / 1048576).toFixed(1) : null,
    imageName: document.getElementById('image-name')?.textContent || null,
    chipLayers: document.getElementById('chip-layers')?.textContent || null,
    efficiencyState: document.getElementById('gauge-value')?.textContent || null,
  }));

  // ---- warm: back to landing, analyze the same archive again (module already loaded)
  await page.click('#analyze-another');
  await page.waitForFunction(() => !document.getElementById('landing').hidden, null, { timeout: 30000, polling: 100 });
  const warmT0 = Date.now();
  await page.setInputFiles('#file-input', imagePath);
  await waitForAnalysis();
  const warmMs = Date.now() - warmT0;
  const afterWarm = await page.evaluate(() => ({
    heapUsedMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  }));

  const result = {
    image: imagePath,
    bytes: statSync(imagePath).size,
    coldMs,
    warmMs,
    chromiumJsHeapMB_afterCold: afterCold.heapUsedMB,
    chromiumTotalHeapMB_afterCold: afterCold.totalHeapMB,
    chromiumJsHeapMB_afterWarm: afterWarm.heapUsedMB,
    imageName: afterCold.imageName,
    chipLayers: afterCold.chipLayers,
    gauge: afterCold.efficiencyState,
    consoleErrors,
    note: 'chromiumJsHeapMB is the JS heap only — WASM linear memory is NOT included in performance.memory',
  };
  results.push(result);
  if (consoleErrors.length) anyErrors = true;
  console.log(JSON.stringify(result));
  // Surface the headline numbers as a check-run annotation so they are visible
  // without log access (job logs may be permission-gated).
  console.log(`::notice::browser-bench ${imagePath} bytes=${result.bytes} cold=${coldMs}ms warm=${warmMs}ms jsHeapMB_afterCold=${result.chromiumJsHeapMB_afterCold} jsHeapMB_afterWarm=${result.chromiumJsHeapMB_afterWarm} gauge=${result.gauge} chips=${result.chipLayers} consoleErrors=${consoleErrors.length}`);
  await page.close();
}

await browser.close();
if (anyErrors) {
  console.error('console/page errors observed during the run — see consoleErrors above');
  process.exit(1);
}
