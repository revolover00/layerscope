// Builds the CLI's output documents from an analyzeImage() result.
//
// buildReport() produces the stable machine-readable document (schemaVersion 1,
// documented in docs/CLI.md). formatTable() produces the human-readable table.
// checkThresholds() applies the --fail-* flags. Kept separate from main.mjs so
// tests can assert on the plain data structures.

import { formatBytes, formatPercent, formatPercentBig } from '../core/format.js';

/**
 * Stable machine-readable report. Raw numbers, no rounding, no timestamps —
 * two runs over the same archive produce identical bytes. The per-layer file
 * inventories of the analysis object are deliberately omitted (they can be
 * larger than the archive); consumers that need them should use the web UI.
 */
export function buildReport(analysis, { toolVersion }) {
  return {
    schemaVersion: 1,
    tool: { name: 'layerscope', version: toolVersion },
    image: {
      name: analysis.imageName,
      format: analysis.format,
      compressedArchiveBytes: analysis.compressedArchiveBytes,
      selectedPlatform: analysis.selectedPlatform ?? null,
      platforms: analysis.platforms ?? null,
    },
    summary: {
      layerCount: analysis.layerCount,
      totalSizeBytes: analysis.totalSizeBytes,
      userSizeBytes: analysis.userSizeBytes,
      wastedBytes: analysis.wastedBytes,
      reclaimableBytes: analysis.reclaimableBytes,
      wastedUserPercent: analysis.wastedUserPercent,
      efficiency: analysis.efficiency,
    },
    layers: analysis.layers.map((l) => ({
      index: l.index,
      digestId: l.digestId,
      command: l.command,
      sizeBytes: l.sizeBytes,
      compressedBytes: l.compressedBytes,
      compression: l.compression,
      entryCount: l.entryCount,
    })),
    inefficiencies: analysis.inefficiencies.map(({ path, count, sizeBytes }) => ({ path, count, sizeBytes })),
    topFinalFiles: analysis.topFinalFiles.map(({ path, size, type }) => ({ path, size, type })),
    topLayerEntries: analysis.topLayerEntries.map(({ path, size, layer }) => ({ path, size, layer })),
    warnings: [...analysis.warnings],
  };
}

const collapseWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function efficiencyText(ratio) {
  const pct = ratio * 100;
  const digits = pct >= 10 ? 1 : pct >= 1 ? 2 : 3;
  return `${pct.toFixed(digits)}% (ratio ${ratio.toPrecision(6)})`;
}

/** Human-readable table. Not a contract — only --json output is stable. */
export function formatTable(report, { source } = {}) {
  const lines = [];
  const name = report.image.name ?? '(unnamed archive)';
  lines.push(`${name} — ${report.image.format}`);
  lines.push(`source: ${source ?? '?'}   archive on disk: ${formatBytes(report.image.compressedArchiveBytes)}`);
  lines.push('');
  lines.push(`Layers (${report.summary.layerCount}):`);
  lines.push('  #    size         compression  entries  command');
  for (const l of report.layers) {
    const cmd = clip(collapseWs(l.command ?? '(missing)'), 72);
    lines.push(
      `  ${String(l.index).padEnd(2)}  ${String(formatBytes(l.sizeBytes)).padEnd(11)}  ${String(l.compression).padEnd(11)}  ${String(l.entryCount).padStart(7)}  ${cmd}`,
    );
  }
  lines.push('');
  lines.push('Summary:');
  lines.push(`  total layer bytes   ${formatBytes(report.summary.totalSizeBytes)}`);
  lines.push(`  wasted              ${formatBytes(report.summary.wastedBytes)} (${formatPercentBig(report.summary.wastedUserPercent)} of user bytes)`);
  lines.push(`  reclaimable         ${formatBytes(report.summary.reclaimableBytes)}`);
  lines.push(`  efficiency          ${efficiencyText(report.summary.efficiency)}`);
  lines.push('');
  lines.push('Top files in the final image:');
  if (report.topFinalFiles.length === 0) {
    lines.push('  (none)');
  } else {
    for (const f of report.topFinalFiles.slice(0, 10)) {
      lines.push(`  ${String(formatBytes(f.size)).padStart(11)}  ${f.path}`);
    }
  }
  lines.push('');
  lines.push('Top wasted paths:');
  if (report.inefficiencies.length === 0) {
    lines.push('  (none — every path appears in at most one layer)');
  } else {
    for (const it of report.inefficiencies.slice(0, 5)) {
      lines.push(`  ${String(it.count).padStart(2)}×  ${String(formatBytes(it.sizeBytes)).padStart(11)}  ${it.path}`);
    }
  }
  lines.push('');
  if (report.warnings.length === 0) {
    lines.push('Warnings: none');
  } else {
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

/**
 * Apply the --fail-* thresholds to a built report. Returns an array of
 * failure messages (empty when all thresholds hold). Pure — the caller
 * decides the exit code.
 */
export function checkThresholds(report, { failUnderEfficiency = null, failOverWasted = null } = {}) {
  const failures = [];
  if (failUnderEfficiency !== null && !(report.summary.efficiency >= failUnderEfficiency)) {
    failures.push(
      `efficiency ${efficiencyText(report.summary.efficiency)} is below the required ${efficiencyText(failUnderEfficiency)} (--fail-under-efficiency ${failUnderEfficiency})`,
    );
  }
  if (failOverWasted !== null && report.summary.wastedBytes > failOverWasted) {
    failures.push(
      `wasted ${report.summary.wastedBytes} bytes (${formatBytes(report.summary.wastedBytes)}) exceeds --fail-over-wasted ${failOverWasted}`,
    );
  }
  return failures;
}
