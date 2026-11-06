# layerscope

**A browser-only Docker image inspector.** Drop a `.tar` produced by `docker save`
and layerscope unpacks it *in your browser* — nothing is uploaded, no server is
involved. It shows what each layer adds/modifies/deletes, which files are dead
weight in earlier layers, how "efficient" the image is, and the 20 largest
files inside it.

Live site: <https://revolover00.github.io/layerscope/>

No install, no account, no backend. The whole app is static files.

## Quick start

```bash
docker save -o my-image.tar my-image:latest
# then open the site and drop my-image.tar onto the page
```

Or try the built-in demo (a synthetic image is generated in your browser).

To run locally instead of the hosted site:

```bash
python3 -m http.server 8080        # or: npx serve .
# open http://localhost:8080/
```

## What works

- **Both archive layouts**
  - legacy `docker save` format (`manifest.json` + `<id>/layer.tar`)
  - OCI layout (`index.json` + `blobs/sha256/...`), including dual-format archives
    that carry both
- **gzip-compressed layers**, decompressed on the fly with `DecompressionStream`
- **Per layer:** uncompressed tar-header byte size, the creating command
  (from image config `history`, with dive's `/bin/sh -c ` prefix trimmed),
  entry count, and the diff vs. the squashed lower image —
  files **added / modified / deleted** (whiteouts `.wh.<name>`, opaque dirs
  `.wh..wh..opq`), with type-aware metadata (sizes, old→new size on modify,
  "hidden bytes" reported for whiteouts of known lower-layer files/dirs)
- **Image efficiency score and wasted bytes**, using the same definition as
  [dive](https://github.com/wagoodman/dive): per path, the minimum occurrence
  across layers is "useful", everything beyond the minimum is waste.
  Whiteouts sizing the squashed directory they remove count as occurrences.
  The first (base) layer is excluded from the user-waste percentage.
- **Top 20 largest files**, two scopes: largest single layer entries across the
  whole image, and largest files in the final squashed image
- **File contents are never read** — everything is computed from tar headers
- **Large files** are handled by streaming the archive in slices (`Blob.slice`)
  through `DecompressionStream`; the outer archive is never loaded whole into
  memory, and memory grows with the number of file entries, not with byte size
- **UI:** filterable layer diff lists, wasted-space table with per-path copy
  counts, efficiency gauge, copyable commands, keyboard-accessible dropzone

## What does not work (honestly)

- **zstd-compressed layers are not supported.** Node 22 (and several browsers)
  cannot `DecompressionStream('zstd')`. Re-save with gzip instead. The
  verification suite skips the single zstd fixture — it does not silently pass.
- **`.tar.gz` of a docker-archive is not supported.** `docker save` emits an
  uncompressed `.tar` already; layerscope expects exactly that.
- **OCI indexes with several manifests**: the first manifest is analyzed
  (the `io.containerd.image.name` annotation is used as a weak hint when it
  mentions amd64). A warning is shown; there is no platform picker.
- **Deletions are not "free".** A file deleted in a later layer still occupies
  space in the layer that added it — layerscope reports this as waste, which is
  the entire point. This intentionally makes deletion-heavy images look bad.
- **No rename detection, no reproducibility judgments** — this is an analyzer,
  not a linter or a builder.
- **Analyzes one archive at a time**; multi-image `manifest.json` arrays analyze
  only the first entry (with a warning).
- **Not a replacement for `docker diff` on a running container**, and it does not
  talk to a registry or the docker daemon.

## Verification — what was actually run

Numbers below are real output from this repository, not aspirations.

### Unit tests

```
$ npm test          # node --test
# tests 12   # pass 12   # fail 0
```

### layerscope vs. dive's own golden files

dive commits golden analysis exports for its fixture suite
(`internal/imagefixture/testdata/golden/*.export.json`). layerscope recreates
every synthesized fixture byte-for-byte (the fixture tar writer matches Go's
`archive/tar` GNU-format output) and diffs its analysis against those goldens —
no expected values are hardcoded, and no goldens are rewritten by tooling.

```
$ git clone --depth 1 https://github.com/wagoodman/dive /tmp/dive-src
$ DIVE_REPO=/tmp/dive-src node tools/verify-fixtures.mjs
...
16 passed, 0 failed, 1 skipped
```

The one skip is `oci-save-zstd` (zstd, see limits). Layer `digestId`s, file
lists, byte sizes, creating commands, image totals, efficiency scores
(relative tolerance 1e-9) and the ranked `fileReference` list all match dive's
goldens on the fixtures that ran — including dive's two real on-disk
docker-save images.

### Sample images vs. the real dive CLI

`samples/` contains four Dockerfiles used in CI:

| sample        | contents                                            |
|---------------|-----------------------------------------------------|
| `clean`       | scratch image, one tiny file — should pass `dive --ci` |
| `add-delete`  | ~2 MiB file added, then deleted in the next layer    |
| `overwrite`   | same ~1 MiB path written twice                       |
| `multi-waste` | added-then-deleted, overwritten config, removed dir  |

CI (`.github/workflows/ci.yml`) builds them with docker, saves them with
`docker save`, runs `dive --ci` and `dive --json` (v0.13.1, the current
release) on the archives via the `docker-archive:` source scheme, then compares
layerscope's output against dive's with `tools/compare.mjs`.

**Honest status:** this job runs on GitHub Actions. It was *not* executed
locally while developing this repository — there is no docker daemon or dive
binary in the development sandbox. Everything that *could* be run locally was
(unit tests, golden verification above). If the CI comparison finds a
difference, CI fails and prints the diff.

You can reproduce it where docker and dive are available:

```bash
DIVE=/path/to/dive tools/check-samples.sh
```

## How the efficiency score is computed

For every path, across layers in build order (leaf nodes only, whiteouts
resolved against the squashed lower tree):

- **occurrence** = 1 per layer that introduces the path (whiteout of a file
  counts as an occurrence of size 0; a whiteout of a directory occurrence sizes
  the directory's whole subtree in the squashed lower tree)
- **discovered** = Σ of occurrence sizes, **minimum** = Σ of per-path minima
- **efficiency** = minimum / discovered
- **wasted bytes** = Σ cumulative bytes of paths occurring more than once
- **user wasted %** = wasted / (total bytes − first layer bytes)

Scores below 1.0 mean some bytes are shipped and then shadowed or deleted by a
later layer. This is dive's algorithm; matching it is the point of
`tools/verify-fixtures.mjs`.

## Benchmarks (measured, with environment)

Measured on Linux 6.1.158+ x86_64, Intel Xeon @ 2.60GHz, Node v22.22.3,
analyzing with `node tools/analyze.mjs` / in-memory blob (blob already resident):

| archive                                        | size    | layers | result                              | time     |
|------------------------------------------------|---------|--------|-------------------------------------|----------|
| synthetic OCI-save, gzip, 6 layers (64 MiB)¹    | 64.0 MB | 6      | eff. 99.9999%, wasted 68 B          | 380–431 ms |
| add-delete.legacy.tar                          | 2.0 MB  | 3      | eff. 0.00%, wasted 2,097,152 B      | ~3 ms    |
| add-delete.oci-archive.gzip.tar                | 2.0 MB  | 3      | eff. 0.00%, wasted 2,097,152 B      | ~14 ms   |
| multi-waste.legacy.tar                         | 2.0 MB  | 3      | eff. 100.00%, wasted 0 B            | ~3 ms    |
| overwrite.legacy.tar                           | 1.0 MB  | 3      | eff. 50.00%, wasted 1,048,689 B     | ~1 ms    |

Heap growth during the 64 MB analysis: ~1.3 MB (streaming; file bytes are never
retained). Browser timings will differ; the demo image builds in under a second.
¹ Synthetic image generated with `tools/synth.mjs`; content is random, so gzip
achieves almost nothing.

## Repository layout

```
index.html              static app (landing + analysis views)
assets/style.css        design system (no frameworks, inline SVG icons)
src/app.js              UI orchestration (dropzone, tabs, rendering)
src/demo.js             in-browser synthetic demo image builder
src/core/tar.js         streaming tar parser (chunked, bounded memory)
src/core/model.js       FileTree, whiteouts, squash/merge
src/core/analyze.js     archive orchestration + dive-compatible analysis
src/core/format.js      byte/percent formatting
tools/                  fixture synth, golden verification, comparison, benchmark
tests/                  node --test unit tests
samples/                Dockerfiles used by CI (add-delete, overwrite, multi-waste, clean)
.github/workflows/ci.yml    unit tests + golden verification + samples vs dive
.github/workflows/pages.yml static deploy to GitHub Pages
```

## License

No license file is included yet; treat the code as all-rights-reserved until one
is added.
