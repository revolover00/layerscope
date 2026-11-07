#!/usr/bin/env node
// Records a short demo video of layerscope analyzing a deliberately wasteful
// image end to end, for the README GIF. Runs in CI (workflow record-demo.yml)
// against the statically served site; nothing is uploaded anywhere.
//
// Video timeline (target 20–25 s, fps=10 for the GIF):
//   1.5 s on the landing page → upload → analysis (progress overlay visible)
//   + ~0.4 s gauge settle + 4.0 s summary hold (Total / Wasted / Reclaimable / efficiency)
//   + 3 × (layer click + "Added" chip + smooth scroll + 2.1 s hold)
//   + Top 20 files tab (scroll + 3.0 s) + Wasted space tab (scroll + 4.0 s)
// Phase markers are printed so the conversion step (and human review) can
// reason about the timeline. Panels that overflow the viewport are brought
// fully into view with one smooth scrollIntoView; no scrolling elsewhere.
//
// Usage:
//   node tools/record-demo.mjs --url http://127.0.0.1:8321 --image /tmp/demo-recording/demo-waste.tar [--out-dir /tmp/layerscope-demo-rec]
// Prints one DEMO_VIDEO <path> line with the recorded webm after the context closes.

import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const url = getArg('--url') ?? 'http://127.0.0.1:8321';
const image = getArg('--image') ?? 'assets/samples/layerscope-demo.tar';
const outDir = getArg('--out-dir') ?? '/tmp/layerscope-demo-rec';
if (!existsSync(image)) { console.error(`image not found: ${image}`); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const mark = (label) => console.log(`DEMO_PHASE +${Date.now() - t0}ms ${label}`);
const SCROLL_MS = 750;
const scrollEnd = async (page, sel) => {
  // one smooth scroll so the panel's bottom edge is fully visible; then the
  // caller holds still, so the frames stay jitter-free
  await page.evaluate((s) => {
    const t = document.querySelector(s);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, sel);
  await page.waitForTimeout(SCROLL_MS);
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 1,
    recordVideo: { dir: outDir, size: { width: 1100, height: 800 } },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#dropzone', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1500); // breathe on the landing page before upload
  mark('page-open');

  await page.setInputFiles('#file-input', image);
  mark('upload-sent');

  const outcome = await Promise.race([
    page.waitForFunction(() => {
      const a = document.getElementById('analysis');
      const o = document.getElementById('progress-overlay');
      return a && !a.hidden && o && o.hidden;
    }, null, { timeout: 240000, polling: 100 }).then(() => 'ok'),
    page.waitForSelector('#error-box', { state: 'visible', timeout: 240000 }).then(() => 'error'),
  ]);
  if (outcome === 'error') {
    const msg = await page.$eval('#error-box', (el) => el.textContent.trim());
    throw new Error(`analysis failed in the browser: ${msg}`);
  }
  mark('analysis-done');

  // let gauges/counters settle, then hold the summary for ~4.0 s
  await page.waitForTimeout(400);
  await page.waitForTimeout(4000);
  mark('summary-pause');

  const rows = page.locator('#layer-table tbody tr');
  const rowCount = await rows.count();
  for (let i = 0; i < Math.min(3, rowCount); i++) {
    await rows.nth(i).click();
    // show real files in the diff list (first rows default to "MODIFIED /" whiteout rows)
    await page.locator('#ld-kind button[data-kind="added"]').click();
    await page.waitForTimeout(150);
    // layer detail panel bottom (file list) fully in view before the hold
    await scrollEnd(page, '#ld-file-list');
    await page.waitForTimeout(2100);
    mark(`layer-${i + 1}`);
  }

  await page.click('#tab-top');
  await page.waitForTimeout(150);
  await scrollEnd(page, '#panel-top .table-scroll');
  await page.waitForTimeout(3000);
  mark('tab-top');

  await page.click('#tab-wasted');
  await page.waitForTimeout(150);
  await scrollEnd(page, '#panel-wasted .table-scroll');
  await page.waitForTimeout(4000);
  mark('tab-wasted');

  const video = page.video();
  await page.close();
  await context.close();
  const videoPath = video ? await video.path() : null;
  mark('stopped');
  if (videoPath) console.log(`DEMO_VIDEO ${path.resolve(videoPath)}`);
  else { console.error('no recorded video was found on the closed page'); process.exit(1); }
} finally {
  await browser.close();
}
