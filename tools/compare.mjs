#!/usr/bin/env node
// Compare layerscope's analysis against `dive --json` output for the same image.
//
// Usage:
//   node tools/compare.mjs <dive.json> <layerscope.json>
// Exit code 0 = match, 1 = mismatch, 2 = usage/io error.

import { readFileSync } from 'node:fs';
import { compareAnalyses } from './lib-compare.mjs';

const args = process.argv.slice(2);
const [divePath, scopePath] = args.filter((a) => !a.startsWith('--'));
if (!divePath || !scopePath) {
  console.error('usage: node tools/compare.mjs <dive.json> <layerscope.json>');
  process.exit(2);
}

const dive = JSON.parse(readFileSync(divePath, 'utf8'));
const scope = JSON.parse(readFileSync(scopePath, 'utf8'));

const { failures, lines } = compareAnalyses(dive, scope);
for (const l of lines) console.error(l);
console.error(failures ? `\nFAIL: ${failures} mismatch(es) between dive and layerscope` : '\nPASS: layerscope matches dive exactly');
process.exit(failures ? 1 : 0);
