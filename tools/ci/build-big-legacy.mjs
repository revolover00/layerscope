#!/usr/bin/env node
// Builds a legacy docker-save fixture of about 3 GB (uncompressed layer.tar,
// like real `docker save`) WITHOUT writing the zero-filled file bodies to
// disk: file bodies are holes in a sparse file, tar headers are positioned at
// their offsets. Generation is therefore fast and uses almost no disk.
//
// The fixture is deliberately made of MANY 1 MiB zero files rather than a few
// huge files, so the browser fixture job stays within tab memory limits:
// the analyzer buffers one data section at a time before skipping it, which
// scales with the largest single file, not the archive size.
//
// Committed files: tools/ci/analyze-big.mjs (node reference analysis) and
// tools/browser-big.mjs (Chromium assertions) consume it in
// .github/workflows/browser-bench.yml.
//
// Expected numbers are NOT hardcoded anywhere — the reference analysis runs
// the same src/core/analyze.js code path the browser uses and feeds its
// output to the Chromium assertions.
//
//   node tools/ci/build-big-legacy.mjs --out /tmp/bench/big-legacy.tar [--files-per-layer 1000] [--file-mib 1]
//
// Sizes: 3 layers; each layer holds <files-per-layer> zero files of
// <file-mib> MiB plus one <file-mib> MiB duplicate (`shared/dup.bin`, identical
// in all three layers) plus a `app/config.yml` that changes per layer. With
// defaults: 3000 x 1 MiB + 3 x 1 MiB dup + 3 x 11 B config ~= 2.9 GiB of
// header-counted content (~3 GB). The duplicate makes wastedBytes non-zero so
// the assertion exercises the whole analysis path, not just parsing.
//
// Implementation notes: the archive is built in a single sparse file in three
// passes — (1) reserve the layout (all sizes are content-independent: layer
// ids are always 64 hex chars), (2) write the layer tars in place (bodies are
// holes), (3) hash the layer regions from the file to obtain diff_ids, then
// write the headers and the small files (VERSION/json/config/manifest/
// repositories). Sizes reserved in pass 1 are asserted to equal the real
// contents in pass 3 — a mismatch aborts loudly instead of writing a corrupt
// archive.
//
// Prints a JSON summary on stdout for the CI log.

import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tarHeader, dockerConfig, MTIME } from '../synth-lib.mjs';

const MIB = 1024 * 1024;
const BLOCK = 512;

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
const out = getArg('--out');
if (!out) { console.error('usage: node tools/ci/build-big-legacy.mjs --out FILE [--files-per-layer 1000] [--file-mib 1]'); process.exit(2); }
const filesPerLayer = parseInt(getArg('--files-per-layer', '1000'), 10);
const fileBytes = parseInt(getArg('--file-mib', '1'), 10) * MIB;
if (!Number.isInteger(filesPerLayer) || filesPerLayer < 1 || !Number.isInteger(fileBytes) || fileBytes < BLOCK) {
  console.error('files-per-layer must be >= 1 and file-mib must be >= 0.002 (512 B)');
  process.exit(2);
}
const LAYERS = [1, 2, 3];
const REPO_TAG = 'layerscope/big-fixture:latest';

const pad = (n, block = BLOCK) => (block - (n % block)) % block;
const cfgLine = (k) => `version: ${k}\n`;
const entryPadLen = (size) => pad(size);

// The exact entry list of one layer tar — used both for measuring its size
// and for writing it at an absolute offset. Single source of truth.
function layerEntriesSpec(k) {
  const entries = [];
  for (let j = 0; j < filesPerLayer; j++) {
    entries.push({ name: `big/zeros-${k}/${String(j).padStart(4, '0')}.bin`, size: fileBytes, content: null });
  }
  entries.push({ name: 'shared/dup.bin', size: fileBytes, content: null }); // same in every layer
  const cfg = Buffer.from(cfgLine(k));
  entries.push({ name: 'app/config.yml', size: cfg.length, content: cfg }); // modified every layer
  return entries;
}
const tarEntryExtent = (size) => BLOCK + size + entryPadLen(size);
const layerTarSize = (spec) => spec.reduce((acc, e) => acc + tarEntryExtent(e.size), 0) + 1024;

// header-counted content bytes of one layer (what dive/layerscope report)
const layerContentBytes = (spec) => spec.reduce((acc, e) => acc + e.size, 0);

async function writeHeaderAt(fd, pos, name, size, typeflag = '0', mode = 0o644) {
  await fd.write(tarHeader({ name, mode, uid: 0, gid: 0, size, mtime: MTIME, typeflag, linkname: '' }), 0, BLOCK, pos);
}
async function writeEntryAt(fd, pos, { name, size, content }) {
  await writeHeaderAt(fd, pos, name, size);
  let next = pos + BLOCK;
  if (content) {
    await fd.write(content, 0, content.length, next);
    next += content.length + pad(content.length);
  } else {
    next += size + pad(size); // hole
  }
  return next;
}

const layerSpecs = LAYERS.map(layerEntriesSpec);
const layerTarSizes = layerSpecs.map(layerTarSize);
const totalContentBytes = layerSpecs.reduce((acc, s) => acc + layerContentBytes(s), 0);

// ---------- pass 1: reserve the layout (sizes are content-independent) ----------
const DUMMY_ID = '0'.repeat(64);
function buildPlan() {
  const plan = [];
  let pos = 0;
  const add = (slot, name, size) => { plan.push({ slot, name, headerPos: pos, size }); pos += BLOCK + size + pad(size); };
  for (let i = 0; i < LAYERS.length; i++) {
    add(`layerTar:${i}`, `${DUMMY_ID}/layer.tar`, layerTarSizes[i]);
    add(`version:${i}`, `${DUMMY_ID}/VERSION`, 4);
    add(`json:${i}`, `${DUMMY_ID}/json`, jsonPlaceholder(i).length);
  }
  add('config', `${DUMMY_ID}.json`, configPlaceholder.length);
  add('manifest', 'manifest.json', manifestPlaceholder.length);
  add('repositories', 'repositories', repositoriesPlaceholder.length);
  pos += 1024; // terminator
  return { plan, total: pos };
}

// placeholder contents: identical lengths to the real ones (ids are 64 chars)
const dummyIso = new Date(MTIME * 1000).toISOString();
const dummyDiffIds = LAYERS.map(() => `sha256:${'a'.repeat(64)}`);
const jsonPlaceholder = (i) => Buffer.from(JSON.stringify({ id: 'a'.repeat(64), created: dummyIso }));
const configPlaceholderRaw = dockerConfig(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)], LAYERS.map((k) => ({ created_by: `/bin/sh -c echo big-fixture layer ${k}` })));
// note: dockerConfig prefixes diff_ids with sha256: — the placeholder is the
// same shape with 64-char hex ids, so its length equals the real config's.
const configPlaceholder = configPlaceholderRaw;
const manifestPlaceholder = Buffer.from(JSON.stringify([{ Config: `${DUMMY_ID}.json`, RepoTags: [REPO_TAG], Layers: LAYERS.map(() => `${DUMMY_ID}/layer.tar`) }], null, 2));
const repositoriesPlaceholder = Buffer.from(JSON.stringify({ 'layerscope/big-fixture': { latest: DUMMY_ID } }, null, 2));

const { plan, total } = buildPlan();
const slot = (name) => plan.find((p) => p.slot === name);

// ---------- pass 2: write the layer tars in place (bodies are holes) ----------
const fd = await open(out, 'w+'); // read-write: layer regions are read back for diff_ids
for (let i = 0; i < LAYERS.length; i++) {
  let inner = slot(`layerTar:${i}`).headerPos + BLOCK;
  for (const entry of layerSpecs[i]) {
    inner = await writeEntryAt(fd, inner, entry);
  }
  inner += 1024; // layer tar terminator (hole)
  if (inner !== slot(`layerTar:${i}`).headerPos + BLOCK + layerTarSizes[i]) {
    console.error(`internal error: layer ${i + 1} extent mismatch`);
    process.exit(1);
  }
}

// extend the sparse file to full size before hashing — holes read back as zeros
await fd.truncate(total);

// ---------- pass 3: hash the layer regions, then write ids and small files ----------
async function sha256Region(fd, start, len) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(8 * MIB);
  let offset = start;
  let remaining = len;
  while (remaining > 0) {
    const want = Math.min(buf.length, remaining);
    const { bytesRead } = await fd.read(buf, 0, want, offset);
    if (bytesRead === 0) throw new Error('unexpected EOF while hashing layer region');
    hash.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
    remaining -= bytesRead;
  }
  return hash.digest('hex');
}

const diffIds = [];
for (let i = 0; i < LAYERS.length; i++) {
  diffIds.push(await sha256Region(fd, slot(`layerTar:${i}`).headerPos + BLOCK, layerTarSizes[i]));
}
const configJson = dockerConfig(diffIds, LAYERS.map((k) => ({ created_by: `/bin/sh -c echo big-fixture layer ${k}` })));
const configDigest = createHash('sha256').update(configJson).digest('hex');
const layerIds = diffIds.map((d) => d.slice(0, 64));

// real small-file contents — every length MUST equal the reserved slot
const jsonFiles = LAYERS.map((_, i) => Buffer.from(JSON.stringify({ id: layerIds[i], created: dummyIso })));
const manifestJson = Buffer.from(JSON.stringify([{
  Config: `${configDigest}.json`,
  RepoTags: [REPO_TAG],
  Layers: layerIds.map((id) => `${id}/layer.tar`),
}], null, 2));
const repositoriesJson = Buffer.from(JSON.stringify({ 'layerscope/big-fixture': { latest: layerIds[0] } }, null, 2));

const check = (slotName, content) => {
  const reserved = slot(slotName).size;
  if (content.length !== reserved) {
    console.error(`internal error: ${slotName} content is ${content.length} B but reserved ${reserved} B`);
    process.exit(1);
  }
  return content;
};

for (let i = 0; i < LAYERS.length; i++) {
  const headerPos = slot(`layerTar:${i}`).headerPos;
  await writeHeaderAt(fd, headerPos, `${layerIds[i]}/layer.tar`, layerTarSizes[i]);
  const version = check(`version:${i}`, Buffer.from('1.0\n'));
  await writeEntryAt(fd, slot(`version:${i}`).headerPos, { name: `${layerIds[i]}/VERSION`, size: version.length, content: version });
  const json = check(`json:${i}`, jsonFiles[i]);
  await writeEntryAt(fd, slot(`json:${i}`).headerPos, { name: `${layerIds[i]}/json`, size: json.length, content: json });
}
const cfg = check('config', configJson);
await writeEntryAt(fd, slot('config').headerPos, { name: `${configDigest}.json`, size: cfg.length, content: cfg });
const mf = check('manifest', manifestJson);
await writeEntryAt(fd, slot('manifest').headerPos, { name: 'manifest.json', size: mf.length, content: mf });
const rp = check('repositories', repositoriesJson);
await writeEntryAt(fd, slot('repositories').headerPos, { name: 'repositories', size: rp.length, content: rp });
await fd.close();
const st = await stat(out);
console.log(JSON.stringify({
  out,
  fileBytes: st.size,
  filesPerLayer,
  fileBytesBody: fileBytes,
  expectedHeaderBytesTotal: totalContentBytes,
  layerTarSizes,
  diffIds,
  note: 'file bodies are holes (sparse) and read back as zeros; see tools/ci/build-big-legacy.mjs',
}, null, 2));
