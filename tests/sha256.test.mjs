// Incremental SHA-256 (src/core/sha256.js) against the NIST FIPS 180-4
// vectors and against WebCrypto, including chunk-boundary splits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { randomBytes } from 'node:crypto';

import { createSha256 } from '../src/core/sha256.js';

const NIST = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
];

test('NIST FIPS 180-4 vectors', () => {
  for (const [msg, want] of NIST) {
    const h = createSha256();
    h.update(new TextEncoder().encode(msg));
    assert.equal(h.digestHex(), want);
  }
  // 1,000,000 × 'a'
  const h = createSha256();
  const chunk = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i++) h.update(chunk);
  assert.equal(h.digestHex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('matches WebCrypto for every length 0..1100', async () => {
  for (let len = 0; len <= 1100; len++) {
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = (i * 2654435761) >>> 0 & 0xff;
    const h = createSha256();
    h.update(buf);
    const want = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', buf))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    assert.equal(h.digestHex(), want, `length ${len}`);
  }
});

test('chunk-boundary splits (1/2/3/7/63/64/65/4096) match a one-shot hash', () => {
  const buf = randomBytes(4096);
  const want = createHash('sha256').update(buf).digest('hex');
  for (const splitEvery of [1, 2, 3, 7, 63, 64, 65, 4096]) {
    const h = createSha256();
    for (let i = 0; i < buf.length; i += splitEvery) {
      h.update(buf.subarray(i, Math.min(i + splitEvery, buf.length)));
    }
    assert.equal(h.digestHex(), want, `split every ${splitEvery}`);
  }
});

test('update() is chainable, empty updates are ignored, update after digest throws', () => {
  const buf = randomBytes(300);
  const h = createSha256();
  h.update(buf.subarray(0, 100)).update(new Uint8Array(0)).update(buf.subarray(100));
  const hex = h.digestHex();
  assert.equal(hex, createHash('sha256').update(buf).digest('hex'));
  assert.throws(() => h.update(buf), /after digestHex/);
});

test('bytesFed tracks consumed bytes', () => {
  const h = createSha256();
  h.update(new Uint8Array(10));
  assert.equal(h.bytesFed(), 10);
  h.update(new Uint8Array(32));
  assert.equal(h.bytesFed(), 42);
});
