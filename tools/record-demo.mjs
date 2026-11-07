#!/usr/bin/env node
// Records a short, natural demo of layerscope analyzing a deliberately
// wasteful image, for the README GIF. Runs in CI (workflow record-demo.yml)
// against the statically served site; nothing is uploaded anywhere.
//
// Visuals:
//   - a visible round cursor is injected into the page; every click is
//     preceded by a Playwright mouse.move(.., { steps: 25 }) glide towards
//     the target, a ~150 ms settle, a quick "press" scale animation, then
//     down/up. The cursor element is position:fixed with z-index 2147483647
//     and pointer-events:none, so it never blocks hits.
//   - scrolling uses window.scrollTo({ behavior: 'smooth' }) — never jumps.
//     The tab bar (.tabs) is pinned near the viewport top before the per-layer
//     diff browsing, so it stays visible all the way through the Layers /
//     Top 20 files / Wasted space views.
//
// Timeline (target 20–25 s, fps=15 for the GIF):
//   1.5 s landing   → upload → analysis (progress overlay visible)
//   ~0.4 s gauge settle + 1.3 s summary hold
//   3 × (cursor glide + layer click + "Added" chip + 1.1 s hold)
//   Top 20 files tab (1.3 s) → Wasted space tab (1.3 s)
//   smooth scroll back to the top (1.2 s)
// Phase markers are printed so the conversion step (and review) can reason
// about the timeline.
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
const SCROLL_MS = 650;

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

  // ---- visible cursor -------------------------------------------------
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = '__demo-cursor';
    d.style.cssText = [
      'position:fixed',
      'left:0', 'top:0',
      'width:22px', 'height:22px',
      'border-radius:50%',
      'background:rgba(255,255,255,.95)',
      'border:2px solid rgba(0,0,0,.6)',
      'box-shadow:0 2px 10px rgba(0,0,0,.5)',
      'pointer-events:none',
      'z-index:2147483647',
      'transform:translate(-50%,-50%)',
      'transition:transform .09s ease-out',
    ].join(';');
    document.body.appendChild(d);
    window.addEventListener('mousemove', (e) => {
      d.style.left = `${e.clientX}px`;
      d.style.top = `${e.clientY}px`;
    }, true);
    window.__demoPress = () => {
      d.style.transform = 'translate(-50%,-50%) scale(0.72)';
      setTimeout(() => { d.style.transform = 'translate(-50%,-50%) scale(1)'; }, 130);
    };
  });
  mark('cursor-injected');

  // small helpers --------------------------------------------------------
  const glide = async (sel, nth = 0) => {
    const box = await page.locator(sel).nth(nth).boundingBox();
    if (!box) throw new Error(`no bounding box for ${sel} [${nth}]`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await page.waitForTimeout(150);
  };
  const tap = async (sel, nth = 0, after = 140) => {
    await glide(sel, nth);
    await page.evaluate(() => window.__demoPress && window.__demoPress());
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(after);
  };
  const smoothScrollToTabs = async () => {
    await page.evaluate(() => {
      const t = document.querySelector('.tabs');
      if (!t) { window.scrollTo({ top: 140, behavior: 'smooth' }); return; }
      const top = t.getBoundingClientRect().top + window.scrollY - 12;
      window.scrollTo({ top, behavior: 'smooth' });
    });
    await page.waitForTimeout(SCROLL_MS);
  };
  const smoothScrollTop = async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(SCROLL_MS);
  };

  await page.waitForTimeout(1500); // breathe on the landing page
  mark('page-open');

  // visible glide onto "Choose file…", then attach the tar (native file chooser if it fires)
  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
  await tap('#browse-btn', 0, 80);
  const chooser = await fileChooserPromise;
  if (chooser) await chooser.setFiles(image);
  else await page.setInputFiles('#file-input', image);
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

  // summary cards hold
  await page.waitForTimeout(400);
  await page.waitForTimeout(1300);
  mark('summary-pause');

  // pin the tab bar (smooth) before the layer browsing
  await smoothScrollToTabs();
  mark('tabs-pinned');

  const rowCount = await page.locator('#layer-table tbody tr').count();
  for (let i = 0; i < Math.min(3, rowCount); i++) {
    await tap('#layer-table tbody tr', i, 120);
    // show real files in the diff list (first rows default to "MODIFIED /")
    await tap('#ld-kind button[data-kind="added"]', 0, 120);
    await page.waitForTimeout(1100);
    mark(`layer-${i + 1}`);
  }

  await tap('#tab-top', 0, 120);
  await page.waitForTimeout(1300);
  mark('tab-top');

  await tap('#tab-wasted', 0, 120);
  await page.waitForTimeout(1300);
  mark('tab-wasted');

  await smoothScrollTop();
  await page.waitForTimeout(1200);
  mark('top-again');

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
