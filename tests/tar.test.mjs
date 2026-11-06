// Unit tests for the tar parser and path helpers.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { iterTarEntries, blobReadableStream, cleanPath } from '../src/core/tar.js';
import { isWhiteout, isOpaqueMarker, unWhiteoutPath, parentPath, baseName } from '../src/core/model.js';
import { buildLayerTar, randomContent } from '../tools/synth-lib.mjs';

const MTIME_ENTRIES = () => [
  { name: 'etc/app/', typeflag: '5' },
  { name: 'etc/app/config.txt', content: Buffer.from('key=value\n') },
  { name: 'bigfile.bin', content: randomContent(1234, 42) },
  { name: 'empty.bin', content: Buffer.alloc(0) },
  { name: 'aligned.bin', content: Buffer.alloc(1024, 7) }, // exactly 2 blocks
  { name: 'link-to-config', typeflag: '2', linkname: 'etc/app/config.txt' },
  { name: 'hard-to-config', typeflag: '1', linkname: 'etc/app/config.txt' },
  { name: 'etc/app/.wh.deleted.txt', typeflag: '0', content: Buffer.alloc(0) },
  { name: 'etc/app/.wh..wh..opq', typeflag: '0', content: Buffer.alloc(0) },
];

async function parseAll(tarBuf, chunkSize) {
  const blob = {
    size: tarBuf.length,
    slice: (s, e) => ({
      size: e - s,
      arrayBuffer: async () => tarBuf.buffer.slice(tarBuf.byteOffset + s, tarBuf.byteOffset + e),
    }),
  };
  const entries = [];
  for await (const item of iterTarEntries(blobReadableStream(blob, 0, blob.size, chunkSize))) {
    entries.push({ ...item.header, data: item.data });
  }
  return entries;
}

test('parses a layer tar end to end (single chunk)', async () => {
  const tar = buildLayerTar(MTIME_ENTRIES());
  const entries = await parseAll(tar, 1024 * 1024);
  const byPath = new Map(entries.map((e) => [e.path, e]));

  assert.equal(byPath.get('/etc/app/config.txt').size, 10);
  assert.equal(byPath.get('/etc/app/config.txt').type, 'file');
  assert.equal(byPath.get('/etc/app').type, 'directory');
  assert.equal(byPath.get('/bigfile.bin').size, 1234);
  assert.equal(byPath.get('/empty.bin').size, 0);
  assert.equal(byPath.get('/aligned.bin').size, 1024);
  assert.equal(byPath.get('/link-to-config').type, 'symlink');
  assert.equal(byPath.get('/link-to-config').linkname, 'etc/app/config.txt');
  assert.equal(byPath.get('/hard-to-config').type, 'hardlink');
  assert.ok(isWhiteout(byPath.get('/etc/app/.wh.deleted.txt').path));
  assert.ok(isOpaqueMarker(byPath.get('/etc/app/.wh..wh..opq').path));
});

test('parses the same tar when delivered in tiny 63-byte chunks', async () => {
  const tar = buildLayerTar(MTIME_ENTRIES());
  const entries = await parseAll(tar, 63);
  const paths = entries.map((e) => e.path);
  assert.deepEqual(paths, (await parseAll(tar, 1024 * 1024)).map((e) => e.path));
  assert.equal(entries.find((e) => e.path === '/aligned.bin').size, 1024);
});

test('handles long (>100 char) paths via PAX extended headers', async () => {
  const longName = 'deep/' + 'nested/'.repeat(20) + 'file.txt';
  const tar = buildLayerTar([{ name: longName, content: Buffer.from('x') }]);
  const entries = await parseAll(tar, 1024 * 1024);
  const found = entries.find((e) => e.path === '/' + longName);
  assert.ok(found, 'long path entry parsed');
  assert.equal(found.size, 1);
});

test('gzip-compressed layer roundtrips through DecompressionStream', async () => {
  const tar = buildLayerTar(MTIME_ENTRIES());
  const gz = gzipSync(tar);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(gz);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream('gzip'));
  const entries = [];
  for await (const item of iterTarEntries(stream)) entries.push(item.header);
  assert.equal(entries.length, MTIME_ENTRIES().length);
});

test('cleanPath normalizes tar names', () => {
  assert.equal(cleanPath('./bin/sh'), '/bin/sh');
  assert.equal(cleanPath('bin/sh'), '/bin/sh');
  assert.equal(cleanPath('bin//sh'), '/bin/sh');
  assert.equal(cleanPath('a/./b/../c'), '/a/c');
  assert.equal(cleanPath('/usr/lib/'), '/usr/lib');
  assert.equal(cleanPath('../../etc/passwd'), '/etc/passwd');
});

test('whiteout path helpers', () => {
  assert.equal(isWhiteout('/data/.wh.remove.txt'), true);
  assert.equal(isWhiteout('/.wh.root'), true);
  assert.equal(isWhiteout('/data/.wh..wh..opq'), false); // opaque marker is not a whiteout
  assert.equal(isOpaqueMarker('/data/.wh..wh..opq'), true);
  assert.equal(isWhiteout('/.wh.'), false); // the prefix itself is not a whiteout
  assert.equal(unWhiteoutPath('/data/.wh.remove.txt'), '/data/remove.txt');
  assert.equal(unWhiteoutPath('/.wh.root'), '/root');
  assert.equal(parentPath('/a/b/c'), '/a/b');
  assert.equal(parentPath('/a'), '/');
  assert.equal(parentPath('/'), '/');
  assert.equal(baseName('/a/b/c'), 'c');
});
