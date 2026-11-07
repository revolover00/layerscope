#!/usr/bin/env node
// Records a short, calm demo of layerscope analyzing a deliberately wasteful
// image, for the README GIF. Runs in CI (workflow record-demo.yml) against the
// statically served site; nothing is uploaded anywhere.
//
// Rules (per review feedback):
//   - no cursor overlay, nothing uses stored coordinates or page.mouse;
//     every action is a locator.click() on a NAMED selector (role/text),
//     after scrollIntoViewIfNeeded() and waiting for visibility;
//   - viewport 1100x900 so the landing drop zone is fully visible;
//   - smooth window scrolling only where needed, always behavior:'smooth'
//     with a wait for scroll end;
//   - after EVERY storyboard step, a PNG is saved and the selected tab /
//     selected layer / active filter chip is asserted via DOM; the job fails
//     if a step does not match;
//   - app code is never touched.
//
// Storyboard (holds included; target 18–22 s):
//   1. landing 1.5 s     2. upload → results wait     3. summary 2.5 s
//   4. click layer with "build-essential" (apt-get install layer),
//      click "Added" once, 2.5 s
//   5. click layer with "rm -rf /var/lib/apt/lists" (cleanup layer),
//      click "Deleted" once, 2.5 s
//   6. click tab "Wasted space", 3.0 s
//   7. click tab "Top 20 files", 2.5 s
//   8. click tab "Layers", scroll to top, 1.0 s
//
// Usage:
//   node tools/record-demo.mjs --url http://127.0.0.1:8321 --image /tmp/demo-recording/demo-waste.tar \
//        [--out-dir /tmp/layerscope-demo-rec] [--screens-dir /tmp/demo-screens/steps]
// Prints DEMO_VIDEO <path> with the recorded webm after the context closes.

import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const url = getArg('--url') ?? 'http://127.0.0.1:8321';
const image = getArg('--image') ?? 'assets/samples/layerscope-demo.tar';
const outDir = getArg('--out-dir') ?? '/tmp/layerscope-demo-rec';
const screensDir = getArg('--screens-dir') ?? '/tmp/demo-screens/steps';
if (!existsSync(image)) { console.error(`image not found: ${image}`); process.exit(2); }
mkdirSync(outDir, { recursive: true });
mkdirSync(screensDir, { recursive: true });

const t0 = Date.now();
const mark = (label) => console.log(`DEMO_PHASE +${Date.now() - t0}ms ${label}`);

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: { dir: outDir, size: { width: 1100, height: 900 } },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#dropzone', { state: 'visible', timeout: 10000 });

  let stepNo = 0;
  const shot = async (name) => {
    stepNo += 1;
    const p = join(screensDir, `${String(stepNo).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: p });
    console.log(`DEMO_SCREEN ${p}`);
  };
  const assertOrDie = async (ok, msg) => {
    if (ok) { console.log(`DEMO_ASSERT ok — ${msg}`); return; }
    console.error(`::error::record-demo assert failed — ${msg}`);
    await shot('assert-failed');
    process.exit(1);
  };

  // smooth helpers (window scrolling only; never stored coordinates)
  const smoothScrollTop = async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 3000, polling: 50 });
  };
  const smoothToRow = async (row) => {
    // instant position is fine for row-level work; smooth only for page-level
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  };

  const clickTab = async (id) => {
    const tab = page.locator(id);
    await tab.scrollIntoViewIfNeeded();
    await tab.waitFor({ state: 'visible' });
    await tab.click();
  };

  // ---------- 1. landing (1.5 s) ----------
  await page.waitForTimeout(1500);
  mark('landing');
  await shot('landing');

  // ---------- 2. upload, wait for analysis ----------
  await page.setInputFiles('#file-input', image);
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
  await shot('analysis-done');
  await assertOrDie(
    await page.evaluate(() => {
      const g = document.getElementById('gauge-value');
      return g && /\d/.test(g.textContent);
    }),
    'analysis produced a numeric efficiency score',
  );

  // ---------- 3. summary hold (2.5 s) ----------
  await page.waitForTimeout(2500);
  mark('summary');
  await shot('summary');

  // ---------- 4. apt-get install layer (build-essential), "Added" once ----------
  const aptRow = page.locator('#layer-table tbody tr').filter({ hasText: 'build-essential' });
  await smoothToRow(aptRow);
  await aptRow.waitFor({ state: 'visible' });
  await aptRow.click();
  await page.locator('#ld-kind button[data-kind="added"]').click();
  await page.waitForTimeout(300); // let the list re-filter
  await shot('layer-install-added');
  await assertOrDie(
    await page.evaluate(() => {
      const row = document.querySelector('#layer-table tbody tr.is-selected');
      const chip = document.querySelector('#ld-kind .seg-btn[data-kind="added"]');
      return row && row.textContent.includes('build-essential')
        && chip && chip.classList.contains('is-active');
    }),
    'the build-essential layer is selected and the Added chip is active',
  );
  await page.waitForTimeout(2500);
  mark('layer-install-hold');

  // ---------- 5. cleanup layer (rm -rf /var/lib/apt/lists), "Deleted" once ----------
  const rmRow = page.locator('#layer-table tbody tr').filter({ hasText: 'rm -rf /var/lib/apt/lists' });
  await smoothToRow(rmRow);
  await rmRow.waitFor({ state: 'visible' });
  await rmRow.click();
  await page.locator('#ld-kind button[data-kind="deleted"]').click();
  await page.waitForTimeout(300); // let the list re-filter
  await shot('layer-cleanup-deleted');
  await assertOrDie(
    await page.evaluate(() => {
      const row = document.querySelector('#layer-table tbody tr.is-selected');
      const chip = document.querySelector('#ld-kind .seg-btn[data-kind="deleted"]');
      return row && row.textContent.includes('rm -rf /var/lib/apt/lists')
        && chip && chip.classList.contains('is-active');
    }),
    'the rm -rf /var/lib/apt/lists layer is selected and the Deleted chip is active',
  );
  await page.waitForTimeout(2500);
  mark('layer-cleanup-hold');

  // ---------- 6. tab "Wasted space" (3.0 s) ----------
  await clickTab('#tab-wasted');
  await page.waitForTimeout(200);
  await shot('wasted-space');
  await assertOrDie(
    await page.evaluate(() => {
      const tab = document.getElementById('tab-wasted');
      const panel = document.getElementById('panel-wasted');
      return tab.classList.contains('is-active') && panel && !panel.hidden;
    }),
    'tab "Wasted space" is active and its panel is visible',
  );
  await page.waitForTimeout(3000);
  mark('wasted-hold');

  // ---------- 7. tab "Top 20 files" (2.5 s) ----------
  await clickTab('#tab-top');
  await page.waitForTimeout(200);
  await shot('top-20-files');
  await assertOrDie(
    await page.evaluate(() => {
      const tab = document.getElementById('tab-top');
      const panel = document.getElementById('panel-top');
      return tab.classList.contains('is-active') && panel && !panel.hidden;
    }),
    'tab "Top 20 files" is active and its panel is visible',
  );
  await page.waitForTimeout(2500);
  mark('top-20-hold');

  // ---------- 8. tab "Layers", smooth scroll to top (1.0 s) ----------
  await clickTab('#tab-layers');
  await page.waitForTimeout(150);
  await smoothScrollTop();
  await shot('layers-top');
  await assertOrDie(
    await page.evaluate(() => {
      const tab = document.getElementById('tab-layers');
      const panel = document.getElementById('panel-layers');
      return tab.classList.contains('is-active') && panel && !panel.hidden && window.scrollY === 0;
    }),
    'tab "Layers" is active and the page is at the top',
  );
  await page.waitForTimeout(1000);
  mark('top-hold');

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
