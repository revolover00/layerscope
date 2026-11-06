#!/usr/bin/env node
// Build the 6-layer / ~62 MiB incompressible random-content zstd OCI-save
// fixture used by the local benchmarks (same seeds as tools/bench-memory.mjs),
// so CI's browser benchmark exercises the exact pathological case.

import { writeFileSync } from 'node:fs';
import { synthesizeRawAsync, randomContent } from '../synth-lib.mjs';

const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? process.argv[outIdx + 1] : '/tmp/bench64-zstd.tar';

const layers = [];
const history = [];
const per = Math.floor((62 * 1024 * 1024) / 6);
for (let i = 0; i < 6; i++) {
  const entries = [{ name: `data/big-${i}.bin`, content: randomContent(per, 1234 + i), mode: 0o644 }];
  if (i === 1 || i === 4) entries.push({ name: 'meta/marker.txt', content: Buffer.alloc(68, 65), mode: 0o644 });
  layers.push(entries);
  history.push({ created_by: `RUN dd if=/dev/urandom of=/data/big-${i}.bin bs=1M` });
}
const buf = await synthesizeRawAsync({ format: 'oci-save', compression: 'zstd', layers, history, repoTag: 'layerscope/bench64:latest' });
writeFileSync(out, buf);
console.log(JSON.stringify({ out, layers: 6, bytes: buf.length, uncompressedBytes: layers.flat().reduce((a, e) => a + e.content.length, 0) }));
