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
// relaxed: the sizeBytes SEQUENCE must be EXACTLY equal to dive's (any
// divergence fails), and entries within each maximal contiguous run of equal
// sizeBytes may permute freely — there the (file, count) multiset must match
// exactly. Only dive v0.13.1's undefined intra-tie order is normalized away.
// All other checks remain fully positional/exact.

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
  // 1) The sizeBytes SEQUENCE must match dive exactly — any divergence at any
  //    position fails, regardless of file/count. Only entries within groups of
  //    equal sizeBytes are allowed to permute.
  let sequenceDiff = -1;
  for (let i = 0; i < n; i++) {
    if (Number(dRef[i].sizeBytes) !== Number(sRef[i].sizeBytes)) { sequenceDiff = i; break; }
  }
  if (sequenceDiff >= 0) {
    fail(`fileReference sizeBytes sequence diverges at index ${sequenceDiff}: dive=${dRef[sequenceDiff].sizeBytes} ours=${sRef[sequenceDiff].sizeBytes} (sizeBytes order must match dive exactly; only equal-size entries may permute)`);
  }
  // 2) Within each maximal contiguous run of equal sizeBytes, compare the
  //    multiset of (file, count) pairs — content must still match exactly.
  //    Skipped when the sequence check already failed: comparing
  //    misaligned groups would only add noise to an already-decisive failure.
  let tieDiffs = 0;
  for (let i0 = 0; sequenceDiff === -1 && i0 < n;) {
    let i1 = i0 + 1;
    while (i1 < n && Number(dRef[i1].sizeBytes) === Number(dRef[i0].sizeBytes)) i1++;
    const pairKey = (e) => `${e.file}|${Number(e.count)}`;
    const dMap = new Map();
    for (const e of dRef.slice(i0, i1)) dMap.set(pairKey(e), (dMap.get(pairKey(e)) || 0) + 1);
    const sMap = new Map();
    for (const e of sRef.slice(i0, i1)) sMap.set(pairKey(e), (sMap.get(pairKey(e)) || 0) + 1);
    const keys = new Set([...dMap.keys(), ...sMap.keys()]);
    for (const k of keys) {
      const dc = dMap.get(k) || 0;
      const sc = sMap.get(k) || 0;
      if (dc !== sc) {
        tieDiffs++;
        if (tieDiffs <= 10) fail(`fileReference[${i0}..${i1 - 1}] (sizeBytes=${dRef[i0].sizeBytes}) entry ${dc}x (dive) vs ${sc}x (ours): ${k}`);
      }
    }
    i0 = i1;
  }
  if (sequenceDiff === -1 && tieDiffs === 0 && dRef.length === sRef.length) {
    note(`fileReference ${dRef.length} entries identical (sizeBytes sequence exact; entries within equal-size groups compared as multiset — dive v0.13.1 intra-tie order undefined)`);
  } else if (tieDiffs > 0) {
    fail(`fileReference: ${tieDiffs} differing entries within equal-size groups`);
  }

  return { failures, lines };
}
