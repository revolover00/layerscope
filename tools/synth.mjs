#!/usr/bin/env node
// Synthesize small, deterministic docker-save / OCI-layout image tarballs
// without a Docker daemon. The specs in IMAGES mirror the Dockerfiles in
// samples/ so local runs exercise the same paths as CI.
//
// Usage:
//   node tools/synth.mjs --all [--dir /tmp/layerscope-images]
//   node tools/synth.mjs --image add-delete --format legacy --compression none
// Output: <dir>/<image>.<format>[.<compression>].tar

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomContent, synthesizeRaw } from './synth-lib.mjs';

// Docker layers carry explicit directory entries; emit them for realism.
// (Dirs first is fine — layer order inside the tar does not matter.)
function withDirs(entries) {
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.name.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      if (i === parts.length && !e.name.endsWith('/')) break;
      dirs.add(parts.slice(0, i).join('/') + '/');
    }
  }
  const out = [];
  for (const d of [...dirs].sort()) out.push({ name: d, typeflag: '5', mode: 0o755 });
  return [...out, ...entries];
}

// Sample specs — keep in sync with samples/<name>/Dockerfile used by CI.
const IMAGES = {
  'add-delete': {
    repoTag: 'example/add-delete:latest',
    layers: [
      [
        { name: 'etc/keep.txt', content: Buffer.from('keep me\n') },
        { name: 'big.bin', content: randomContent(2 * 1024 * 1024, 101) },
      ],
      [{ name: '.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) }],
      [{ name: 'hello.txt', content: Buffer.from('hello world\n') }],
    ],
    history: [
      { created_by: '/bin/sh -c mkdir -p /etc && dd if=/dev/urandom of=/big.bin bs=1k count=2048' },
      { created_by: 'ENV APP_ENV=production', empty_layer: true },
      { created_by: '/bin/sh -c rm /big.bin' },
      { created_by: '/bin/sh -c echo hello > /hello.txt' },
    ],
  },
  'overwrite': {
    repoTag: 'example/overwrite:latest',
    layers: [
      [
        { name: 'config.txt', content: Buffer.from('original-config-content\n') },
        { name: 'data.bin', content: randomContent(512 * 1024, 202) },
      ],
      [{ name: 'config.txt', content: Buffer.from('modified-config-content-v2 with different bytes\n') }],
      [
        { name: 'data.bin', content: randomContent(512 * 1024, 303) },
        { name: 'config.txt', content: Buffer.from('modified-config-content-v3 third edition\n') },
      ],
    ],
    history: [
      { created_by: '/bin/sh -c printf original > /config.txt && dd if=/dev/urandom of=/data.bin bs=1k count=512' },
      { created_by: 'ENV BUILD_STAGE=1', empty_layer: true },
      { created_by: '/bin/sh -c sed -i s/original/modified/ /config.txt' },
      { created_by: '/bin/sh -c dd if=/dev/urandom of=/data.bin bs=1k count=512 && sed -i s/v2/v3/ /config.txt' },
    ],
  },
  'multi-waste': {
    repoTag: 'example/multi-waste:latest',
    layers: [
      [
        { name: 'opt/app/assets/blob.bin', content: randomContent(1024 * 1024, 404) },
        { name: 'opt/app/blob-link', typeflag: '2', linkname: 'opt/app/assets/blob.bin' },
        { name: 'opt/app/blob-copy.bin', content: randomContent(1024 * 1024, 404) }, // same seed => identical bytes
        { name: 'opt/app/blob-hard.bin', typeflag: '1', linkname: 'opt/app/assets/blob.bin' },
        { name: 'opt/app/very/deeply/nested/directory/structure/to/exercise/longer/paths/and/keep/parsing/honest/about/ustar/prefix-splitting/file-that-is-much-too-long.txt', content: Buffer.from('deep path file\n') },
        { name: 'opt/emptydir/', typeflag: '5' },
      ],
      [
        { name: 'opt/app/.wh.assets', typeflag: '0', content: Buffer.alloc(0) },
        { name: 'later.txt', content: Buffer.from('added after the removal\n') },
      ],
      [{ name: 'etc/app.conf', content: Buffer.from('setting=value\n') }],
    ],
    history: [
      { created_by: '/bin/sh -c mkdir -p /opt/app/assets && dd if=/dev/urandom of=/opt/app/assets/blob.bin bs=1k count=1024' },
      { created_by: '/bin/sh -c rm -rf /opt/app/assets' },
      { created_by: '/bin/sh -c printf setting=value > /etc/app.conf' },
    ],
  },
};

export const IMAGE_NAMES = Object.keys(IMAGES);

export function synthesize(imageName, format, compression) {
  const spec = IMAGES[imageName];
  if (!spec) throw new Error(`unknown image spec: ${imageName}`);
  return synthesizeRaw({
    format,
    compression: compression === 'raw' ? 'none' : compression,
    layers: spec.layers.map(withDirs),
    history: spec.history,
    repoTag: spec.repoTag,
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith('synth.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const dir = get('--dir', '/tmp/layerscope-images');
  mkdirSync(dir, { recursive: true });
  const all = args.includes('--all');
  const image = get('--image', null);
  const formats = all ? ['legacy', 'oci-save', 'oci-archive'] : [get('--format', 'legacy')];
  const imageNames = all ? IMAGE_NAMES : [image || 'add-delete'];
  for (const img of imageNames) {
    for (const format of formats) {
      if (format === 'legacy') {
        const out = join(dir, `${img}.legacy.tar`);
        const buf = synthesize(img, 'legacy', 'none');
        writeFileSync(out, buf);
        console.log(`wrote ${out} (${buf.length} bytes)`);
      } else {
        const out = join(dir, `${img}.${format}.gzip.tar`);
        const buf = synthesize(img, format, 'gzip');
        writeFileSync(out, buf);
        console.log(`wrote ${out} (${buf.length} bytes)`);
      }
    }
  }
}
