#!/usr/bin/env node
// Generates the two fixtures used by the browser-bench assertion job:
//   test1-waste.tar — legacy docker-save (manifest.json) layout
//   test3-zstd.tar  — identical image content, OCI layout with zstd layers
//
// Deliberate content spec (MUST stay in sync with the browser-bench.yml
// assertion):
//   layer 0  base     — app/config.txt (200 KiB random) + small files
//   layer 1           — adds data/big.bin (5 MiB random)
//   layer 2           — deletes it: whiteout data/.wh.big.bin
//   layer 3           — rewrites app/config.txt (200 KiB random, different bytes)
//   history           — four layer steps + one empty_layer CMD entry
//
// Expected analysis (layerscope, verified locally before wiring CI):
//   layerCount = 4, wastedBytes = 5,652,480, efficiency ≈ 3.6%
//   (data/big.bin 5 MiB single-counted through the whiteout path +
//    app/config.txt in two occurrences × 200 KiB).
//
// Usage:
//   node tools/test-fixtures.mjs --out /tmp/layerscope-fixtures
//       → writes <out>/test1-waste.tar and <out>/test3-zstd.tar

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomContent, synthesizeRaw, synthesizeRawAsync } from './synth-lib.mjs';

// Docker layers carry explicit directory entries; emit them for realism.
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

const SMALL_FILES = [
  { name: 'etc/keep.txt', content: Buffer.from('keep-me: layerscope browser-bench fixture\n') },
  { name: 'app/start.sh', content: Buffer.from('#!/bin/sh\necho fixture\n'), mode: 0o755 },
  { name: 'app/readme.txt', content: Buffer.from('fixture image for browser-bench\n') },
];

const layers = () => [
  withDirs([
    { name: 'app/config.txt', content: randomContent(200 * 1024, 1001), mode: 0o644 },
    ...SMALL_FILES,
  ]),
  withDirs([
    { name: 'data/big.bin', content: randomContent(5 * 1024 * 1024, 1002), mode: 0o644 },
  ]),
  withDirs([
    { name: 'data/.wh.big.bin', typeflag: '0', content: Buffer.alloc(0) },
  ]),
  withDirs([
    { name: 'app/config.txt', content: randomContent(200 * 1024, 1003), mode: 0o644 },
  ]),
];

const HISTORY = [
  { created_by: '/bin/sh -c mkdir -p /app /data && dd if=/dev/urandom of=/app/config.txt bs=1k count=200' },
  { created_by: '/bin/sh -c dd if=/dev/urandom of=/data/big.bin bs=1M count=5' },
  { created_by: '/bin/sh -c rm /data/big.bin' },
  { created_by: 'CMD ["/app/start.sh"]', empty_layer: true },
  { created_by: '/bin/sh -c sed -i s/a/c/ /app/config.txt' },
];

const outDir = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : '/tmp/layerscope-fixtures';
})();
mkdirSync(outDir, { recursive: true });

const legacy = synthesizeRaw({ format: 'legacy', compression: 'none', layers: layers(), history: HISTORY, repoTag: 'layerscope/test-waste:latest' });
writeFileSync(join(outDir, 'test1-waste.tar'), legacy);
console.log(`wrote ${join(outDir, 'test1-waste.tar')} (${legacy.length} bytes)`);

const zstdBuf = await synthesizeRawAsync({ format: 'oci-save', compression: 'zstd', layers: layers(), history: HISTORY, repoTag: 'layerscope/test-zstd:latest' });
writeFileSync(join(outDir, 'test3-zstd.tar'), zstdBuf);
console.log(`wrote ${join(outDir, 'test3-zstd.tar')} (${zstdBuf.length} bytes)`);

console.log('expected (per ci assert): 4 layers, wasted 5652480 bytes, efficiency ≈ 3.6%');
