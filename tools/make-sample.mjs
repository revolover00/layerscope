// Regenerates assets/samples/layerscope-demo.tar — the small, bundled
// docker-save image loaded by the site's "Try a sample image" button.
// Deterministic (seeded PRNG for data.bin); commit the generated file.
//
//   node tools/make-sample.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeRawAsync } from './synth-lib.mjs';

const MTIME = 1577836800;

const dir = (name) => ({ name, typeflag: '5' });
const file = (name, content, extra = {}) => ({ name, content: Buffer.from(content), ...extra });
const whiteout = (name) => ({ name, typeflag: '0', content: Buffer.alloc(0) });

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
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

// Same story as the old in-browser demo: adds a big binary, modifies it away
// in a later layer via whiteout, keeps a duplicate config across layers —
// enough for the wasted-bytes and whiteout semantics to be visible.
const spec = {
  format: 'legacy',
  compression: 'none',
  repoTag: 'layerscope/sample:latest',
  layers: [
    [
      dir('etc/'),
      file('etc/sample-release', 'layerscope sample image\n'),
      dir('app/'),
      file('app/config.yml', 'version: 1\nreplicas: 1\n'),
      file('app/data.bin', seededBytes(64 * 1024, 7)),
    ],
    [
      dir('app/'),
      file('app/config.yml', 'version: 2\nreplicas: 3\n'),
      file('app/helper.sh', '#!/bin/sh\necho helper\n', { mode: 0o755 }),
    ],
    [
      dir('app/'),
      whiteout('app/.wh.data.bin'),
    ],
    [
      dir('app/'),
      file('app/notes.txt', 'data.bin was removed in layer 3\n'),
    ],
  ],
  history: [
    { created_by: '/bin/sh -c echo layerscope-sample > /etc/sample-release' },
    { created_by: 'ENV SAMPLE=true', empty_layer: true },
    { created_by: "/bin/sh -c sed -i 's/version:.*/version: 2/' app/config.yml" },
    { created_by: '/bin/sh -c rm /app/data.bin' },
    { created_by: '/bin/sh -c echo notes > /app/notes.txt' },
  ],
};

const buf = await synthesizeRawAsync(spec);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'samples', 'layerscope-demo.tar');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
console.log(`wrote ${out}: ${buf.length} bytes (${(buf.length / 1024).toFixed(1)} KiB)`);
