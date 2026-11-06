// Precise numeric pins for the two waste metrics:
//   wastedBytes      dive's definition (kept identical for dive parity):
//                    Σ cumulative occurrence sizes of every path appearing in
//                    ≥ 2 layers or removed — INCLUDING the surviving copy.
//   reclaimableBytes layerscope's addition: wasted minus the bytes held by
//                    the copies that survive in the final squashed image
//                    (the last occurrence, or 0 when it is a deletion marker).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import { synthesizeRawAsync } from '../tools/synth-lib.mjs';

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

test('wasted (dive) vs reclaimable on a known multi-layer image', async () => {
  const A = Buffer.alloc(100, 0x41);   // version A — superseded
  const B = Buffer.alloc(30, 0x42);    // version B — superseded
  const C = Buffer.alloc(80, 0x43);    // version C — survives in the final image
  const keep = Buffer.alloc(20, 0x6b); // never duplicated — excluded from both metrics
  const doomed = Buffer.alloc(70, 0x64); // added in layer 2, whiteouted in layer 3

  const buf = await synthesizeRawAsync({
    format: 'legacy',
    compression: 'none',
    layers: [
      [{ name: 'app/lib.so', content: A, mode: 0o644 }, { name: 'keep/only.bin', content: keep, mode: 0o644 }],
      [{ name: 'app/lib.so', content: B, mode: 0o644 }, { name: 'gone/doomed.bin', content: doomed, mode: 0o644 }],
      [{ name: 'app/lib.so', content: C, mode: 0o644 }, { name: 'gone/.wh.doomed.bin', content: Buffer.alloc(0), mode: 0o644 }],
    ],
    history: null,
    repoTag: 'layerscope/reclaimable-fixture:latest',
  });

  const a = await analyzeImage(new MemBlob(buf));

  // Wasted (dive): cumulative over paths with ≥ 2 occurrences, surviving copy included.
  //   app/lib.so      100 + 30 + 80 = 210
  //   gone/doomed.bin  70 +  0(whiteout) =  70
  assert.equal(a.wastedBytes, 280);

  // Reclaimable: wasted minus what survives in the final squashed image.
  //   app/lib.so      210 − 80 (version C)      = 130
  //   gone/doomed.bin  70 − 0  (whiteouted away) =  70
  assert.equal(a.reclaimableBytes, 200);
  assert.ok(a.reclaimableBytes <= a.wastedBytes, 'reclaimable is always ≤ wasted');

  assert.equal(a.inefficiencies.length, 2);
  assert.match(a.inefficiencies[0].path, /app\/lib\.so$/);
  assert.equal(a.inefficiencies[0].sizeBytes, 210);

  // efficiency = Σ per-path minima ÷ Σ cumulative = (30 + 0 + 20) ÷ (210 + 70 + 20)
  assert.ok(Math.abs(a.efficiency - 50 / 300) < 1e-12, `efficiency ${a.efficiency}`);
});

test('a purely deleted file is 100% reclaimable', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 0x7a);

  const buf = await synthesizeRawAsync({
    format: 'legacy',
    compression: 'none',
    layers: [
      [{ name: 'big.bin', content: big, mode: 0o644 }],
      [{ name: '.wh.big.bin', content: Buffer.alloc(0), mode: 0o644 }],
    ],
    history: null,
    repoTag: 'layerscope/reclaimable-deleted:latest',
  });

  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.wastedBytes, big.length);      // dive counts it (with surviving copy = 0)
  assert.equal(a.reclaimableBytes, big.length); // nothing of the path survives
});
