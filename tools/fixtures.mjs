// Recreates dive's handwritten image fixtures (internal/imagefixture/fixtures.go)
// byte-for-byte in structure, so layerscope's analysis can be diffed against
// the goldens dive itself produced (internal/imagefixture/testdata/golden/).
// The specs below are a 1:1 port of the Go fixture definitions.

import { synthesizeRaw, synthesizeRawAsync } from './synth-lib.mjs';

const dir = (name) => ({ name, typeflag: '5' });
const file = (name, content, extra = {}) => ({ name, content: Buffer.from(content), ...extra });
const whiteout = (name) => ({ name, typeflag: '0', content: Buffer.alloc(0) });
const symlink = (name, linkname) => ({ name, typeflag: '2', linkname });
const hardlink = (name, linkname) => ({ name, typeflag: '1', linkname });
const run = (cmd) => ({ created_by: '/bin/sh -c ' + cmd });
const nop = (cmd) => ({ created_by: '/bin/sh -c #(nop) ' + cmd, empty_layer: true });

const rep = (ch, n) => ch.repeat(n);

const BASE_LAYERS = [
  [
    dir('bin/'),
    file('bin/sh', rep('sh', 1024)),
    dir('etc/'),
    file('etc/os-release', 'ID=fixture\n'),
    dir('usr/'),
    dir('usr/lib/'),
    file('usr/lib/libc.so', rep('c', 3000)),
  ],
  [
    dir('app/'),
    file('app/main.txt', 'hello\n'),
    file('app/config.yaml', 'key: value\n'),
  ],
  [
    dir('app/'),
    file('app/main.txt', 'hello, world\n'),
    dir('etc/'),
    whiteout('etc/.wh.os-release'),
  ],
];
const BASE_HISTORY = [
  { created_by: '/bin/sh -c #(nop) ADD file:0123456789abcdef in / ' },
  nop('CMD ["/bin/sh"]'),
  { created_by: 'COPY app /app # buildkit' },
  run("echo 'hello, world' > /app/main.txt && rm /etc/os-release"),
];

export const NAMED_FIXTURES = {
  'legacy-save': { format: 'legacy', compression: 'none', layers: BASE_LAYERS, history: BASE_HISTORY },
  'oci-save': { format: 'oci-save', compression: 'none', layers: BASE_LAYERS, history: BASE_HISTORY },
  'oci-save-gzip': { format: 'oci-save', compression: 'gzip', layers: BASE_LAYERS, history: BASE_HISTORY },
  'oci-save-zstd': { format: 'oci-save', compression: 'zstd', layers: BASE_LAYERS, history: BASE_HISTORY },
  'oci-archive-gzip': {
    format: 'oci-archive', compression: 'gzip',
    layers: [[dir('bin/'), file('bin/busybox', rep('b', 2048)), symlink('bin/ls', 'busybox')]],
    history: [{ created_by: '/bin/sh -c #(nop) ADD file:fedcba9876543210 in / ' }],
  },
  'opaque-whiteout-dir': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('etc/'), dir('etc/app/'), file('etc/app/a.conf', rep('a', 100)), file('etc/app/b.conf', rep('b', 200)), dir('etc/app/sub/'), file('etc/app/sub/c.conf', rep('c', 300)), file('etc/keep.conf', 'keep\n')],
      [dir('etc/'), dir('etc/app/'), whiteout('etc/app/.wh..wh..opq'), file('etc/app/new.conf', rep('n', 50))],
    ],
    history: [run('make etc'), run('rm -rf /etc/app && mkdir /etc/app && touch /etc/app/new.conf')],
  },
  'file-and-dir-whiteouts': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('data/'), file('data/keep.txt', 'keep\n'), file('data/remove.txt', rep('r', 400)), dir('data/olddir/'), file('data/olddir/x', rep('x', 500)), dir('data/olddir/nested/'), file('data/olddir/nested/y', rep('y', 600))],
      [dir('data/'), whiteout('data/.wh.remove.txt'), whiteout('data/.wh.olddir')],
      [dir('data/'), dir('data/olddir/'), file('data/olddir/z', rep('z', 70))],
    ],
    history: [run('make data'), run('rm -rf /data/remove.txt /data/olddir'), run('mkdir /data/olddir && touch /data/olddir/z')],
  },
  'whiteout-missing-target': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('opt/'), file('opt/a', rep('a', 100))],
      [dir('opt/'), whiteout('opt/.wh.never-existed'), file('opt/a', rep('A', 150)), file('opt/b', rep('b', 50))],
    ],
    history: [run('touch /opt/a'), run('rm -f /opt/never-existed && touch /opt/a /opt/b')],
  },
  'hardlink-and-symlink': {
    format: 'oci-save', compression: 'none',
    layers: [
      [
        dir('usr/'), dir('usr/bin/'), file('usr/bin/tool', rep('t', 1000)),
        hardlink('usr/bin/tool-hard', 'usr/bin/tool'),
        symlink('usr/bin/tool-rel', 'tool'),
        symlink('usr/bin/tool-abs', '/usr/bin/tool'),
        symlink('usr/bin/dangling', '/nowhere'),
        dir('usr/lib/'), file('usr/lib/libx.so', rep('l', 400)),
        symlink('lib', 'usr/lib'),
      ],
      [
        dir('usr/'), dir('usr/bin/'),
        file('usr/bin/tool-rel', 'now a file\n'),
        hardlink('usr/bin/libx-hard', 'usr/lib/libx.so'),
      ],
    ],
    history: [run('install tool'), run('relink tool')],
  },
  'empty-layer-history': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('a/'), file('a/one', '1\n')],
      [dir('a/'), file('a/two', '22\n')],
      [dir('a/'), file('a/three', '333\n')],
    ],
    history: [
      nop('ARG VERSION=1'),
      { created_by: '/bin/sh -c #(nop) ADD file:aaaa in / ' },
      nop('ENV A=1'), nop('LABEL x=y'),
      run('echo 22 > /a/two'),
      nop('WORKDIR /a'),
      { created_by: 'RUN |1 VERSION=1 /bin/sh -c echo 333 > /a/three # buildkit' },
      nop('ENTRYPOINT ["/bin/sh"]'),
    ],
  },
  'no-history': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('a/'), file('a/one', '1\n')],
      [dir('a/'), file('a/two', '22\n')],
    ],
    history: null, // config without a history key at all
  },
  'history-fewer-than-layers': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('a/'), file('a/one', '1\n')],
      [dir('a/'), file('a/two', '22\n')],
      [dir('a/'), file('a/three', '333\n')],
    ],
    history: [nop('ENV A=1'), run('touch /a/one')],
  },
  'mode-uid-only-change': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('app/'), file('app/run.sh', '#!/bin/sh\necho hi\n'), file('app/owned', 'owned\n'), file('app/same', 'same\n')],
      [
        dir('app/'),
        { name: 'app/run.sh', mode: 0o755, content: Buffer.from('#!/bin/sh\necho hi\n') },
        { name: 'app/owned', uid: 1000, gid: 1000, content: Buffer.from('owned\n') },
        file('app/same', 'same\n'),
      ],
    ],
    history: [run('make app'), run('chmod +x /app/run.sh && chown 1000:1000 /app/owned')],
  },
  'duplicate-files-across-layers': {
    format: 'oci-save', compression: 'none',
    layers: [
      [dir('var/'), dir('var/cache/'), file('var/cache/big.bin', rep('1', 10000)), file('var/cache/medium.bin', rep('m', 3000)), file('var/cache/tie-a', rep('a', 500)), file('var/cache/tie-b', rep('b', 500))],
      [dir('var/'), dir('var/cache/'), file('var/cache/big.bin', rep('2', 12000)), file('var/cache/medium.bin', rep('M', 3000)), file('var/cache/tie-a', rep('A', 500)), file('var/cache/tie-b', rep('B', 500))],
      [dir('var/'), dir('var/cache/'), file('var/cache/big.bin', rep('3', 8000))],
      [dir('var/'), dir('var/cache/'), whiteout('var/cache/.wh.big.bin')],
    ],
    history: [run('fill cache'), run('refill cache'), run('refill big'), run('rm /var/cache/big.bin')],
  },
  'implicit-parent-dirs': {
    format: 'oci-save', compression: 'none',
    layers: [
      [file('a/b/c/deep.txt', 'deep\n'), file('top.txt', 'top\n')],
      [file('a/b/other.txt', 'other\n')],
    ],
    history: [run('touch deep'), run('touch other')],
  },
};

export function buildFixture(name) {
  const spec = NAMED_FIXTURES[name];
  if (!spec) throw new Error(`unknown fixture: ${name}`);
  return synthesizeRaw({
    format: spec.format,
    compression: spec.compression,
    layers: spec.layers,
    history: spec.history,
    repoTag: 'fixture:latest',
  });
}

export async function buildFixtureAsync(name) {
  const spec = NAMED_FIXTURES[name];
  if (!spec) throw new Error(`unknown fixture: ${name}`);
  return synthesizeRawAsync({
    format: spec.format,
    compression: spec.compression,
    layers: spec.layers,
    history: spec.history,
    repoTag: 'fixture:latest',
  });
}
