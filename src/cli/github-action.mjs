// GitHub Action step: consume the JSON report produced by `layerscope analyze
// --json`, write a Markdown summary to $GITHUB_STEP_SUMMARY, and expose
// efficiency / wasted / reclaimable via $GITHUB_OUTPUT.
//
// The CLI writes the report to a file (stdout is redirected by action.yml),
// so a CLI exit code of 1 (threshold breach) or 2 (bad input) still lets this
// step render whatever summary is possible. This script exits with the exit
// code it is given (--exit-code), so the job fails exactly when the CLI says
// it should; a 0 exit code with an unusable report is an internal error (2).
//
// No dependencies; safe to run inside `uses: ./` composite actions.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { formatBytes, formatPercentBig } from '../core/format.js';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const reportPath = getArg('report');
const exitCode = Number.parseInt(getArg('exit-code') ?? '0', 10);
if (!reportPath || Number.isNaN(exitCode)) {
  console.error('usage: node github-action.mjs --report <path> --exit-code <0|1|2>');
  process.exit(2);
}

const appendEnv = (envVar, text) => {
  const target = process.env[envVar];
  if (target) {
    appendFileSync(target, text);
    return true;
  }
  return false;
};

function renderSummary(report) {
  const s = report.summary;
  const img = report.image;
  const effPct = (s.efficiency * 100).toFixed(s.efficiency * 100 >= 1 ? 2 : 3);
  const lines = [];
  lines.push(`## LayerScope — ${img.name ?? 'image analysis'}`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| format | ${img.format} |`);
  lines.push(`| archive size | ${formatBytes(img.compressedArchiveBytes)} |`);
  lines.push(`| layers | ${s.layerCount} |`);
  lines.push(`| total layer bytes | ${formatBytes(s.totalSizeBytes)} |`);
  lines.push(`| wasted | ${formatBytes(s.wastedBytes)} (${formatPercentBig(s.wastedUserPercent)} of user bytes) |`);
  lines.push(`| reclaimable | ${formatBytes(s.reclaimableBytes)} |`);
  lines.push(`| efficiency | ${effPct}% (ratio ${s.efficiency}) |`);
  if (img.selectedPlatform) lines.push(`| platform | ${img.selectedPlatform} |`);
  lines.push('');
  if (report.inefficiencies.length > 0) {
    lines.push('### Top wasted paths');
    lines.push('');
    lines.push('| copies | wasted | path |');
    lines.push('| --- | --- | --- |');
    for (const it of report.inefficiencies.slice(0, 5)) {
      lines.push(`| ${it.count}× | ${formatBytes(it.sizeBytes)} | \`${it.path}\` |`);
    }
    lines.push('');
  }
  if (report.warnings.length > 0) {
    lines.push('### Warnings');
    lines.push('');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}

let report = null;
let reportError = null;
try {
  if (!existsSync(reportPath)) throw new Error('report file was not created');
  const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (parsed.schemaVersion !== 1) throw new Error(`unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}`);
  report = parsed;
} catch (err) {
  reportError = err instanceof Error ? err.message : String(err);
}

const summaryLines = [];
let finalExit = exitCode;

if (report) {
  summaryLines.push(renderSummary(report));
  if (exitCode === 1) {
    summaryLines.push('');
    summaryLines.push('> [!WARNING]');
    summaryLines.push('> Threshold breached — the job fails. See the step log for the failing rule(s).');
  }
  appendEnv('GITHUB_OUTPUT', `efficiency=${report.summary.efficiency}\n`);
  appendEnv('GITHUB_OUTPUT', `wasted=${report.summary.wastedBytes}\n`);
  appendEnv('GITHUB_OUTPUT', `reclaimable=${report.summary.reclaimableBytes}\n`);
} else {
  summaryLines.push('## LayerScope — analysis failed');
  summaryLines.push('');
  summaryLines.push(`\`layerscope analyze\` did not produce a usable report: ${reportError}`);
  console.error(`::error::LayerScope analysis failed (exit code ${exitCode}): ${reportError}`);
  if (exitCode === 0) finalExit = 2; // 0 from the CLI but no report — treat as an internal error
}

const summary = summaryLines.join('\n');
if (!appendEnv('GITHUB_STEP_SUMMARY', `${summary}\n`)) {
  console.log(summary); // not running inside GitHub Actions — just print it
}
process.exit(finalExit);
