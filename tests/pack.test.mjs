// The npm package must contain exactly the files the CLI needs — no more,
// no less. Runs `npm pack --dry-run --json` (fully offline; create mode
// writes the tarball only with --json absent... dry-run writes nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const EXPECTED = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'assets/vendor/fzstd/LICENSE.txt',
  'assets/vendor/fzstd/index.mjs',
  'bin/layerscope.mjs',
  'package.json',
  'src/cli/args.mjs',
  'src/cli/file-blob.mjs',
  'src/cli/github-action.mjs',
  'src/cli/main.mjs',
  'src/cli/report.mjs',
  'src/core/analyze.js',
  'src/core/format.js',
  'src/core/model.js',
  'src/core/tar.js',
  'src/core/zstd-decode.js',
  'src/core/zstd.js',
  'src/core/zstd.worker.js',
].sort();

test('npm pack --dry-run contains exactly the intended files', { timeout: 60000 }, () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  const files = (Array.isArray(parsed) ? parsed[0].files : parsed.files).map((f) => f.path).sort();
  assert.deepEqual(files, EXPECTED);
});
