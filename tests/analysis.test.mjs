// End-to-end analysis assertions over synthetic images with known structure.
// These run the real analyzer over real (synthesized) archives; the numeric
// expectations follow from the specs, not from hardcoded dive output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import zlib from 'node:zlib';

import { synthesize } from '../tools/synth.mjs';

class MemBlob {
  constructor(buf) { this.buf = buf; this.size = buf.length; }
  slice(start, end) {
    const b = this.buf.subarray(start, end);
    return { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

const big = 2 * 1024 * 1024;

for (const format of ['legacy', 'oci-save', 'oci-archive']) {
  test(`add-delete analyzes correctly (${format})`, async () => {
    const buf = synthesize('add-delete', format, 'gzip');
    const a = await analyzeImage(new MemBlob(buf));

    assert.equal(a.layerCount, 3);
    // commands: ENV empty_layer entry is skipped, not assigned to a layer
    assert.match(a.layers[0].command, /dd if=\/dev\/urandom of=\/big\.bin/);
    assert.equal(a.layers[1].command, 'rm /big.bin');
    assert.equal(a.layers[2].command, 'echo hello > /hello.txt');

    // the 2 MiB file was added then deleted: it still occupies layer 0
    assert.equal(a.inefficiencies.length, 1);
    assert.equal(a.inefficiencies[0].path, '/big.bin');
    assert.equal(a.inefficiencies[0].count, 2);
    assert.equal(a.inefficiencies[0].sizeBytes, big);
    assert.equal(a.wastedBytes, big);

    // efficiency = sum(min)/sum(cumulative) over all paths
    // paths: /big.bin (2MiB, +whiteout 0), /etc/keep.txt (8), /etc, /hello.txt (12), /
    // only leaf paths are counted: /big.bin, /etc/keep.txt, /hello.txt
    const discovered = big + 8 + 12;
    const minimum = 0 + 8 + 12;
    assert.equal(a.totalSizeBytes, big + 8 + 12 + 0 + 0);
    assert.ok(Math.abs(a.efficiency - minimum / discovered) < 1e-12);

    // deleted entry reported on the removing layer with size from lower layer
    const del = a.layers[1].deleted;
    assert.equal(del.length, 1);
    assert.equal(del[0].path, '/big.bin');
    assert.equal(del[0].directory, false);

    // layer 0 lists big.bin as added
    assert.ok(a.layers[0].added.some((e) => e.path === '/big.bin'));
  });
}

test('overwrite marks files modified across layers', async () => {
  const buf = synthesize('overwrite', 'legacy', 'none');
  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.layerCount, 3);

  assert.ok(a.layers[1].modified.some((e) => e.path === '/config.txt'));
  assert.ok(a.layers[2].modified.some((e) => e.path === '/data.bin'));
  assert.ok(a.layers[2].modified.some((e) => e.path === '/config.txt'));

  const config = a.inefficiencies.find((x) => x.path === '/config.txt');
  assert.equal(config.count, 3);
  const data = a.inefficiencies.find((x) => x.path === '/data.bin');
  assert.equal(data.count, 2);
});

test('multi-waste handles dir whiteouts and hardlinks', async () => {
  const buf = synthesize('multi-waste', 'legacy', 'none');
  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.layerCount, 3);

  // layer 1 removes /opt/app/assets (a directory): one dir whiteout,
  // removedBytes must cover the whole subtree under it
  const assets = a.layers[1].deleted.find((e) => e.path === '/opt/app/assets');
  assert.ok(assets, 'dir whiteout reported');
  assert.equal(assets.directory, true);
  assert.equal(assets.targetKnown, true);
  assert.ok(assets.removedBytes >= 1024 * 1024);

  // dive's algorithm counts the dir whiteout as ONE occurrence at the dir path,
  // never per child file; nothing in this image appears in more than one layer,
  // so there is no inefficiency at all (matching dive semantics).
  assert.equal(a.inefficiencies.length, 0);
  assert.equal(a.efficiency, 1);
});

test('git-style top files list is sorted and bounded', async () => {
  const buf = synthesize('multi-waste', 'legacy', 'none');
  const a = await analyzeImage(new MemBlob(buf), { topLimit: 3 });
  assert.ok(a.topLayerEntries.length <= 3);
  for (let i = 1; i < a.topLayerEntries.length; i++) {
    assert.ok(a.topLayerEntries[i - 1].size >= a.topLayerEntries[i].size);
  }
  assert.ok(a.topFinalFiles.length <= 3);
});

test('a gzip-wrapped outer archive (.tar.gz) is rejected with a targeted message', async () => {
  // docker save output piped through gzip: impossible to random-access, so the
  // analyzer must fail fast and say why instead of "no manifest.json".
  const inner = synthesize('add-delete', 'legacy', 'none');
  const wrapped = zlib.gzipSync(inner);
  await assert.rejects(
    () => analyzeImage(new MemBlob(wrapped)),
    /gzip-compressed/,
  );
});

test('a zstd-wrapped outer archive (.tar.zst) is rejected with a targeted message', async () => {
  const wrapped = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00]),
    Buffer.from('not really zstd payload, just the magic'),
  ]);
  await assert.rejects(
    () => analyzeImage(new MemBlob(wrapped)),
    /zstd-compressed/,
  );
});
