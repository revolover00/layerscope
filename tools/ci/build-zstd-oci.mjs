#!/usr/bin/env node
// Build an OCI-layout image archive whose layer is a REAL filesystem rootfs
// tar recompressed with zstd — i.e. a genuine compressible zstd layer, unlike
// the random-content synthetic fixtures.
//
// Usage:
//   node tools/ci/build-zstd-oci.mjs --rootfs rootfs.tar --out out.tar --tag name:tag [--level 3]
//
// The emitted archive is dual-format (oci-layout + legacy manifest.json /
// repositories), like `docker save` of an OCI image, so layerscope's normal
// analysis path applies. The single manifest carries a linux/amd64 platform.

import { readFileSync, writeFileSync } from 'node:fs';
import { sha256, dockerConfig, tarballOf } from '../synth-lib.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const rootfsPath = opt('rootfs');
const outPath = opt('out');
const tag = opt('tag') || 'alpine:latest';
const level = Number(opt('level') || 3);
if (!rootfsPath || !outPath) {
  console.error('usage: node tools/ci/build-zstd-oci.mjs --rootfs rootfs.tar --out out.tar [--tag name] [--level N]');
  process.exit(2);
}

const rootfs = readFileSync(rootfsPath);
const diffId = sha256(rootfs);

// Prefer node's native zstd (node >= 22.15); the vendored wasm CJS compressor
// degrades in-process after enough calls and is slower on large layers.
let layerZst = null;
try {
  const zlib = await import('node:zlib');
  if (typeof zlib.zstdCompressSync === 'function') {
    layerZst = zlib.zstdCompressSync(rootfs, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
  }
} catch { /* fall through to wasm */ }
if (!layerZst) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const wasm = require('@bokuweb/zstd-wasm');
  await wasm.init();
  layerZst = Buffer.from(wasm.compress(rootfs, level));
}
const layerDigest = sha256(layerZst);

const MTIME = Math.floor(Date.now() / 1000);
const history = [
  { created_by: '/bin/sh -c #(nop) ADD rootfs.tar / # recompressed with zstd for layerscope CI' },
  { created_by: '/bin/sh -c #(nop) CMD ["/bin/sh"]', empty_layer: true },
];
const cfgJson = (() => {
  const cfg = JSON.parse(dockerConfig([diffId], history).toString('utf8'));
  cfg.created = new Date(MTIME * 1000).toISOString();
  cfg.config = { ...cfg.config, Cmd: ['/bin/sh'] };
  return Buffer.from(JSON.stringify(cfg, null, 2));
})();
const cfgDigest = sha256(cfgJson);

const manifest = Buffer.from(JSON.stringify({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${cfgDigest}`, size: cfgJson.length },
  layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+zstd', digest: `sha256:${layerDigest}`, size: layerZst.length }],
}, null, 2));
const manifestDigest = sha256(manifest);

const files = [
  { name: `blobs/sha256/${cfgDigest}`, data: cfgJson },
  { name: `blobs/sha256/${layerDigest}`, data: layerZst },
  { name: `blobs/sha256/${manifestDigest}`, data: manifest },
  { name: 'oci-layout', data: Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' })) },
  { name: 'index.json', data: Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${manifestDigest}`,
      size: manifest.length,
      annotations: { 'io.containerd.image.name': 'docker.io/library/' + tag, 'org.opencontainers.image.ref.name': tag },
      platform: { os: 'linux', architecture: 'amd64' },
    }],
  }, null, 2)) },
  // dual-format like `docker save` so the legacy reader path is exercised too
  { name: 'manifest.json', data: Buffer.from(JSON.stringify([{
    Config: `blobs/sha256/${cfgDigest}`,
    RepoTags: [tag],
    Layers: [`blobs/sha256/${layerDigest}`],
  }], null, 2)) },
  { name: 'repositories', data: Buffer.from(JSON.stringify({ [tag.split(':')[0]]: { [tag.split(':')[1] || 'latest']: `blobs/sha256/${layerDigest}` } }, null, 2)) },
];

const out = tarballOf(files);
writeFileSync(outPath, out);
console.log(JSON.stringify({
  out: outPath,
  tag,
  format: 'oci-save (dual-format)',
  layers: 1,
  uncompressedLayerBytes: rootfs.length,
  zstdLayerBytes: layerZst.length,
  archiveBytes: out.length,
  ratio: +(layerZst.length / rootfs.length).toFixed(4),
  zstdLevel: level,
}, null, 2));
