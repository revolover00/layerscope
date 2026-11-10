// Incremental SHA-256 (FIPS 180-4) — pure JavaScript, dependency-free.
//
// Why this exists: the zstd fallback decoder streams layers chunk by chunk,
// and the WebCrypto API has no incremental digest, so every decoded chunk is
// hashed here instead. The old one-shot sha256 (WebCrypto over a fully
// materialized layer) is gone — layers are never held in memory to be hashed.
//
// Correctness: cross-checked against WebCrypto (`crypto.subtle.digest`) and
// the NIST FIPS 180-4 test vectors in tests/sha256.test.mjs, including
// chunk-boundary splits (1/3/7/64/65-byte feeds) and odd buffer alignments.
//
// Implementation notes:
//  - All arithmetic is on Uint32Array views; no bignumbers until the final
//    bit-length padding (BigInt, 8-byte big endian per the spec).
//  - `update()` copies at most 63 bytes into a staging buffer, so a
//    caller-supplied chunk is consumed synchronously and never retained.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Uint32Array(64);

function processBlock(H, block, offset) {
  for (let t = 0; t < 16; t++) {
    const j = offset + t * 4;
    W[t] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0;
  }
  for (let t = 16; t < 64; t++) {
    const w15 = W[t - 15];
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const w2 = W[t - 2];
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let t = 0; t < 64; t++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  H[0] = (H[0] + a) >>> 0;
  H[1] = (H[1] + b) >>> 0;
  H[2] = (H[2] + c) >>> 0;
  H[3] = (H[3] + d) >>> 0;
  H[4] = (H[4] + e) >>> 0;
  H[5] = (H[5] + f) >>> 0;
  H[6] = (H[6] + g) >>> 0;
  H[7] = (H[7] + h) >>> 0;
}

/**
 * Create an incremental SHA-256 hasher.
 *   const h = createSha256();
 *   h.update(chunk1); h.update(chunk2);
 *   const hex = h.digestHex();   // single-shot: further update() calls are an error
 */
export function createSha256() {
  const H = Uint32Array.from(INIT);
  const staging = new Uint8Array(128); // holds at most 63 bytes of carry + the 64-byte pad block
  let stagingLen = 0;
  let totalBytes = 0;
  let digested = false;

  return {
    update(bytes) {
      if (digested) throw new Error('sha256: update() after digestHex()');
      if (!bytes || bytes.length === 0) return this;
      totalBytes += bytes.length;
      let offset = 0;
      if (stagingLen > 0) {
        const take = Math.min(64 - stagingLen, bytes.length);
        staging.set(bytes.subarray(0, take), stagingLen);
        stagingLen += take;
        offset = take;
        if (stagingLen === 64) {
          processBlock(H, staging, 0);
          stagingLen = 0;
        }
      }
      while (offset + 64 <= bytes.length) {
        processBlock(H, bytes, offset);
        offset += 64;
      }
      if (offset < bytes.length) {
        staging.set(bytes.subarray(offset), stagingLen);
        stagingLen += bytes.length - offset;
      }
      return this;
    },
    /** Lowercase hex digest. Single-shot — calling update() afterwards throws. */
    digestHex() {
      if (digested) return this.__cachedHex ?? (this.__cachedHex = '');
      // append the 0x80 byte, then pad with zeros to 56 mod 64, then 8-byte big-endian bit length
      const H2 = Uint32Array.from(H);
      let len = stagingLen;
      staging[len++] = 0x80;
      if (len > 56) {
        staging.fill(0, len, 64);
        processBlock(H2, staging, 0);
        len = 0;
      }
      staging.fill(0, len, 56);
      stagingLen = 0; // staging reused purely as scratch here; totalBytes untouched
      // write the 8-byte big-endian bit length at offset 56
      const bitLen = BigInt(totalBytes) * 8n;
      staging[56] = Number((bitLen >> 56n) & 0xffn);
      staging[57] = Number((bitLen >> 48n) & 0xffn);
      staging[58] = Number((bitLen >> 40n) & 0xffn);
      staging[59] = Number((bitLen >> 32n) & 0xffn);
      staging[60] = Number((bitLen >> 24n) & 0xffn);
      staging[61] = Number((bitLen >> 16n) & 0xffn);
      staging[62] = Number((bitLen >> 8n) & 0xffn);
      staging[63] = Number(bitLen & 0xffn);
      processBlock(H2, staging, 0);
      digested = true;
      this.__cachedHex = [...H2].map((w) => w.toString(16).padStart(8, '0')).join('');
      return this.__cachedHex;
    },
    /** Bytes consumed so far (excludes padding). */
    bytesFed() {
      return totalBytes;
    },
  };
}
