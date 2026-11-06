// Number/byte formatting helpers shared by the UI and tools.
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 0) return '-' + formatBytes(-bytes);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function formatPercentBig(ratio) {
  // for absurd ratios (user bytes tiny): thousands-grouped integer percent
  const pct = ratio * 100;
  if (pct < 1000) return formatPercent(ratio, 1);
  return `${formatCount(Math.round(pct))}%`;
}

export function formatPercent(ratio, digits = 1) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** Compact size used in stacked bars. */
export function formatBytesShort(bytes) {
  if (!bytes) return '0';
  const units = [['TB', 1e12], ['GB', 1e9], ['MB', 1e6], ['KB', 1e3]];
  for (const [u, f] of units) {
    if (bytes >= f) return `${(bytes / f).toFixed(bytes / f >= 10 ? 0 : 1)}${u}`;
  }
  return `${bytes}B`;
}
