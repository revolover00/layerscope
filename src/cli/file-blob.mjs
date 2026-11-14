// Disk-backed Blob shim for the analysis engine.
//
// The engine (src/core/analyze.js) consumes web-style Blobs: a synchronous
// `.size` and `.slice(start, end)` returning something with an async
// `.arrayBuffer()`. It never reads the archive in one shot — layers are
// streamed in 4 MiB windows and only tar headers / small members are read as
// whole ranges. This adapter does the same against a file descriptor with
// positional reads, so memory stays bounded no matter how large the archive
// is (unlike readFileSync, which materializes the whole file).
//
// One file descriptor is shared by all reads; close() must be called when the
// analysis is done (the CLI does this in a finally block).

import { createWriteStream } from 'node:fs';
import { open, stat as statAsync, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';

export async function openDiskBlob(path) {
  let st;
  try {
    st = await statAsync(path);
  } catch (err) {
    throw new Error(`cannot stat '${path}': ${err.message}`);
  }
  if (st.isDirectory()) {
    throw new Error(`'${path}' is a directory — pass the image tar file, or - to read from stdin`);
  }
  if (!st.isFile()) {
    throw new Error(`'${path}' is not a regular file`);
  }
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    throw new Error(`cannot open '${path}': ${err.message}`);
  }
  return new DiskBlob(handle, st.size);
}

class DiskBlob {
  constructor(handle, size) {
    this._handle = handle;
    this.size = size;
  }

  slice(start, end) {
    const lo = Math.max(0, start);
    const hi = Math.min(end, this.size);
    const size = Math.max(0, hi - lo);
    const position = lo;
    const handle = this._handle;
    return {
      size,
      arrayBuffer: async () => {
        if (size === 0) return new ArrayBuffer(0);
        const buffer = Buffer.allocUnsafe(size);
        let read = 0;
        while (read < size) {
          const { bytesRead } = await handle.read(buffer, read, size - read, position + read);
          if (bytesRead === 0) break; // short read: file truncated mid-analysis
          read += bytesRead;
        }
        if (read !== size) {
          throw new Error(`short read on archive (expected ${size} bytes at offset ${position}, got ${read}) — the file changed or disappeared during analysis`);
        }
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + size);
      },
    };
  }

  async close() {
    try { await this._handle.close(); } catch { /* best effort */ }
  }
}

/**
 * Spool stdin to a temporary file and return its path. The caller must call
 * cleanup() (deletes the file and its parent directory) when done — including
 * on failure. Memory stays O(chunk); disk usage equals the archive size.
 */
export async function spoolStdinToTemp(stream) {
  if (stream.isTTY) {
    throw new Error('reading the archive from stdin requires piped input — e.g. `docker save <image> | layerscope analyze -`');
  }
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'layerscope-stdin-'));
  } catch (err) {
    throw new Error(`cannot create a temporary directory in ${tmpdir()}: ${err.message}`);
  }
  const path = join(dir, 'image.tar');
  try {
    await pipeline(stream, createWriteStream(path));
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`failed to read the archive from stdin: ${err.message}`);
  }
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}
