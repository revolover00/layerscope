#!/usr/bin/env node
// Summarize a Lighthouse JSON report: the four category scores plus the top
// failing audits (by weight, then wasted time/bytes), printed as ONE compact
// ::notice:: line so it survives GitHub's ~10-annotations-per-check-run cap.
//
// Usage: node tools/lighthouse-summary.mjs <report.report.json> <label>
// Example: node tools/lighthouse-summary.mjs reports/mobile.report.json mobile

import { readFileSync } from 'node:fs';

const [file, label] = process.argv.slice(2);
if (!file || !label) {
  console.error('usage: node tools/lighthouse-summary.mjs <report.json> <label>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
const cat = (name) => {
  const c = report.categories?.[name];
  return c && typeof c.score === 'number' ? Math.round(c.score * 100) : null;
};
const scores = {
  performance: cat('performance'),
  accessibility: cat('accessibility'),
  best_practices: cat('best-practices'),
  seo: cat('seo'),
};
const wasted = (a) => (a.details?.overallSavingsMs ?? a.details?.overallSavingsBytes ?? 0);
const failing = Object.values(report.audits ?? {})
  .filter((a) => typeof a.score === 'number' && a.score < 1)
  .filter((a) => a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'manual' && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'error')
  .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || wasted(b) - wasted(a) || a.id.localeCompare(b.id));
const top5 = failing.slice(0, 5).map((a) => `${a.id}=${a.scoreDisplayMode === 'binary' || a.scoreDisplayMode === 'numeric' ? a.score : a.score.toFixed(2)}(w=${a.weight ?? 0})`);
const moreCount = failing.length - top5.length;
// accessibility category audits that did not score 1 (axe-core results, incl. node counts)
const a11yFailing = Object.values(report.audits ?? {})
  .filter((a) => report.categories?.accessibility?.auditRefs?.some((r) => r.id === a.id))
  .filter((a) => typeof a.score === 'number' && a.score < 1)
  .map((a) => `${a.id}(nodes=${a.details?.items?.length ?? '?'})`);
console.log(`::notice::LIGHTHOUSE_${label.toUpperCase()} ${JSON.stringify(scores)} failing_audits=${failing.length} top5=[${top5.join(',')}]${moreCount > 0 ? ` (+${moreCount} more in report)` : ''} a11y_issues=[${a11yFailing.join(',') || 'none'}]`);
for (const a of failing.slice(0, 3)) {
  const detail = a.numericValue != null ? ` value=${Math.round(a.numericValue)}${a.numericUnit ? a.numericUnit : ''}` : '';
  console.log(`::notice::LIGHTHOUSE_${label.toUpperCase()} audit ${a.id}: score=${a.score}${detail} — ${a.title}${a.description ? ' || ' + a.description.split('. ')[0] : ''}`);
}
