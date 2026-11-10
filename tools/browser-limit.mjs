#!/usr/bin/env node
// Refusal-path test: upload a tiny crafted archive whose zstd layer DECLARES a
// decompressed size of 17 GiB (tools/ci/build-crafted-fcs.mjs — 8-byte FCS,
// valid 2 MiB window descriptor). The app must refuse on the header alone —
// the banner names the 8 GiB default fallback limit — and must NOT crash or
// hang the tab. (Mid-decode refusal for frames WITHOUT a content size is
// covered by tests/no-fcs.test.mjs with a caller-supplied maxLayerBytes.)
//
// Usage: node tools/browser-limit.mjs --url http://127.0.0.1:8321 --image /tmp/bench/crafted-fcs-huge.tar
// Exits non-zero unless the error banner appears with the fallback-limit message.

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const url = opt('url', 'http://127.0.0.1:8321');
const image = opt('image', null);
if (!image || !existsSync(image)) { console.error(`usage: node tools/browser-limit.mjs --url URL --image tar (--image missing or not found)`); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.setInputFiles('#file-input', image);

// wait for the error box (fallback-limit message) or for the analysis view — either settles the question
const outcome = await Promise.race([
  page.waitForSelector('#error-box', { state: 'visible', timeout: 120000 }).then(() => 'error'),
  page.waitForFunction(() => {
    const a = document.getElementById('analysis');
    const o = document.getElementById('progress-overlay');
    return a && !a.hidden && o && o.hidden;
  }, null, { timeout: 120000, polling: 100 }).then(() => 'analysis'),
]);

const bannerText = (await page.$('#error-box')) ? (await page.$eval('#error-box', (el) => el.textContent.trim())) : null;
console.log(JSON.stringify({ outcome, pageErrors, bannerText }));
console.log(`::notice::browser-limit outcome=${outcome} pageErrors=${pageErrors.length} bannerHasLimitMessage=${bannerText ? /fallback limit/.test(bannerText) : false} names8GiBCeiling=${bannerText ? /8192 MiB|8 GiB/.test(bannerText) : false}`);

await browser.close();
const pass = outcome === 'error' && bannerText !== null && /fallback limit/.test(bannerText) && /refus/i.test(bannerText) && /8192 MiB|8 GiB/.test(bannerText) && pageErrors.length === 0;
if (!pass) { console.error('BROWSER LIMIT TEST FAILED'); process.exit(1); }
console.log('BROWSER LIMIT TEST PASSED');
