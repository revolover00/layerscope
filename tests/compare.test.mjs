// Tests for the dive-comparison lib (tools/lib-compare.mjs).
// The acceptance rule for fileReference: the sizeBytes SEQUENCE must be
// exactly equal to dive's; entries within contiguous groups of equal
// sizeBytes may permute freely, but the (file, count) multiset must match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAnalyses } from '../tools/lib-compare.mjs';

const BASE_FILE_LIST = [
  { path: 'a', typeFlag: 48, linkName: '', size: 100, uid: 0, gid: 0, fileMode: 420, isDir: false },
];

function makeAnalysis({ fileReference }) {
  return {
    layer: [{ index: 0, id: 'sha256:deadbeef', digestId: 'sha256:deadbeef', sizeBytes: 100, command: 'RUN x', fileList: BASE_FILE_LIST.map((f) => ({ ...f })) }],
    image: { sizeBytes: 100, inefficientBytes: 45, efficiencyScore: 0.55, fileReference: fileReference.map((e) => ({ ...e })) },
  };
}

// dive order: sizeBytes desc, ties path asc (dive main semantics)
const BASE_REF = [
  { count: 1, sizeBytes: 60, file: '/a.bin' },
  { count: 2, sizeBytes: 25, file: '/b.bin' },
  { count: 3, sizeBytes: 25, file: '/c.bin' },
  { count: 4, sizeBytes: 0, file: '/d' },
  { count: 5, sizeBytes: 0, file: '/e' },
];

test('identical analyses pass with 0 failures', () => {
  const { failures } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), makeAnalysis({ fileReference: BASE_REF }));
  assert.equal(failures, 0);
});

test('entries swapped WITHIN an equal-sizeBytes group still pass (dive v0.13.1 intra-tie order is undefined)', () => {
  const swapped = [BASE_REF[0], BASE_REF[2], BASE_REF[1], BASE_REF[4], BASE_REF[3]]; // swap 25-block and 0-block internals
  const { failures } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), makeAnalysis({ fileReference: swapped }));
  assert.equal(failures, 0);
});

test('two entries with DIFFERENT sizeBytes swapped FAILS (sizeBytes sequence must match dive exactly)', () => {
  const swapped = [BASE_REF[1], BASE_REF[0], BASE_REF[2], BASE_REF[3], BASE_REF[4]]; // sizes 25 and 60 swapped
  const { failures, lines } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), makeAnalysis({ fileReference: swapped }));
  assert.ok(failures > 0, 'expected at least one mismatch');
  assert.match(lines.join('\n'), /sizeBytes sequence diverges at index 0/);
});

test('a zero-byte entry moved ahead of a 60-byte entry FAILS', () => {
  const swapped = [BASE_REF[3], BASE_REF[0], BASE_REF[1], BASE_REF[2], BASE_REF[4]]; // /d (0 B) moved to front
  const { failures, lines } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), makeAnalysis({ fileReference: swapped }));
  assert.ok(failures > 0);
  assert.match(lines.join('\n'), /sizeBytes sequence diverges at index 0/);
});

test('within an equal-sizeBytes group, wrong (file, count) pairing FAILS', () => {
  const ours = makeAnalysis({ fileReference: BASE_REF });
  ours.image.fileReference[3] = { count: 99, sizeBytes: 0, file: '/d' }; // count changed, size same
  const { failures } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), ours);
  assert.ok(failures > 0);
});

test('within an equal-sizeBytes group, missing file FAILS', () => {
  const ours = makeAnalysis({ fileReference: BASE_REF });
  ours.image.fileReference[3] = { count: 4, sizeBytes: 0, file: '/nope' }; // wrong file, same size/count slot
  const { failures } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), ours);
  assert.ok(failures > 0);
});

test('fileReference length mismatch FAILS', () => {
  const ours = makeAnalysis({ fileReference: BASE_REF });
  ours.image.fileReference.pop();
  const { failures, lines } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), ours);
  assert.ok(failures > 0);
  assert.match(lines.join('\n'), /fileReference length differs/);
});

test('everything else stays exact: image sizeBytes mismatch FAILS even when fileReference matches', () => {
  const ours = makeAnalysis({ fileReference: BASE_REF });
  ours.image.sizeBytes = 101;
  const { failures } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), ours);
  assert.ok(failures > 0);
});

test('everything else stays exact: layer digestId mismatch FAILS', () => {
  const ours = makeAnalysis({ fileReference: BASE_REF });
  ours.layer[0].digestId = 'sha256:feedface';
  const { failures } = compareAnalyses(makeAnalysis({ fileReference: BASE_REF }), ours);
  assert.ok(failures > 0);
});

test('efficiencyScore within relative tolerance 1e-9 passes; beyond fails', () => {
  const dive = makeAnalysis({ fileReference: BASE_REF });
  const ok = makeAnalysis({ fileReference: BASE_REF });
  ok.image.efficiencyScore = dive.image.efficiencyScore * (1 + 5e-10);
  assert.equal(compareAnalyses(dive, ok).failures, 0);
  const bad = makeAnalysis({ fileReference: BASE_REF });
  bad.image.efficiencyScore = dive.image.efficiencyScore * (1 + 5e-9);
  assert.ok(compareAnalyses(dive, bad).failures > 0);
});
