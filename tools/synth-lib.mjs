// Shared tar/image synthesis used by tools/synth.mjs (sample images) and
// tools/fixtures.mjs (dive's fixture specs). Deterministic output.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const MTIME = 1577836800; // 2020-01-01T00:00:00Z

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomContent(size, seed) {
  const rand = mulberry32(seed);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function octalField(value, length) {
  const s = Math.floor(value).toString(8).padStart(length - 1, '0');
  return Buffer.from(s.slice(-(length - 1)) + '\0', 'ascii');
}

export function strField(value, length) {
  const buf = Buffer.alloc(length, 0);
  buf.write(String(value).slice(0, length), 0, 'utf8');
  return buf;
}

export function tarHeader({ name, mode, uid, gid, size, mtime, typeflag, linkname, prefix }) {
  const b = Buffer.alloc(512, 0);
  strField(name, 100).copy(b, 0);
  octalField(mode, 8).copy(b, 100);
  octalField(uid, 8).copy(b, 108);
  octalField(gid, 8).copy(b, 116);
  octalField(size, 12).copy(b, 124);
  octalField(mtime, 12).copy(b, 136);
  b.fill(0x20, 148, 156);
  b.write(typeflag, 156, 1, 'ascii');
  strField(linkname || '', 100).copy(b, 157);
  strField('ustar ', 6).copy(b, 257); // GNU tar magic (what dive's fixture writer emits)
  strField(' \x00', 2).copy(b, 263);
  // uname/gname intentionally left empty (zero blocks)
  octalField(0, 8).copy(b, 329);
  octalField(0, 8).copy(b, 337);
  if (prefix) strField(prefix, 155).copy(b, 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return b;
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name };
  const idx = name.lastIndexOf('/', 154);
  if (idx > 0 && idx <= 155 && Buffer.byteLength(name.slice(idx + 1)) <= 100) {
    return { name: name.slice(idx + 1), prefix: name.slice(0, idx) };
  }
  return { name, pax: true };
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  for (;;) {
    const s = String(len);
    if (Buffer.byteLength(s + body) === len) return Buffer.from(s + body, 'utf8');
    len = Buffer.byteLength(s + body);
  }
}

export function* entryBlocks(entry) {
  const data = entry.content || Buffer.alloc(0);
  const typeflag = entry.typeflag || '0';
  let { name, prefix, pax } = splitName(entry.name);
  if (pax) {
    const payload = paxRecord('path', entry.name);
    yield tarHeader({ name: 'PaxHeaders/layerscope', mode: 0o644, uid: 0, gid: 0, size: payload.length, mtime: MTIME, typeflag: 'x', linkname: '' });
    yield payload;
    const pad = (512 - (payload.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
    name = 'PaxHeaders/layerscope';
  }
  yield tarHeader({
    name, prefix,
    mode: entry.mode ?? (typeflag === '5' ? 0o755 : typeflag === '2' ? 0o777 : 0o644),
    uid: entry.uid ?? 0,
    gid: entry.gid ?? 0,
    size: typeflag === '5' || typeflag === '2' || typeflag === '1' ? 0 : data.length,
    mtime: MTIME,
    typeflag,
    linkname: entry.linkname || '',
  });
  if (typeflag !== '5' && typeflag !== '2' && typeflag !== '1' && data.length) {
    yield data;
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
}

export function buildLayerTar(entries) {
  const chunks = [];
  for (const e of entries) {
    for (const b of entryBlocks(e)) chunks.push(b);
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function dockerConfig(diffIds, history) {
  const cfg = {
    architecture: 'amd64',
    os: 'linux',
    created: new Date(MTIME * 1000).toISOString(),
    config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'] },
    rootfs: { type: 'layers', diff_ids: diffIds.map((d) => `sha256:${d}`) },
  };
  if (history) {
    cfg.history = history.map((h) => ({
      created: new Date(MTIME * 1000).toISOString(),
      created_by: h.created_by,
      ...(h.empty_layer ? { empty_layer: true } : {}),
    }));
  }
  return Buffer.from(JSON.stringify(cfg, null, 2));
}

export function tarballOf(files) {
  const chunks = [];
  for (const f of files) {
    const hdr = tarHeader({ name: f.name, mode: f.mode ?? 0o644, uid: 0, gid: 0, size: f.data ? f.data.length : 0, mtime: MTIME, typeflag: f.data ? '0' : '5', linkname: '' });
    chunks.push(hdr);
    if (f.data) {
      chunks.push(f.data);
      const pad = (512 - (f.data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

/**
 * spec: { format: 'legacy'|'oci-save'|'oci-archive', compression: 'none'|'gzip'|'zstd',
 *         layers: Entry[][], history: History[]|null, repoTag: string }
 */
export function synthesizeRaw(spec) {
  if (spec.compression === 'zstd') {
    throw new Error('zstd synthesis is asynchronous (wasm compressor) — use synthesizeRawAsync');
  }
  const layerTars = spec.layers.map((entries) => buildLayerTar(entries));
  return assembleArchive(spec, layerTars, compressLayersSync(spec, layerTars));
}

/** Async twin of synthesizeRaw: identical output, but zstd layers are compressed with the wasm decoder. */
export async function synthesizeRawAsync(spec) {
  const layerTars = spec.layers.map((entries) => buildLayerTar(entries));
  const layerBlobs = await compressLayersAsync(spec, layerTars);
  return assembleArchive(spec, layerTars, layerBlobs);
}

function compressLayersSync(spec, layerTars) {
  return layerTars.map((t) => {
    if (spec.format === 'legacy') return t;
    return spec.compression === 'gzip' ? gzipSync(t, { level: 9 }) : t;
  });
}

async function compressLayersAsync(spec, layerTars) {
  // spec.rawLayerBlobs: pre-built layer blobs injected verbatim (fixtures for
  // frames a compressor won't emit, e.g. a crafted 17 GiB content-size claim).
  if (spec.rawLayerBlobs) return spec.rawLayerBlobs;
  if (spec.compression !== 'zstd') return compressLayersSync(spec, layerTars);
  if (spec.format === 'legacy') return layerTars; // legacy: uncompressed layers
  // node's native zstd (node >= 22.15) — required for zstd synthesis.
  const zlib = await import('node:zlib');
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw new Error('zstd fixture synthesis requires node >= 22.15 (native zlib zstd)');
  }
  // spec.zstdContentSizeFlag === 0 emits frames WITHOUT a content size —
  // fixtures for streamed compression as produced by containerd/buildx.
  const extra = spec.zstdContentSizeFlag != null ? { [zlib.constants.ZSTD_c_contentSizeFlag]: spec.zstdContentSizeFlag } : {};
  return layerTars.map((t) => zlib.zstdCompressSync(t, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, ...extra } }));
}

function assembleArchive(spec, layerTars, layerBlobs) {
  const repoTag = spec.repoTag || 'fixture:latest';
  const diffIds = layerTars.map(sha256);
  const configJson = dockerConfig(diffIds, spec.history);
  const configDigest = sha256(configJson);

  const files = [];
  const addFile = (name, data, mode) => files.push({ name, data, mode });

  const layerDescriptors = layerBlobs.map((blobBuf) => ({
    digest: `sha256:${sha256(blobBuf)}`,
    mediaType: spec.format === 'legacy'
      ? 'application/vnd.docker.image.rootfs.diff.tar'
      : `application/vnd.oci.image.layer.v1.tar${spec.compression === 'gzip' ? '+gzip' : spec.compression === 'zstd' ? '+zstd' : ''}`,
    size: blobBuf.length,
  }));

  if (spec.format === 'legacy') {
    layerTars.forEach((t, i) => {
      const id = diffIds[i].slice(0, 64);
      addFile(`${id}/layer.tar`, t);
      addFile(`${id}/VERSION`, Buffer.from('1.0\n'));
      addFile(`${id}/json`, Buffer.from(JSON.stringify({ id, created: new Date(MTIME * 1000).toISOString() })));
    });
    addFile(`${configDigest}.json`, configJson);
    addFile('manifest.json', Buffer.from(JSON.stringify([{
      Config: `${configDigest}.json`,
      RepoTags: [repoTag],
      Layers: diffIds.map((d) => `${d.slice(0, 64)}/layer.tar`),
    }], null, 2)));
    addFile('repositories', Buffer.from(JSON.stringify({ [repoTag.split(':')[0]]: { [repoTag.split(':')[1] || 'latest']: diffIds[0].slice(0, 64) } }, null, 2)));
    return tarballOf(files);
  }

  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${configDigest}`, size: configJson.length },
    layers: layerDescriptors,
  }, null, 2));
  const manifestDigest = sha256(manifest);
  const layerBlobPaths = layerBlobs.map((b) => `blobs/sha256/${sha256(b)}`);

  addFile('blobs/sha256/' + configDigest, configJson);
  layerBlobs.forEach((b, i) => addFile(layerBlobPaths[i], b));
  addFile('blobs/sha256/' + manifestDigest, manifest);
  addFile('oci-layout', Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' })));
  addFile('index.json', Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${manifestDigest}`,
      size: manifest.length,
      annotations: {
        'io.containerd.image.name': 'docker.io/library/' + repoTag,
        'org.opencontainers.image.ref.name': repoTag,
      },
    }],
  }, null, 2)));

  if (spec.format === 'oci-save') {
    addFile('manifest.json', Buffer.from(JSON.stringify([{
      Config: `blobs/sha256/${configDigest}`,
      RepoTags: [repoTag],
      Layers: layerBlobPaths,
    }], null, 2)));
    addFile('repositories', Buffer.from(JSON.stringify({ [repoTag.split(':')[0]]: { [repoTag.split(':')[1] || 'latest']: layerBlobPaths[0] } }, null, 2)));
  }
  return tarballOf(files);
}
