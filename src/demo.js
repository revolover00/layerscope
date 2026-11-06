// Builds a small synthetic docker-save image (legacy format, uncompressed)
// entirely in the browser so the demo runs without any file. Layers exercise
// the analyzer: add + modify + add-then-delete + an empty_layer history entry.

const MTIME = 1577836800;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBytes(size, seed) {
  const rand = mulberry32(seed);
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

function strField(value, length) {
  const out = new Uint8Array(length);
  new TextEncoder().encodeInto(String(value).slice(0, length), out);
  return out;
}

function tarHeader({ name, mode, size, typeflag }) {
  const b = new Uint8Array(512);
  b.set(strField(name, 100), 0);
  const putOctal = (value, start, length) => {
    const s = Math.floor(value).toString(8).padStart(length - 1, '0').slice(-(length - 1)) + '\0';
    b.set(new TextEncoder().encode(s), start);
  };
  putOctal(mode, 100, 8);
  putOctal(0, 108, 8);   // uid
  putOctal(0, 116, 8);   // gid
  putOctal(size, 124, 12);
  putOctal(MTIME, 136, 12);
  b.fill(0x20, 148, 156); // chksum as spaces while computing
  b[156] = typeflag.charCodeAt(0);
  // GNU magic, matching what GNU tar produces
  b.set(strField('ustar ', 6), 257);
  b.set(new Uint8Array([0x20, 0x00]), 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  const chk = sum.toString(8).padStart(6, '0') + '\0 ';
  b.set(new TextEncoder().encode(chk), 148);
  return b;
}

function entryBytes(entry) {
  const chunks = [];
  const data = entry.content || new Uint8Array(0);
  const isDir = entry.typeflag === '5';
  const size = isDir || entry.typeflag === '2' || entry.typeflag === '1' ? 0 : data.byteLength;
  chunks.push(tarHeader({ name: entry.name, mode: entry.mode ?? (isDir ? 0o755 : 0o644), size, typeflag: entry.typeflag }));
  if (!isDir && entry.typeflag !== '2' && entry.typeflag !== '1' && data.byteLength) {
    chunks.push(data);
    const pad = (512 - (data.byteLength % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  return chunks;
}

function buildLayerTar(entries) {
  const chunks = [];
  // parent dir entries first
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.name.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      if (i === parts.length && !e.name.endsWith('/')) break;
      dirs.add(parts.slice(0, i).join('/') + '/');
    }
  }
  for (const d of [...dirs].sort()) chunks.push(...entryBytes({ name: d, typeflag: '5', mode: 0o755 }));
  for (const e of entries) chunks.push(...entryBytes(e));
  chunks.push(new Uint8Array(1024));
  return concatChunks(chunks);
}

function concatChunks(chunks) {
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

function buildOuterTar(files) {
  const chunks = [];
  for (const f of files) {
    chunks.push(tarHeader({ name: f.name, mode: 0o644, size: f.data.byteLength, typeflag: '0' }));
    chunks.push(f.data);
    const pad = (512 - (f.data.byteLength % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  return concatChunks(chunks);
}

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function buildDemoImage() {
  const layerSpecs = [
    [
      { name: 'etc/demo-release', typeflag: '0', content: new TextEncoder().encode('layerscope demo image\n') },
      { name: 'app/config.yml', typeflag: '0', content: new TextEncoder().encode('version: 1\nreplicas: 1\n') },
      { name: 'app/data.bin', typeflag: '0', content: seededBytes(1536 * 1024, 7) },
    ],
    [
      { name: 'app/config.yml', typeflag: '0', content: new TextEncoder().encode('version: 2\nreplicas: 3\n') },
      { name: 'app/helper.sh', typeflag: '0', content: new TextEncoder().encode('#!/bin/sh\necho helper\n'), mode: 0o755 },
    ],
    [
      { name: 'app/.wh.data.bin', typeflag: '0', content: new Uint8Array(0) },
    ],
    [
      { name: 'app/notes.txt', typeflag: '0', content: new TextEncoder().encode('data.bin was removed in layer 3\n') },
    ],
  ];

  const history = [
    { created_by: '/bin/sh -c echo layerscope-demo > /etc/demo-release' },
    { created_by: 'ENV DEMO=true', empty_layer: true },
    { created_by: '/bin/sh -c sed -i s/version:.*/version: 2/ app/config.yml' },
    { created_by: '/bin/sh -c rm /app/data.bin' },
    { created_by: '/bin/sh -c echo notes > /app/notes.txt' },
  ];

  const layerTars = layerSpecs.map(buildLayerTar);
  const diffIds = [];
  for (const t of layerTars) diffIds.push('sha256:' + await sha256Hex(t));

  const config = {
    architecture: 'amd64',
    os: 'linux',
    created: new Date(MTIME * 1000).toISOString(),
    config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin'] },
    rootfs: { type: 'layers', diff_ids: diffIds },
    history: history.map((h) => ({ created: new Date(MTIME * 1000).toISOString(), created_by: h.created_by, ...(h.empty_layer ? { empty_layer: true } : {}) })),
  };
  const configBytes = new TextEncoder().encode(JSON.stringify(config, null, 2));
  const configDigest = await sha256Hex(configBytes);

  const files = [];
  layerTars.forEach((t, i) => {
    const id = diffIds[i].slice(7, 7 + 64);
    files.push({ name: `${id}/layer.tar`, data: t });
    files.push({ name: `${id}/VERSION`, data: new TextEncoder().encode('1.0\n') });
    files.push({ name: `${id}/json`, data: new TextEncoder().encode(JSON.stringify({ id, created: new Date(MTIME * 1000).toISOString() })) });
  });
  files.push({ name: `${configDigest}.json`, data: configBytes });
  files.push({
    name: 'manifest.json',
    data: new TextEncoder().encode(JSON.stringify([{
      Config: `${configDigest}.json`,
      RepoTags: ['layerscope/demo:latest'],
      Layers: layerTars.map((_, i) => `${diffIds[i].slice(7, 7 + 64)}/layer.tar`),
    }], null, 2)),
  });

  const outer = buildOuterTar(files);
  return new Blob([outer], { type: 'application/x-tar' });
}
