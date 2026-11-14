#!/usr/bin/env node
// axe-core accessibility scans of the four main views of layerscope (landing,
// results/Layers, Wasted space, Top 20 files) on desktop 1440x900 and mobile
// 390x844, via playwright-core. NON-BLOCKING by design: it exits 0 no matter
// what it finds; violations are echoed as ::warning:: lines (one compact line
// per engine and per view) and written to a JSON file for the artifact.
//
// Usage:
//   node tools/browser-axe.mjs --browser chromium|firefox|webkit --url URL --out DIR

import { chromium, firefox, webkit } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const browserName = getArg('--browser');
const url = getArg('--url') || 'http://127.0.0.1:8326';
const outDir = getArg('--out');
if (!browserName || !outDir) { console.error('usage: --browser chromium|firefox|webkit --url URL --out DIR'); process.exit(2); }
const engines = { chromium, firefox, webkit };
const engine = engines[browserName];
if (!engine) { console.error(`--browser must be chromium, firefox or webkit (got '${browserName}')`); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const axePath = join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js');
if (!existsSync(axePath)) { console.error(`axe-core not found at ${axePath} — run npm ci (axe-core is a devDependency)`); process.exit(2); }
const axeSource = readFileSync(axePath, 'utf8');

const browser = await engine.launch();
const allResults = [];
const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 };

const scan = async (page, engineLabel, view, viewportLabel) => {
  await page.addScriptTag({ content: axeSource });
  const raw = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const results = await axe.run(document, { resultTypes: ['violations'] });
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => (n.target || []).join(' ')),
    }));
  });
  for (const v of raw) if (totals[v.impact] != null) totals[v.impact]++;
  const line = raw.map((v) => `${v.id}:${v.impact}x${v.nodes}`).join(',') || 'clean';
  console.log(`::warning::AXE[${engineLabel}][${viewportLabel}] ${view}: ${line}`);
  allResults.push({ view, viewport: viewportLabel, violations: raw });
};

for (const [viewportLabel, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  // 1) landing view
  {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await scan(page, browserName, 'landing', viewportLabel);
    } catch (e) {
      console.log(`::warning::AXE[${browserName}][${viewportLabel}] landing: ERROR ${String(e.message || e).split('\n')[0].slice(0, 300)}`);
    } finally { await page.close(); }
  }
  // 2) results (Layers panel after "Try a sample image"), 3) wasted tab, 4) top-20 tab
  {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.click('#sample-btn');
      await page.waitForFunction(() => {
        const a = document.getElementById('analysis');
        const o = document.getElementById('progress-overlay');
        return a && !a.hidden && o && o.hidden;
      }, null, { timeout: 120000, polling: 100 });
      await scan(page, browserName, 'results-layers', viewportLabel);
      await page.click('#tab-wasted');
      await scan(page, browserName, 'wasted-space', viewportLabel);
      await page.click('#tab-top');
      await scan(page, browserName, 'top-20-files', viewportLabel);
    } catch (e) {
      console.log(`::warning::AXE[${browserName}][${viewportLabel}] results: ERROR ${String(e.message || e).split('\n')[0].slice(0, 300)}`);
    } finally { await page.close(); }
  }
}

await browser.close();
const outFile = join(outDir, `axe-${browserName}.json`);
writeFileSync(outFile, `${JSON.stringify({ browser: browserName, totals, scans: allResults }, null, 2)}\n`);
console.log(`::warning::AXE[${browserName}] totals across all scans: critical=${totals.critical} serious=${totals.serious} moderate=${totals.moderate} minor=${totals.minor} (full details: ${outFile})`);
process.exit(0); // non-blocking by design
