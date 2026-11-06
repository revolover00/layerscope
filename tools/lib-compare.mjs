// Shared comparison of a layerscope analysis vs a dive --json / golden export.
// Returns { failures, lines } where lines are human-readable log lines.

const EPS = 1e-9;

export function compareAnalyses(dive, scope) {
  const lines = [];
  let failures = 0;
  const fail = (msg) => { failures++; lines.push(`  MISMATCH: ${msg}`); };
  const note = (msg) => lines.push(`  ok: ${msg}`);
  const section = (msg) => lines.push(`== ${msg} ==`);

  const dLayers = dive.layer || [];
  const sLayers = scope.layer || [];

  section('layers');
  if (dLayers.length !== sLayers.length) {
    fail(`layer count differs: dive=${dLayers.length} layerscope=${sLayers.length}`);
  } else {
    note(`layer count ${dLayers.length}`);
  }

  const fileKey = (f) => [f.path, f.typeFlag, f.linkName || '', f.size, f.isDir ? 1 : 0, f.uid ?? 0, f.gid ?? 0].join('|');

  for (let i = 0; i < Math.max(dLayers.length, sLayers.length); i++) {
    const d = dLayers[i];
    const s = sLayers[i];
    if (!d || !s) break;
    section(`layer ${i}`);
    if ((d.digestId || '') !== (s.digestId || '')) fail(`digestId differs:\n    dive: ${d.digestId}\n    ours: ${s.digestId}`);
    else note(`digestId ${d.digestId}`);

    if (Number(d.sizeBytes) !== Number(s.sizeBytes)) fail(`sizeBytes differs: dive=${d.sizeBytes} layerscope=${s.sizeBytes}`);
    else note(`sizeBytes ${d.sizeBytes}`);

    if ((d.command || '') !== (s.command || '')) fail(`command differs:\n    dive: ${d.command}\n    ours: ${s.command}`);
    else note(`command ${JSON.stringify(d.command)}`);

    const count = (arr) => {
      const m = new Map();
      for (const f of arr) m.set(fileKey(f), (m.get(fileKey(f)) || 0) + 1);
      return m;
    };
    const dCount = count(d.fileList || []);
    const sCount = count(s.fileList || []);
    const allKeys = new Set([...dCount.keys(), ...sCount.keys()]);
    let fileDiffs = 0;
    for (const k of allKeys) {
      const dc = dCount.get(k) || 0;
      const sc = sCount.get(k) || 0;
      if (dc !== sc) {
        fileDiffs++;
        if (fileDiffs <= 10) fail(`fileList entry ${dc}x (dive) vs ${sc}x (ours): ${k}`);
      }
    }
    if (fileDiffs === 0) note(`fileList ${(d.fileList || []).length} entries identical`);
    else fail(`fileList: ${fileDiffs} differing entries in layer ${i}`);
  }

  section('image');
  const di = dive.image || {};
  const si = scope.image || {};
  if (Number(di.sizeBytes) !== Number(si.sizeBytes)) fail(`image sizeBytes differs: dive=${di.sizeBytes} layerscope=${si.sizeBytes}`);
  else note(`image sizeBytes ${di.sizeBytes}`);

  if (Number(di.inefficientBytes) !== Number(si.inefficientBytes)) fail(`inefficientBytes differs: dive=${di.inefficientBytes} layerscope=${si.inefficientBytes}`);
  else note(`inefficientBytes ${di.inefficientBytes}`);

  const de = Number(di.efficiencyScore);
  const se = Number(si.efficiencyScore);
  const denom = Math.max(Math.abs(de), Math.abs(se), 1e-12);
  const rel = Math.abs(de - se) / denom;
  if (!(rel < EPS)) fail(`efficiencyScore differs: dive=${di.efficiencyScore} layerscope=${si.efficiencyScore} (rel ${rel.toExponential(3)})`);
  else note(`efficiencyScore dive=${de} ours=${se} (rel ${rel.toExponential(3)})`);

  const dRef = di.fileReference || [];
  const sRef = si.fileReference || [];
  if (dRef.length !== sRef.length) {
    fail(`fileReference length differs: dive=${dRef.length} layerscope=${sRef.length}`);
  }
  const n = Math.min(dRef.length, sRef.length);
  let refDiffs = 0;
  for (let i = 0; i < n; i++) {
    const a = dRef[i];
    const b = sRef[i];
    if (a.file !== b.file || Number(a.count) !== Number(b.count) || Number(a.sizeBytes) !== Number(b.sizeBytes)) {
      refDiffs++;
      if (refDiffs <= 10) fail(`fileReference[${i}]:\n    dive: ${JSON.stringify(a)}\n    ours: ${JSON.stringify(b)}`);
    }
  }
  if (refDiffs === 0 && dRef.length === sRef.length) note(`fileReference ${dRef.length} entries identical`);

  return { failures, lines };
}
