#!/usr/bin/env node
// Build the crafted-FCS refusal fixture: a TINY OCI+zstd docker-save whose
// single layer is a zstd frame with a REAL 1 MiB body but an 8-byte frame
// content size of 17 GiB (hand-built header: fcsFlag 3, explicit 2 MiB window
// descriptor). No compressor emits this — it simulates a corrupt/malicious
// archive claiming an impossible decompressed size. The analyzer must refuse
// it on the header ALONE (before allocating anything), naming the 8 GiB
// default ceiling. Used by tools/browser-limit.mjs in the fixture job.
//
//   node tools/ci/build-crafted-fcs.mjs --out /tmp/bench/crafted-fcs-huge.tar
//
// The output is a few KB — no big allocation anywhere.

import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { synthesizeRawAsync } from '../synth-lib.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : null;
if (!out) { console.error('usage: node tools/ci/build-crafted-fcs.mjs --out FILE'); process.exit(2); }

const payload = Buffer.alloc(1024 * 1024, 65);
const donor = zlib.zstdCompressSync(payload, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
// strip the donor frame's header, keep only its block section
const donorFhd = donor[4];
const donorSingleSegment = (donorFhd >> 5) & 1;
const donorFcsFlag = (donorFhd >> 6) & 3;
let donorHeaderLen = 5;
donorHeaderLen += donorSingleSegment ? 0 : 1;            // window descriptor
donorHeaderLen += [0, 1, 2, 4][donorFhd & 0x3];           // dict id
donorHeaderLen += donorFcsFlag === 0 ? (donorSingleSegment ? 1 : 0) : [0, 2, 4, 8][donorFcsFlag]; // FCS
const blocks = donor.subarray(donorHeaderLen);
const frame = Buffer.concat([
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), // magic
  Buffer.from([0xc0]),                   // FHD: fcsFlag 3 (8-byte FCS), explicit window descriptor, no dict id
  Buffer.from([0x58]),                   // window descriptor: valid 2 MiB window
  (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(17n * 1024n * 1024n * 1024n); return b; })(),
  blocks,
]);

const buf = await synthesizeRawAsync({
  format: 'oci-save',
  compression: 'zstd',
  rawLayerBlobs: [frame],
  layers: [[{ name: 'data/zeros.bin', content: Buffer.alloc(1024, 65), mode: 0o644 }]],
  history: [{ created_by: 'RUN dd if=/dev/zero of=/data/zeros.bin bs=1G count=17' }],
  repoTag: 'layerscope/huge-claims:latest',
});
writeFileSync(out, buf);
console.log(JSON.stringify({ out, archiveBytes: buf.length, fcsClaimBytes: '18253611008 (17 GiB)', frameBytes: frame.length }));
