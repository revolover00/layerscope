// End-to-end analysis assertions over synthetic images with known structure.
// These run the real analyzer over real (synthesized) archives; the numeric
// expectations follow from the specs, not from hardcoded dive output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage } from '../src/core/analyze.js';
import zlib from 'node:zlib';

import { synthesize } from '../tools/synth.mjs';
import { buildFixtureAsync, buildMultiManifestFixture } from '../tools/fixtures.mjs';
import { tarballOf } from '../tools/synth-lib.mjs';

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

test('a gzip-wrapped outer archive (.tar.gz) analyzes like the unwrapped one', async () => {
  // docker save output piped through gzip: the analyzer stream-decompresses the
  // wrapper and analyzes the tar inside — result must be identical.
  const inner = synthesize('add-delete', 'legacy', 'none');
  const wrapped = zlib.gzipSync(inner);
  const plain = await analyzeImage(new MemBlob(inner));
  const via = await analyzeImage(new MemBlob(wrapped));
  assert.equal(via.layerCount, plain.layerCount);
  assert.equal(via.totalSizeBytes, plain.totalSizeBytes);
  assert.equal(via.wastedBytes, plain.wastedBytes);
  assert.equal(via.efficiency, plain.efficiency);
  assert.equal(via.reclaimableBytes, plain.reclaimableBytes);
  assert.deepEqual(
    via.layers.map((l) => [l.sizeBytes, l.compression, l.entryCount]),
    plain.layers.map((l) => [l.sizeBytes, l.compression, l.entryCount]),
  );
});

test('a zstd-wrapped outer archive with a corrupt payload fails with a targeted message', async () => {
  // routing recognizes the zstd magic, but the payload is not a real frame: the
  // error must name the wrapper, not an opaque "no manifest" or a checksum complaint.
  const wrapped = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00]),
    Buffer.from('not really zstd payload, just the magic'),
  ]);
  await assert.rejects(
    () => analyzeImage(new MemBlob(wrapped)),
    /outer zstd \(\.tar\.zst\) wrapper/,
  );
});

test('zstd-compressed layers analyze identically to the uncompressed one', async () => {
  // Property: compression must not change the analysis. The vendored wasm
  // decoder (or the native DecompressionStream where present) must produce
  // the same diffIDs, wasted bytes and efficiency score.
  const a = await analyzeImage(new MemBlob(await buildFixtureAsync('oci-save')));
  const b = await analyzeImage(new MemBlob(await buildFixtureAsync('oci-save-zstd')));
  assert.equal(b.layerCount, a.layerCount);
  assert.deepEqual(b.layers.map((l) => l.digestId), a.layers.map((l) => l.digestId));
  assert.equal(b.wastedBytes, a.wastedBytes);
  assert.equal(b.efficiency, a.efficiency);
  assert.equal(b.totalSizeBytes, a.totalSizeBytes);
  assert.deepEqual(b.topLayerEntries, a.topLayerEntries);
});

test('multi-manifest OCI index: defaults to linux/amd64 with a visible warning', async () => {
  const buf = await buildMultiManifestFixture();
  const a = await analyzeImage(new MemBlob(buf));
  assert.equal(a.selectedPlatform, 'linux/amd64');
  assert.match(a.layers[0].command, /amd64/);
  assert.ok(a.warnings.some((w) => /2 manifests/.test(w) && /linux\/amd64/.test(w)), `warning lists platforms: ${a.warnings.join(' | ')}`);
  assert.equal(a.platforms.length, 2);
  assert.equal(a.platforms.filter((p) => p.selected).length, 1);
});

test('multi-manifest OCI index: explicit platform selection switches the analyzed manifest', async () => {
  const buf = await buildMultiManifestFixture();
  const a = await analyzeImage(new MemBlob(buf), { platform: 'linux/arm64/v8' });
  assert.equal(a.selectedPlatform, 'linux/arm64/v8');
  assert.match(a.layers[0].command, /arm64v8/);
  const b = await analyzeImage(new MemBlob(buf), { platform: 'linux/arm64' });
  assert.equal(b.selectedPlatform, 'linux/arm64/v8', 'variant-less query matches linux/arm64/v8');
});

test('multi-manifest OCI index: unknown platform falls back to the default with a warning', async () => {
  const buf = await buildMultiManifestFixture();
  const a = await analyzeImage(new MemBlob(buf), { platform: 'linux/s390x' });
  assert.equal(a.selectedPlatform, 'linux/amd64');
  assert.ok(a.warnings.some((w) => /not present/.test(w)), `fallback warning present: ${a.warnings.join(' | ')}`);
});

test('zstd fallback limit: layer above maxLayerBytes fails with a clear, actionable error', async () => {
  const buf = await buildFixtureAsync('oci-save-zstd'); // small but real zstd layer
  await assert.rejects(
    () => analyzeImage(new MemBlob(buf), { maxLayerBytes: 1 }),
    (err) => {
      assert.match(err.message, /exceeding the 0 MiB \(1 bytes\) fallback limit/);
      assert.match(err.message, /gzip/); // tells the user the streaming alternative
      return true;
    },
  );
});

test('zstd fallback limit: layer under a generous maxLayerBytes passes', async () => {
  const buf = await buildFixtureAsync('oci-save-zstd');
  const a = await analyzeImage(new MemBlob(buf), { maxLayerBytes: 512 * 1024 * 1024 });
  assert.equal(a.layerCount, 3);
});


// ---- archive surgery helpers (the outer tar is uncompressed; ustar) --------
function splitOuterTar(buf) {
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    if (prefix) name = prefix + '/' + name;
    const sizeOct = h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    const size = sizeOct ? parseInt(sizeOct, 8) : 0;
    files.set(name, Buffer.from(buf.subarray(off + 512, off + 512 + size)));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function joinOuterTar(files) {
  return tarballOf([...files.entries()].map(([name, data]) => ({ name, data })));
}

test('zstd fallback limit: refuses BEFORE allocating when the zstd frame FCS is above the limit', async () => {
  const buf = await buildFixtureAsync('oci-save-zstd'); // frames carry a content size
  await assert.rejects(
    () => analyzeImage(new MemBlob(buf), { maxLayerBytes: 1 }),
    (err) => {
      assert.match(err.message, /refusing to decode before allocating/);
      assert.match(err.message, /fallback limit/);
      return true;
    },
  );
});

test('integrity check: a zstd layer that does not match rootfs.diff_ids fails with a clear error', async () => {
  const buf = await buildFixtureAsync('oci-save-zstd');
  const files = splitOuterTar(buf);
  // find the root-level config (legacy docker-save path: <digest>.json)
  const cfgName = JSON.parse(files.get('manifest.json').toString('utf8'))[0].Config;
  const cfg = JSON.parse(files.get(cfgName).toString('utf8'));
  assert.ok(Array.isArray(cfg.rootfs?.diff_ids) && cfg.rootfs.diff_ids.length > 0, 'fixture config has diff_ids');
  cfg.rootfs.diff_ids[0] = 'sha256:' + 'a'.repeat(64); // lie about layer 1's uncompressed digest
  files.set(cfgName, Buffer.from(JSON.stringify(cfg, null, 2)));
  const tampered = joinOuterTar(files);
  await assert.rejects(
    () => analyzeImage(new MemBlob(tampered)),
    (err) => {
      assert.match(err.message, /Integrity check failed/);
      assert.match(err.message, /rootfs\.diff_ids/);
      assert.match(err.message, /layer 1\/3/);
      return true;
    },
  );
});

test('integrity check: a config without rootfs.diff_ids yields a warning, not a failure', async () => {
  const buf = await buildFixtureAsync('oci-save-zstd');
  const files = splitOuterTar(buf);
  const cfgName = JSON.parse(files.get('manifest.json').toString('utf8'))[0].Config;
  const cfg = JSON.parse(files.get(cfgName).toString('utf8'));
  delete cfg.rootfs; // no expectations — analysis must proceed with a visible warning
  files.set(cfgName, Buffer.from(JSON.stringify(cfg, null, 2)));
  const tampered = joinOuterTar(files);
  const a = await analyzeImage(new MemBlob(tampered));
  assert.equal(a.layerCount, 3);
  assert.ok(a.warnings.some((w) => /diff_ids/.test(w) && /NOT verified/.test(w)), `warning present: ${a.warnings.join(' | ')}`);
});
