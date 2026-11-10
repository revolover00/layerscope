// Streaming tar reader. Works on any web-style ReadableStream<Uint8Array>,
// so it runs identically in the browser and in Node (>= 18).
//
// The parser never holds more than one buffered chunk in memory. File data
// is skipped in-place unless the caller opts in to collecting it.

const BLOCK = 512;
const DEFAULT_CHUNK = 4 * 1024 * 1024;

const decoder = new TextDecoder('utf-8');

function str(header, start, length) {
  let end = start;
  const max = start + length;
  while (end < max && header[end] !== 0) end++;
  return decoder.decode(header.subarray(start, end));
}

function octal(header, start, length) {
  const raw = header.subarray(start, start + length);
  // base-256 encoded big integer (GNU tar uses this for sizes >= 2**33)
  if (length >= 12 && (raw[0] & 0x80)) {
    let value = raw[0] & 0x7f;
    for (let i = 1; i < length; i++) {
      value = value * 256 + raw[i];
      if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    }
    return value;
  }
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = raw[i];
    if (c === 0 || c === 0x20) continue;
    if (c >= 0x30 && c <= 0x37) s += String.fromCharCode(c);
  }
  return s.length ? parseInt(s, 8) : 0;
}

function isZeroBlock(buf) {
  for (let i = 0; i < BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

function checkSum(header) {
  // header checksum: 148..155 are treated as spaces
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    unsigned += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return unsigned === octal(header, 148, 8);
}

// Normalize an archive member name to a canonical absolute posix path
// (the same semantics as path.Clean('/' + name) in Go).
export function cleanPath(name) {
  const segs = String(name).split('/');
  const out = [];
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return '/' + out.join('/');
}

// A buffered byte source over a ReadableStream with constant-ish memory use.
class ByteStream {
  constructor(readable) {
    this.reader = readable.getReader();
    this.chunks = [];
    this.head = 0;       // offset into chunks[0]
    this.buffered = 0;   // total bytes available
    this.abs = 0;        // absolute offset of the next byte to be released
    this.eof = false;
  }

  async ensure(n) {
    while (this.buffered < n && !this.eof) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.eof = true;
        break;
      }
      if (value && value.byteLength) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    return this.buffered >= n;
  }

  // Release n bytes as a fresh Uint8Array (assumes ensure(n) already ran).
  take(n) {
    if (n === 0) return new Uint8Array(0);
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const headChunk = this.chunks[0];
      const avail = headChunk.byteLength - this.head;
      const grab = Math.min(avail, n - written);
      out.set(headChunk.subarray(this.head, this.head + grab), written);
      this.head += grab;
      written += grab;
      this.buffered -= grab;
      this.abs += grab;
      if (this.head === headChunk.byteLength) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    return out;
  }

  // Release n bytes without copying. Streams from the reader as needed —
  // does NOT require (or hold) the full n bytes up front.
  async skip(n) {
    let remaining = n;
    while (remaining > 0) {
      if (this.buffered === 0) {
        if (!(await this.ensure(1))) {
          throw new Error('tar: unexpected end of archive while skipping entry data');
        }
      }
      const headChunk = this.chunks[0];
      const avail = headChunk.byteLength - this.head;
      const grab = Math.min(avail, remaining);
      this.head += grab;
      remaining -= grab;
      this.buffered -= grab;
      this.abs += grab;
      if (this.head === headChunk.byteLength) {
        this.chunks.shift();
        this.head = 0;
      }
    }
  }

  // Next bytes WITHOUT consuming them (for magic sniffing on streamed data).
  async peek(n) {
    if (n <= 0) return new Uint8Array(0);
    await this.ensure(n);
    const want = Math.min(n, this.buffered);
    const out = new Uint8Array(want);
    let written = 0;
    let index = 0;
    while (written < want) {
      const chunk = this.chunks[index];
      const start = index === 0 ? this.head : 0;
      const grab = Math.min(chunk.byteLength - start, want - written);
      out.set(chunk.subarray(start, start + grab), written);
      written += grab;
      index += 1;
    }
    return out;
  }
}

const PAX_PATH = /^([0-9]+) ([^=]+)=(.*)\n$/s;

// Parse a PAX extended header payload ("<len> key=value\n" records).
function parsePax(buf) {
  const attrs = {};
  let offset = 0;
  const len = buf.byteLength;
  while (offset < len) {
    let space = offset;
    while (space < len && buf[space] !== 0x20) space++;
    if (space >= len) break;
    const recordLen = parseInt(decoder.decode(buf.subarray(offset, space)), 10);
    if (!Number.isFinite(recordLen) || recordLen <= 0 || offset + recordLen > len) break;
    const body = buf.subarray(space + 1, offset + recordLen - 1); // strip trailing \n
    const eq = body.indexOf(0x3d); // '='
    if (eq > 0) {
      attrs[decoder.decode(body.subarray(0, eq))] = decoder.decode(body.subarray(eq + 1));
    }
    offset += recordLen;
  }
  return attrs;
}

const TAR_TYPE = {
  '0': 'file',
  '\0': 'file',
  '7': 'file', // contiguous file
  '1': 'hardlink',
  '2': 'symlink',
  '3': 'char',
  '4': 'block',
  '5': 'directory',
  '6': 'fifo',
  'S': 'socket',
};

export function tarTypeName(typeflag) {
  return TAR_TYPE[typeflag] || 'unknown';
}

// Hard cap on the in-memory size of a tar control entry (PAX/GNU extended
// headers carry only metadata). Anything larger is treated as a corrupt or
// hostile archive rather than buffered.
const CONTROL_ENTRY_MAX = 4 * 1024 * 1024; // 4 MiB

// Low-level tar walk: yields one entry per non-control entry, positioned
// EXACTLY after the entry's header block (its data section is NOT consumed).
// Control entries (PAX/GNU extended headers) are consumed internally. The
// caller decides how to drain each entry's data section — skip it, collect
// it, or hand out a limited stream — and must do exactly one of those before
// the next iteration step.
async function* walkTar(stream) {
  let paxNext = null;   // attrs from a 'x' (per-file) extended header
  let paxGlobal = null; // attrs from a 'g' (global) extended header
  let gnuLongName = null;
  let gnuLongLink = null;

  for (;;) {
    // find the next non-zero header block
    if (!(await stream.ensure(BLOCK))) break; // clean EOF without terminator
    const probeOffset = stream.abs + 0;
    const block = stream.take(BLOCK);
    if (isZeroBlock(block)) break;

    if (!checkSum(block)) {
      // Some archives pad with garbage; if the block is not plausible, stop.
      throw new Error(`tar: bad header checksum at offset ${probeOffset}`);
    }

    let name = str(block, 0, 100);
    const prefix = str(block, 345, 155);
    if (prefix && str(block, 257, 6).startsWith('ustar')) name = prefix + '/' + name;

    let size = octal(block, 124, 12);
    const mode = octal(block, 100, 8);
    const uid = octal(block, 108, 8);
    const gid = octal(block, 116, 8);
    const mtime = octal(block, 136, 12);
    let typeflag = String.fromCharCode(block[156]);
    // Go's archive/tar normalizes a zero typeflag to '0' (regular file)
    if (typeflag === '\0') typeflag = '0';
    let linkname = str(block, 157, 100);

    const dataOffset = stream.abs;
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    // ---- control entries (no file data of their own) ------------------
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
      if (padded > CONTROL_ENTRY_MAX) {
        throw new Error(`tar: control entry (${typeflag}) at offset ${probeOffset} is ${padded} bytes, exceeding the ${CONTROL_ENTRY_MAX}-byte cap on extended headers`);
      }
      if (padded > 0 && !(await stream.ensure(padded))) {
        throw new Error(`tar: unexpected end of archive inside control entry at offset ${probeOffset} (${name}), wanted ${padded} bytes`);
      }
      const payload = stream.take(padded);
      if (typeflag === 'x') {
        const attrs = parsePax(payload.subarray(0, Math.min(size, payload.byteLength)));
        paxNext = { ...(paxGlobal || {}), ...attrs };
      } else if (typeflag === 'g') {
        const attrs = parsePax(payload.subarray(0, Math.min(size, payload.byteLength)));
        paxGlobal = { ...(paxGlobal || {}), ...attrs };
      } else if (typeflag === 'L') { // GNU long name
        gnuLongName = decoder.decode(payload.subarray(0, Math.min(size, payload.byteLength))).replace(/\0+$/, '');
      } else { // 'K' — GNU long linkname
        gnuLongLink = decoder.decode(payload.subarray(0, Math.min(size, payload.byteLength))).replace(/\0+$/, '');
      }
      continue;
    }

    // ---- regular entry -------------------------------------------------
    const eff = { ...(paxGlobal || {}), ...(paxNext || {}) };
    paxNext = null;
    if (eff.path) name = eff.path;
    else if (gnuLongName) name = gnuLongName;
    if (eff.linkpath) linkname = eff.linkpath;
    else if (gnuLongLink) linkname = gnuLongLink;
    if (eff.size !== undefined) {
      const s = Number(eff.size);
      if (Number.isFinite(s)) size = s;
    }
    gnuLongName = null;
    gnuLongLink = null;

    const header = {
      name,
      path: cleanPath(name),
      rawName: name,
      typeflag,
      type: tarTypeName(typeflag),
      size,
      mode,
      uid,
      gid,
      mtime,
      linkname,
    };

    yield { header, probeOffset, dataOffset, padded: Math.ceil(header.size / BLOCK) * BLOCK };
  }
}

/**
 * Iterate over the entries of a tar stream.
 *
 * @param {ReadableStream<Uint8Array>} readable
 * @param {object} [opts]
 * @param {(header: object) => boolean} [opts.collectData] return true to keep
 *   the entry's file data in memory on the yielded object (never use for layer blobs).
 * @returns {AsyncGenerator<{header: object, data: Uint8Array|null, offset: number}>}
 *   Each entry's absolute offset (start of its header) is reported for slicing.
 */
export async function* iterTarEntries(readable, opts = {}) {
  const collectData = opts.collectData || (() => false);
  const stream = new ByteStream(readable);

  for await (const { header, probeOffset, dataOffset, padded } of walkTar(stream)) {
    let data = null;
    if (collectData(header)) {
      if (padded > 0 && !(await stream.ensure(padded))) {
        throw new Error(`tar: unexpected end of archive inside entry ${probeOffset} (${header.name}), wanted ${padded} bytes`);
      }
      data = stream.take(padded).subarray(0, header.size);
      data = data.slice(); // copy out of the padded buffer
    } else {
      // streaming skip: pulls from the reader as needed, never buffers the entry
      await stream.skip(padded);
    }

    yield { header, data, offset: probeOffset, dataOffset };
  }
}

/**
 * Open a tar stream positioned at (targetOffset) and return a LIMITED
 * ReadableStream yielding exactly (targetSize) bytes — the data section of
 * the archive member whose header ends at targetOffset. Nothing past the
 * target's data is read, and the target's bytes are never buffered as a
 * whole: the stream pulls on demand from the underlying reader.
 *
 * Used for compressed (.tar.gz / .tar.zst) OUTER archives, where random
 * access is impossible: the caller decompresses the wrapper once per layer
 * and drains only up to that layer's blob.
 *
 * @returns {Promise<{stream: ReadableStream<Uint8Array>, head: Uint8Array}>}
 *   head: up to 32 bytes of the entry's data (for magic sniffing), consumed
 *   from the SAME position the limited stream starts at.
 */
export async function openTarEntryDataStream(readable, targetOffset, targetSize, chunkSize = DEFAULT_CHUNK) {
  const stream = new ByteStream(readable);
  for await (const entry of walkTar(stream)) {
    if (entry.dataOffset === targetOffset && entry.header.size === targetSize) {
      const head = await stream.peek(Math.min(32, targetSize));
      let sent = 0;
      const limited = new ReadableStream({
        async pull(controller) {
          const remaining = targetSize - sent;
          if (remaining <= 0) { controller.close(); return; }
          // wait for at least one buffered byte (pulling from the reader)
          while (stream.buffered === 0) {
            const { done, value } = await stream.reader.read();
            if (done) {
              controller.error(new Error(`tar: unexpected end of archive inside entry at offset ${targetOffset}`));
              return;
            }
            if (value && value.byteLength) {
              stream.chunks.push(value);
              stream.buffered += value.byteLength;
            }
          }
          const take = Math.min(Math.min(stream.buffered, remaining), chunkSize);
          controller.enqueue(stream.take(take));
          sent += take;
        },
        cancel(reason) {
          stream.reader.cancel(reason).catch(() => {});
        },
      });
      return { stream: limited, head };
    }
    // not the target: drain and keep walking
    await stream.skip(Math.ceil(entry.header.size / BLOCK) * BLOCK);
  }
  throw new Error(`tar: no entry with data at offset ${targetOffset} (size ${targetSize}) found in archive`);
}

/** Read an entire blob out of a File/Blob-like object by slicing. */
export async function readBlobSlice(blob, start, end) {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build a ReadableStream that yields `blob` (or a byte range of it) in
 * fixed-size chunks. Works with both browser File and Node Blob.
 */
export function blobReadableStream(blob, start = 0, end = blob.size, chunkSize = DEFAULT_CHUNK) {
  let offset = start;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= end) {
        controller.close();
        return;
      }
      const next = Math.min(offset + chunkSize, end);
      const slice = await blob.slice(offset, next).arrayBuffer();
      controller.enqueue(new Uint8Array(slice));
      offset = next;
    },
  });
}
