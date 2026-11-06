#!/usr/bin/env node
// Browser decoder soak + repeated-analysis consistency test (Playwright).
//
// Phase A (decoder, one tab): import the vendored ESM web build once, init it,
// then decompress the SAME zstd frame N times (default 2000) in this one tab,
// verifying the sha256 of every output (crypto.subtle).
//
// Phase B (app, one tab): upload the same archive through the real #file-input
// M times (default 50) and compare a fingerprint of the rendered analysis
// (image name, chips, efficiency gauge, total size, wasted bytes, layer rows)
// across all M runs.
//
// Usage:
//   node tools/browser-soak.mjs --url http://127.0.0.1:8321 \
//     --image /tmp/bench/soak.tar --layer-url /soak-layer.zst --expected-sha256 <hex> \
//     [--iterations 2000] [--analyses 50]
//
// Exits non-zero if any sha256 mismatch or any fingerprint divergence occurs,
// or if any console/page error is observed.

import { chromium } from 'playwright-core';
import { existsSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const url = opt('url', 'http://127.0.0.1:8321');
const image = opt('image', null);
const layerUrl = opt('layer-url', '/soak-layer.zst');
const expectedSha = opt('expected-sha256', null);
const ITERATIONS = Number(opt('iterations', 2000));
const ANALYSES = Number(opt('analyses', 50));
for (const req of [['image', image], ['expected-sha256', expectedSha]]) {
  if (!req[1]) { console.error(`missing --${req[0]}`); process.exit(2); }
}
if (!existsSync(image)) { console.error(`image not found: ${image}`); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });

await page.goto(url, { waitUntil: 'load', timeout: 60000 });

// ---------- Phase A: 2000 decompresses of the same frame, sha256-verified ----------
const phaseA = await page.evaluate(async ({ layerUrl, expectedSha, iterations }) => {
  const resp = await fetch(layerUrl);
  if (!resp.ok) return { error: `fetch ${layerUrl} → HTTP ${resp.status}` };
  const frame = new Uint8Array(await resp.arrayBuffer());
  const mod = await import('/assets/vendor/zstd/index.web.js');
  await mod.init();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  let ok = 0;
  const mismatches = [];
  for (let i = 1; i <= iterations; i++) {
    let out;
    try {
      out = mod.decompress(frame);
    } catch (err) {
      mismatches.push({ iteration: i, error: String(err && err.message || err) });
      if (mismatches.length >= 3) break;
      continue;
    }
    const digest = await crypto.subtle.digest('SHA-256', out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    if (hex(digest) === expectedSha) ok++;
    else {
      mismatches.push({ iteration: i, error: `sha256 mismatch (length ${out.length})` });
      if (mismatches.length >= 3) break;
    }
  }
  return { ok, iterations, mismatches, frameBytes: frame.length };
}, { layerUrl, expectedSha, iterations: ITERATIONS });

// ---------- Phase B: N analyses of the same archive, fingerprint-compared -----
const fingerprint = async () => page.evaluate(() => {
  const text = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
  const layerRows = [...document.querySelectorAll('#layer-table tbody tr')].map((tr) => tr.textContent?.trim());
  return JSON.stringify({
    image: text('image-name'),
    format: text('chip-format'),
    layers: text('chip-layers'),
    compressed: text('chip-compressed'),
    gauge: text('gauge-value'),
    total: text('stat-total'),
    wasted: text('stat-wasted'),
    layerRows,
  });
});

const waitForAnalysis = () => page.waitForFunction(() => {
  const a = document.getElementById('analysis');
  const o = document.getElementById('progress-overlay');
  return a && !a.hidden && o && o.hidden;
}, null, { timeout: 600000, polling: 100 });

const fps = [];
for (let i = 1; i <= ANALYSES; i++) {
  if (i > 1) {
    await page.click('#analyze-another');
    await page.waitForFunction(() => !document.getElementById('landing').hidden, null, { timeout: 30000, polling: 100 });
  }
  await page.setInputFiles('#file-input', image);
  await waitForAnalysis();
  fps.push(await fingerprint());
}
const uniqueFps = new Set(fps);

console.log(JSON.stringify({
  phaseA: phaseA.error ? phaseA : { ...phaseA, mismatches: phaseA.mismatches.length > 2 ? phaseA.mismatches.slice(0, 3) : phaseA.mismatches },
  phaseB: { analyses: ANALYSES, uniqueFingerprints: uniqueFps.size },
  consoleErrors,
}));
console.log(`::notice::browser-soak phaseA(one tab, ${ITERATIONS} decompress) ok=${phaseA.ok ?? 'n/a'}/${ITERATIONS} divergences=${phaseA.mismatches ? phaseA.mismatches.length : 'n/a'} phaseB(${ANALYSES} analyses) uniqueFingerprints=${uniqueFps.size} consoleErrors=${consoleErrors.length}`);

await browser.close();
const pass = !phaseA.error && phaseA.ok === ITERATIONS && phaseA.mismatches.length === 0 && uniqueFps.size === 1 && consoleErrors.length === 0;
if (!pass) { console.error('BROWSER SOAK FAILED'); process.exit(1); }
console.log('BROWSER SOAK PASSED');
