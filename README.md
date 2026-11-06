# layerscope

[![CI](https://github.com/revolover00/layerscope/actions/workflows/ci.yml/badge.svg)](https://github.com/revolover00/layerscope/actions/workflows/ci.yml)
[![Deploy to GitHub Pages](https://github.com/revolover00/layerscope/actions/workflows/pages.yml/badge.svg)](https://github.com/revolover00/layerscope/actions/workflows/pages.yml)

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

Or hit **Try a sample image** — it loads `layerscope/sample:latest`, a bundled 92 KiB docker-save archive (`assets/samples/layerscope-demo.tar`) with an `add → modify → delete` story so the wasted-bytes view has something to show.

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
- **Multi-manifest OCI indexes** — the manifest list in `index.json` (e.g. `docker buildx build --platform linux/amd64,linux/arm64` output) is turned into a platform picker; `linux/amd64` is analyzed by default, a warning names the selected manifest, an absent requested platform falls back with a warning, and re-selecting re-analyzes in place
- **gzip-compressed layers**, decompressed on the fly with `DecompressionStream`
- **zstd-compressed layers** — natively where the browser provides
  `DecompressionStream('zstd')`, otherwise through a vendored WebAssembly decoder
  (`assets/vendor/zstd`, `@bokuweb/zstd-wasm`, MIT). The WASM fallback decodes one
  layer in memory; gzip layers stream end-to-end. Verified against dive's
  `oci-save-zstd` golden — it passes.
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
- **UI:** filterable layer diff lists, wasted-space table with per-path copy counts, efficiency gauge, one-click copy of the creating command, keyboard-accessible dropzone, self-hosted Geist fonts (no CDN)

## What does not work (honestly)

- **zstd relies on the decoder path.** Where neither native `DecompressionStream('zstd')`
  nor a successful WASM load is available, the layer cannot be read and the error
  message says exactly that. The WASM fallback holds one layer in memory — gzip
  layers remain fully streaming. Legacy `docker save` archives do not carry zstd
  layers; `oci-save` zstd is the supported layout.
- **`.tar.gz` / `.tar.zst` of a docker-archive is not supported.** `docker save`
  emits an uncompressed `.tar` already; layerscope expects exactly that and
  detects the outer gzip/zstd magic bytes to say so instead of failing with the
  generic "no manifest" error.
- **OCI indexes are platform-picked, not registry-resolved.** The picker
  lists exactly the manifests present inside the archive's `index.json` —
  layerscope never talks to a registry. Default selection is `linux/amd64`
  (falling back to the first listed manifest if amd64 is absent), the analyzed
  platform is always named in a warning, and falling back to the default for an
  absent requested platform happens with a warning.
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
# tests 18   # pass 18   # fail 0
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
17 passed, 0 failed, 0 skipped
```

All 17 fixtures run, including `oci-save-zstd` (decoded with the vendored WASM
decoder — layerscope synthesizes the fixture with the same decoder). Layer `digestId`s, file
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
`docker save`, `docker load`s the archives into the daemon, and analyzes them
with `dive --ci` and `dive --json` (v0.13.1, the current release) — dive's
canonical docker-daemon source — then compares layerscope's output against
dive's with `tools/compare.mjs`.

**Latest CI result (2026-11-06, [run #42176215174](https://github.com/revolover00/layerscope/actions/runs/42176215174)):
both jobs green.** The comparison step passed on all four samples — layerscope's
numbers match the real dive CLI exactly on images built by docker. dive --ci
passes on `clean` and rejects the three wasteful samples as designed. (An
earlier revision of the job fed dive the archives via the `docker-archive:`
source scheme; dive exited non-zero with it, so the job now uses the daemon.)

You can reproduce it where docker and dive are available:

```bash
DIVE=/path/to/dive tools/check-samples.sh
```

### UI smoke test

`tools/smoke-ui.mjs` (jsdom, no browser needed) loads `index.html`, serves the
bundled sample archive from disk in place of the HTTP fetch, clicks
**Try a sample image** and walks the whole analysis view — layers, tabs,
filters, gauge, platform-picker visibility — asserting the DOM updates.
`npm install && npm run smoke` → `SMOKE TEST PASSED`.

### Design

The interface is a Vercel-style dark system: pure black canvas, hairline borders,
the Geist Sans/Mono pair (self-hosted woff2, `font-display: swap`), white-on-black
primary action, monochrome panels with a single semantic signal color per state.
Every view above was re-shot and checked after the re-skin — no horizontal
overflow at 1440 px or 390 px, and the sample flow is unchanged.

### Browser check (headless Chromium)

Verified by driving a real Chromium (via playwright-core and
`@sparticuz/chromium`, desktop 1440×900 and mobile 390×844, against the staged
site that `pages.yml` deploys): landing page, invalid-file error path, sample
(then demo) analysis, file-path and kind filters, wasted-space filter, top-files scope
toggle, back-to-landing navigation, and console/page errors — no horizontal
overflow and no JS errors in any of those views. It found critical bugs jsdom
could not see:

- **The progress overlay intercepted every pointer event** — the `.overlay`
  rule's `display: flex` overrode the `[hidden]` UA rule, so the "Analyzing…"
  card covered the page even when hidden, making the live site unusable.
  Fixed globally with `[hidden] { display: none !important; }`.
- **On mobile, the layer table's size-bar column squeezed the command column**
  — the redundant bar is hidden on ≤640px (the size text is kept) and dense
  tables now scroll horizontally in a touch-scroll wrapper instead of crushing
  the path column.
- **The analysis error was appended at the bottom of the hero, below the
  fold** — the dropzone and the error sat in different scroll positions, so a
  failed upload appeared to do nothing. The error box now renders directly
  below the dropzone.
- **Creating commands are copyable in the browser** — a Copy button in the
  layer detail panel writes the exact command to the clipboard (with a
  non-`navigator.clipboard` fallback for older WebViews).
- **A gzip- or zstd-wrapped outer archive is rejected with a targeted
  message** (`docker save … | gzip` produces one) instead of the generic
  "no manifest.json" error, which reads like the archive is corrupt.

Other fixes from the same passes: deleted-file rows now show the actual
lower-layer size ("file · 1.50 MB hidden below"), modified directories render
as "directory" instead of "0 B → 0 B", whiteout/opaque markers are excluded
from top-largest-file lists, and extreme user-wasted ratios render grouped
("2,042,740%"). Zero console/page errors were observed across the landing,
layers, wasted-space and top-files views after the fixes.

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
| synthetic OCI-save, gzip, 6 layers (62 MiB)¹    | 62.0 MB | 6      | eff. 99.9999%, wasted 136 B         | 434–471 ms |
| synthetic OCI-save, zstd, 6 layers (62 MiB)¹    | 62.0 MB | 6      | eff. 99.9999%, wasted 136 B         | 167–216 ms cold (module init included); 115–148 ms warm |
| add-delete.legacy.tar                          | 2.0 MB  | 3      | eff. 0.00%, wasted 2,097,152 B      | ~8 ms    |
| add-delete.oci-archive.gzip.tar                | 2.0 MB  | 3      | eff. 0.00%, wasted 2,097,152 B      | ~21 ms   |
| multi-waste.legacy.tar                         | 2.0 MB  | 3      | eff. 100.00%, wasted 0 B            | ~9 ms    |
| overwrite.legacy.tar                           | 1.0 MB  | 3      | eff. 50.00%, wasted 1,048,689 B     | ~6 ms    |

No speed advantage for zstd over gzip is claimed on real compressible data: the
62 MiB fixture above is random (incompressible), so both decoders do about as
much work. Decode-rate comparisons on realistic compressible content are only
meaningful per-payload; the browser benchmark in `browser-bench.yml` measures
cold/warm zstd analysis of a recompressed alpine rootfs for exactly this reason.

Memory on the zstd fallback path: `heapUsed` alone is misleading because the
vendored WASM decoder lives in linear (ArrayBuffer/external) memory. Measured
with `tools/bench-memory.mjs` (`node --expose-gc`, the same 62 MiB zstd fixture,
fresh process, WASM module cold, peak sampled inside `onProgress`):

- `arrayBuffers` 0.01 → 62.0 MB (file Buffer + copies) → 124.1 MB during analysis → 82.7 MB after GC (+20.7 MB retained: grown WASM linear memory + module; warm-module runs return to +0.2 MB after GC)
- `rss` 45.7 → 107.9 MB after file load → 219–226 MB during analysis → 181–220 MB after GC (+73 to +112 MB over before analysis)
- `heapUsed` delta ≤ +0.8 MB — reporting heapUsed alone would miss ~120 MB of RSS growth
- the outer archive Buffer accounts for the rest; file bytes are never retained after analysis

Browser timings will differ; the bundled sample is 92 KiB and analyzes in milliseconds.
¹ Synthetic 6-layer OCI-save archive (gzip: `tools/synth-lib.mjs`; zstd:
`tools/ci/build-incompressible-zstd.mjs`), ~10.3 MiB of incompressible random
data per layer plus a 68-byte file duplicated across two layers. Content is
random, so compression achieves almost nothing — these rows describe decode+parse
cost on incompressible bytes, not on typical images.

## Repository layout

```
index.html              static app (landing + analysis views)
assets/style.css        Vercel-inspired design system (self-hosted Geist, no frameworks, inline SVG icons)
assets/fonts/           Geist Sans/Mono woff2, subset latin, OFL (GEIST-LICENSE.txt)
assets/vendor/zstd/     vendored @bokuweb/zstd-wasm 0.0.27 (MIT) — see assets/vendor/zstd/LICENSE.txt
src/app.js              UI orchestration (dropzone, tabs, rendering)
assets/samples/layerscope-demo.tar  bundled sample for "Try a sample image" (regenerate: node tools/make-sample.mjs)
tools/make-sample.mjs   deterministic sample generator (seeded PRNG)
src/core/tar.js         streaming tar parser (chunked, bounded memory)
src/core/zstd.js        lazy zstd loader (native DecompressionStream, else vendored WASM)
src/core/model.js       FileTree, whiteouts, squash/merge
src/core/analyze.js     archive orchestration + dive-compatible analysis
src/core/format.js      byte/percent formatting
tools/                  fixture synth, golden verification, comparison, smoke test, benchmarks
tools/ci/               CI-only helpers (build zstd OCI fixtures)
tools/browser-bench.mjs real-browser cold/warm analysis times (Chromium, used by browser-bench.yml)
tools/bench-memory.mjs  rss + arrayBuffers memory bench for the zstd fallback path
tools/check-real-images.sh  pull public images, compare vs dive CLI (used by ci.yml real-images job)
tests/                  node --test unit tests
LICENSE                 MIT
samples/                Dockerfiles used by CI (add-delete, overwrite, multi-waste, clean)
.github/workflows/ci.yml    unit tests + golden verification + samples vs dive
.github/workflows/pages.yml static deploy to GitHub Pages
```

## Credits

- **[dive](https://github.com/wagoodman/dive)** (wagoodman, MIT) — layerscope's
  per-layer file-diff model, whiteout/opaque-directory semantics, the efficiency
  score and wasted-bytes definition, the "leaf nodes only" scoring rule, and the
  `trimCommand` history handling are a direct port of dive's analysis logic.
  dive's handwritten fixture suite and its golden analysis exports
  (`internal/imagefixture/testdata/golden/`) are what `tools/verify-fixtures.mjs`
  diffs against — see the verification section above for the comparison
  methodology and tolerances. The CI sample comparison runs against the real
  `dive` v0.13.1 CLI. layerscope does not vendor dive's Go code; it
  re-implements the algorithm in JavaScript and validates equivalence against
  the goldens.
- **[@bokuweb/zstd-wasm](https://github.com/bokuweb/zstd-wasm)** (bokuweb, MIT) —
  vendored in `assets/vendor/zstd/` as the WebAssembly fallback decoder for
  zstd layers on browsers without native `DecompressionStream('zstd')`. Wraps
  Meta's [Zstandard](https://github.com/facebook/zstd) (BSD-3-Clause).
- **[Geist](https://github.com/vercel/geist-font)** (Vercel, OFL) — the
  self-hosted Sans/Mono pair in `assets/fonts/`.

## License

[MIT](LICENSE). Swappable — if a different license is needed for this codebase,
the MIT text can be replaced wholesale.
