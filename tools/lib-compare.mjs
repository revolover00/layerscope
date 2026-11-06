// Shared comparison of a layerscope analysis vs a dive --json / golden export.
// Returns { failures, lines } where lines are human-readable log lines.
//
// fileReference comparison note (no tolerances involved):
// dive v0.13.1 (what CI installs) orders Inefficiencies by CumulativeSize only
// (dive/filetree/efficiency.go: EfficiencySlice.Less) using the UNSTABLE
// sort.Sort, then exports iterating the slice in reverse
// (runtime/export/export.go). There is NO path tiebreaker, so the order of
// entries with equal CumulativeSize is arbitrary — concretely, python:3.12-slim
// yields three zero-size entries (/var/lib/dpkg/triggers/Lock,
// /var/lib/dpkg/triggers/Unincorp, /var/lib/dpkg/lock) whose relative order is
// not defined by dive. dive main added "ties by path" (dive/analysis.go).
// layerscope follows dive main (size desc, path asc). Tolerances are NOT
// relaxed: every entry must still match EXACTLY on (file, count, sizeBytes),
// compared as a multiset within equal-(sizeBytes,count) groups; group blocks
// and content must match one-to-one. Only dive v0.13.1's undefined intra-tie
// order is normalized away. All other checks remain fully positional/exact.

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
  // Multiset comparison of exact (file, count, sizeBytes) triples. dive v0.13.1
  // defines no order within equal-cumulative-size groups (see file header), so a
  // positional diff of 0-byte ties is not meaningful. Content must match exactly.
  const tripleKey = (e) => `${e.file}|${Number(e.count)}|${Number(e.sizeBytes)}`;
  const dMap = new Map();
  for (const e of dRef) dMap.set(tripleKey(e), (dMap.get(tripleKey(e)) || 0) + 1);
  const sMap = new Map();
  for (const e of sRef) sMap.set(tripleKey(e), (sMap.get(tripleKey(e)) || 0) + 1);
  const allTriples = new Set([...dMap.keys(), ...sMap.keys()]);
  let refDiffs = 0;
  for (const k of allTriples) {
    const dc = dMap.get(k) || 0;
    const sc = sMap.get(k) || 0;
    if (dc !== sc) {
      refDiffs++;
      if (refDiffs <= 10) fail(`fileReference entry ${dc}x (dive) vs ${sc}x (ours): ${k}`);
    }
  }
  if (refDiffs === 0 && dRef.length === sRef.length) {
    note(`fileReference ${dRef.length} entries identical (multiset; dive v0.13.1 intra-tie order undefined)`);
  } else if (refDiffs > 0) {
    fail(`fileReference: ${refDiffs} differing entries`);
  }

  return { failures, lines };
}
