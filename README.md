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
  `DecompressionStream('zstd')`, otherwise through the bundled pure-JavaScript
  streaming decoder (`assets/vendor/fzstd`, MIT). The fallback decodes one layer
  in memory; gzip layers stream end-to-end; and the fallback path **always
  enforces the byte cap mid-decode** (see "Decoder integrity"). Verified
  against dive's `oci-save-zstd` golden — it passes. Frames **without** a
  content size (streamed compression, e.g. containerd/buildx) are supported and
  bounded the same way. Every decompressed fallback layer is
  **sha256-verified against the image config's `rootfs.diff_ids`** (mismatch
  fails the analysis with a clear error), and the browser decodes in a
  per-analysis Web Worker that is terminated afterwards.
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
  memory. Memory scales with the **largest single layer**, not with the archive's
  total size or file count: gzip layers and native-zstd layers stream end-to-end,
  while the fallback decoder holds one layer in memory at a time — released
  after each analysis (worker termination in the browser; GC-able in node) —
  see the memory bench section below
- **UI:** filterable layer diff lists, wasted-space table with per-path copy counts, efficiency gauge, one-click copy of the creating command, keyboard-accessible dropzone, self-hosted Geist fonts (no CDN)

## What does not work (honestly)

- **zstd relies on the decoder path.** Where neither native `DecompressionStream('zstd')`
  nor a successful fallback decode is available, the layer cannot be read and the error
  message says exactly that. The bundled pure-JS fallback holds one layer in memory — gzip
  layers remain fully streaming. Legacy `docker save` archives do not carry zstd
  layers; `oci-save` zstd is the supported layout.
- **The fallback decoder refuses single layers larger than 160 MiB (167,772,160 bytes).**
  The fallback must hold one decompressed layer in memory; a layer above the
  limit is refused **before allocating** — the check reads the zstd frame content
  size from the header, so even a 27 KB archive claiming an 600 MiB layer is
  refused without decoding (verified). Frames **without** a content size
  (streamed compression, e.g. containerd/buildx) are allowed through and the
  decode itself is cut off the moment it crosses the cap (zstd blocks are
  ≤ 128 KiB, so overshoot is at most one block). The error names the layer, the raw byte
  counts and the remedy (gzip layers stream end-to-end and are unaffected).
  Callers of `analyzeImage()` can raise or lower the limit with the `maxLayerBytes`
  option. **Tested up to the limit:** a 159 MiB-content layer passes on node
  (rss 853.4 MB peak, 1081 ms) and a 160 MiB-content layer whose tar lands 2 KB
  over the limit is refused pre-allocation; in real Chromium a 150 MiB
  incompressible single layer passes end-to-end with zero console errors —
  see the browser benchmark table. The python:3.12-slim single zstd layer
  (114.4 MiB) also passes.
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
# tests 44   # pass 44   # fail 0
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

All 17 fixtures run, including `oci-save-zstd` (decoded with the fallback
decoder). Layer `digestId`s, file
lists, byte sizes, creating commands, image totals, efficiency scores
(relative tolerance 1e-9) and the ranked `fileReference` list all match dive's
goldens on the fixtures that ran — including dive's two real on-disk
docker-save images.

`fileReference` is compared as a multiset of exact (file, count, sizeBytes)
triples, not positionally: dive v0.13.1 orders that list by cumulative size
only via the unstable `sort.Sort` and exports it in reverse
(`dive/filetree/efficiency.go`, `runtime/export/export.go` in the v0.13.1 tag) —
there is no path tiebreaker, so the order of equal-size entries is undefined
there. layerscope emits size-descending, path-ascending (dive `main`
behavior). Tolerances are not relaxed: every triple must still match exactly;
counts, sizes and list contents are checked one-to-one, only dive v0.13.1's
undefined intra-tie order is normalized away.

### Real public images vs. the real dive CLI

CI (`.github/workflows/ci.yml`, `real-images` job, `tools/check-real-images.sh`)
pulls six public images — `alpine`, `busybox`, `nginx:alpine`, `python:3.12-slim`,
`node:20-alpine`, `ubuntu:24.04` — `docker save`s them, analyzes with dive
v0.13.1 via the daemon (`dive --json`) and with layerscope on the same tar, and
compares with the same `tools/lib-compare.mjs` and tolerances as the golden
verification (efficiencyScore rel tol 1e-9; everything else exact;
fileReference as described above). Every difference is printed — nothing is
suppressed. Current status on the default branch: **all six images match**
(pulls via `mirror.gcr.io` with docker.io fallback; the job is re-run on every
push). The one real discrepancy found during bring-up was python:3.12-slim's
three zero-byte dpkg lock entries — the dive v0.13.1 intra-tie order artifact
described above, not a layerscope bug; after the multiset comparison landed,
python:3.12-slim matches exactly (image sizeBytes 119,470,750; inefficientBytes
5,690,470; efficiencyScore 0.9671877593469531 identical to dive).

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

Verified by driving a real Chromium (via playwright-core, desktop 1440×900 and
mobile 390×844, against the staged site that `pages.yml` deploys — see
`.github/workflows/browser-bench.yml` and `tools/browser-bench.mjs`): landing page, invalid-file error path, sample
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

### Real-browser timings (Playwright Chromium in GitHub Actions)

Measured by `browser-bench.yml` (headless Chromium, ubuntu-latest, site served
locally, archive uploaded through the real file input; time from upload until
the analysis view is fully rendered). "warm" is the second analysis in the same
page; since the fix for the decoder degradation (see "Decoder integrity"),
**every analysis decodes through the fallback path independently** — a
per-analysis Web Worker running the pure-JS decoder (~spawn + decode cost
included in warm):

| image                                                     | archive | uncompressed | layers | cold (worker spawn + decode)    | warm  | JS heap after cold/warm |
|-----------------------------------------------------------|---------|--------------|--------|---------------------------------|-------|--------------------------|
| alpine:3.20 rootfs exported and recompressed with zstd (level 3, REAL compressible layer) | 3.4 MB  | ~3.5 MB | 1      | 298 ms                         | 235 ms | 19.6 / 19.6 MB |
| synthetic incompressible 62 MiB zstd (the fixture above)  | 62.0 MB | 62 MiB       | 6      | 470 ms                         | 438 ms | 33.5 / 33.5 MB |
| **python:3.12-slim rootfs exported and recompressed with zstd (level 3, REAL large image)** | **36.2 MB (ratio 0.32)** | **114.4 MiB (119,942,656 B)** | **1** | **1397 ms** | **1315 ms** | **124.9 / 124.9 MB** |
| **synthetic incompressible 150 MiB zstd (single layer)** | **150.0 MB** | **150 MiB (157,286,400 B)** | **1** | **873 ms** | **882 ms** | **307.1 / 307.1 MB** |

Measured on the current decode path (two-tier `decodeZstdCapped` + the
byteOffset/byteLength worker protocol fix), GitHub Actions run 42225036157
(commit `8813024`): browser soak 2000/2000 same-frame decodes with matching
sha256, 50/50 repeated analyses with a single unique fingerprint, both
huge-claims limit refusals fired with `pageErrors=0`, and the 12-layer × 20
analyses run produced one fingerprint — zero console/page errors throughout.
Timings vary run-to-run by ~10%; treat them as order-of-magnitude, not
regression thresholds.

All runs: zero console/page errors; `performance.memory` reports the JS heap
only — the decoder state lives inside the per-analysis worker, not in the page
JS heap, and is destroyed with the worker when the analysis ends. An earlier
development build showed a
~75 s end-to-end analysis on a zstd image in headless Chromium; that figure is
not reproducible with the current code on any image above (including the
114.4 MiB and 150 MiB single-layer cases), and the fixture it was measured on
no longer exists — it is not attributable precisely. What is verified now:
current main analyzes a 150 MiB single-layer image end-to-end in a real browser
in under a second, with zero console errors.

Memory on the fallback decode path: `heapUsed` alone is misleading because the
decoded layer lives in external (ArrayBuffer) memory, not on the JS heap. Measured
with `tools/bench-memory.mjs` (`node --expose-gc`, fresh process, peak RSS
sampled inside `onProgress`):

| archive                               | layers | rss peak (max sampled) | rss Δ during analysis | arrayBuffers after GC¹ | elapsed |
|---------------------------------------|--------|------------------------|-----------------------|-----------------------|---------|
| 1 layer × 120 MiB (120.0 MB)         | 1      | **661.5 MB**           | +496.3 MB             | 240.0 MB (+120.0 MB)¹   | 852 ms |
| 12 layers × 10 MiB (120.0 MB)        | 12     | **315.9 MB**           | +130.9 MB             | 120.1 MB (**+0.01 MB**)  | 616 ms |
| 1 layer × 150 MiB (157.3 MB)         | 1      | **795.4 MB**           | +600.0 MB             | 300.0 MB (+150.0 MB)¹   | 891 ms |
| 6 layers × 10 MiB bench64             | 6      | **225.9 MB**           | +120.5 MB             | 60.0 MB (**+0.01 MB**)   | 330 ms |
| 1 layer × 159 MiB (166.7 MB, tar just under the 160 MiB limit) | 1 | **683.3 MB** | n/r (see note) | 318.0 MB (+159.0 MB)¹   | 801 ms |

(The 159 MiB row was re-measured with the two-tier decode, which keeps
single-segment FCS frames on a single allocation: peak 853.4 → 683.3 MB,
elapsed 1081 → 801 ms. The Δ-during-analysis figure was not re-measured.)

¹ A single `gc()` pass leaves exactly one archive-sized ArrayBuffer for
SINGLE-layer workspaces (external-buffer accounting lags a cycle); a second
`gc()` reclaims it completely (verified: after two passes a 1×159 MiB archive
returns to 159.0 MB — zero growth across repeated analyses; this is V8 GC
pacing, not a leak). Multi-layer workspaces retain nothing in a single pass.
Peak scales with the **largest single layer**, not with total size or layer
count (120 MiB payload: **661.5 MB** as one layer vs **315.9 MB** as 12×10 MiB;
the WASM path measured 787.7 / 308.0 MB on the same fixtures).

Notes:

- The fallback decoder holds no shared linear memory, so there is no grown
  heap to get stuck behind — retention is ordinary JS-heap GC (see¹). The
  peaks above are 120–172 MB lower than the WASM path on identical fixtures.
- The browser decodes in a per-analysis Web Worker terminated after the
  analysis; gzip layers never materialize a layer at all.
- node's RSS does not return its allocator high-water mark to the OS, so
  `afterGc rss` sits above baseline while `arrayBuffers` tracks the archive
  size (see¹).

The gzip path and (where available) the native
`DecompressionStream('zstd')` path remain fully streaming, with no fallback
allocation at all.

### Decoder integrity

**The vendored WASM decoder was removed.** In real Chromium (CI browser soak,
headless ubuntu-latest), analyzing the SAME archive twice in one tab produced
**different decompressed bytes on the second analysis** — the first analysis
verified against the config's `rootfs.diff_ids`, the second decompressed
layer 1/1 to `sha256:98fd2bc60cc9…` where the config expects
`sha256:e3add3d5…`. The integrity check refused the analysis instead of
emitting a wrong result — which is the only reason this was a caught failure
and not silent bad output. Earlier the same shared-heap decoder had already
failed in node with zstd error code `-72` on a long-lived instance.

Root-cause work, honestly reported:

- **What the vendored build is:** Emscripten with the legacy split-i64 ABI —
  `_ZSTD_getFrameContentSize` is exported as `(i32,i32)->i32` (low half only;
  the unknown-size sentinel `-1` happens to round-trip, and `contentSize === -1`
  in the wrapper is the only guard). Frames WITHOUT a content size are decoded
  one-shot with a heap of `defaultHeapSize` (16 MiB), growing on failure.
- **What it is not:** an ordinary logic bug. The vendored `zstd.wasm` is
  byte-identical to `@bokuweb/zstd-wasm@0.0.27`'s builds on all three
  distributions (md5 `85aa3e0c…`), and the ESM and CJS JS glues are
  byte-identical. Input bytes, allocation sizes and call order are
  deterministic across analyses. On node, 2,100 sequential decodes of the
  failing-class frame plus full-analysis sequences on a forced shared instance
  never diverge, and a 2,000-decode soak + 50 analyses never diverge in node
  — the corruption is specific to Chromium's execution of this WASM. The exact
  mechanism inside the linear-memory/literal-copy fast paths cannot be
  inspected from JS, and per-instance reuse was the observed trigger.
- **Why switch instead of report-and-keep:** the decoder could not be made
  trustworthy by wrapping it — every analysis would pay for the minuscule
  chance of silent divergence (the integrity check catches it, but an image
  whose `diff_ids` are absent would pass corrupt bytes through). The fix that
  removes the failure class is a decoder with **no shared linear memory at
  all**: [fzstd](https://github.com/101Arrowz/fzstd) (MIT), a pure-JavaScript
  Zstandard decoder. No upstream issue was filed, deliberately: the bug does
  not reproduce outside Chromium with identical binary/glue/inputs, so a
  public report would be speculation; the mitigation is complete and
  documented here. (If you maintain a fork of the vendored build and want the
  details — frame sha256, call sequence, CI run IDs — they are in commit
  cb09582 and run 42218626374.)
- **Guarantees now, in order:**
  1. **Decoders with no shared state.** The fallback is pure JS — each decode
     runs on a fresh internal state object, so cross-analysis degradation is
     structurally impossible. The browser additionally decodes in a
     per-analysis Web Worker terminated after the analysis (UI stays
     responsive on 100+ MiB layers; the state is destroyed with the worker).
  2. **Byte-cap enforced mid-decode.** `decodeZstdCapped()` streams every
     frame through an `ondata` handler and throws the instant the running
     total crosses `maxLayerBytes` — frames without a content size (streamed
     compression) cannot allocate past the cap, full stop. Zstd blocks are
     ≤ 128 KiB, so overshoot is at most one block.
  3. **Integrity verification (unchanged).** Every fallback-decoded layer is
     sha256-compared against the config's `rootfs.diff_ids`; mismatch fails
     the analysis with the layer index and both digests. gzip / plain-tar /
     native-zstd layers are streamed and cannot be hashed without buffering —
     they are unverified.
  4. **Soak, both environments** — `tools/soak-zstd.mjs` (node), and
     `tools/browser-soak.mjs` in one Chromium tab: the same frame decompressed
     2,000 times with every output sha256-verified; 50 analyses of one archive
     produce a single unique fingerprint. A 12-layer zstd archive analyzed
     **20 times in one tab** (`browser-soak --skip-phase-a --analyses 20
     --image bench12-zstd.tar`) covers multi-layer cross-analysis consistency.
  5. **Speed, not just safety.** On the fallback path fzstd measures *faster*
     than the WASM build it replaced (same machine, incompressible data):
     3 MiB frame 877 vs 733 MiB/s; 6×10 MiB 2498 vs 1033 MiB/s; 1×150 MiB
     607 vs 433 MiB/s; capped streaming 304–618 MiB/s depending on payload.
     (fzstd warns that WASM can beat it ~40–50% on highly compressible data;
     the fallback is rarely reached at all where native zstd streams exist.)

Limitation noted honestly: fzstd only supports back-reference distances up to
2^25 bytes (32 MiB) — "ultra" zstd levels (>19) on >32 MiB outputs may fail;
such frames are rare in registry images and error out cleanly rather than
silently corrupting. The integrity check would catch any undetected case
regardless.

Browser timings will differ; the bundled sample is 92 KiB and analyzes in milliseconds.
¹ Synthetic 6-layer OCI-save archive (gzip: `tools/synth-lib.mjs`; zstd:
`tools/ci/build-incompressible-zstd.mjs`), ~10.3 MiB of incompressible random
data per layer plus a 68-byte file duplicated across two layers. Content is
random, so compression achieves almost nothing — these rows describe decode+parse
cost on incompressible bytes, not on typical images.

## Repository layout

```
index.html              static app (landing + analysis views)
404.html                branded not-found page (deployed by pages.yml)
sitemap.xml / robots.txt  crawl entry points for the hosted site
assets/style.css        Vercel-inspired design system (self-hosted Geist, no frameworks, inline SVG icons)
assets/fonts/           Geist Sans/Mono woff2, subset latin, OFL (GEIST-LICENSE.txt)
assets/og.png           social preview card (og:image / twitter:image)
assets/vendor/fzstd/    vendored fzstd 0.1.1 (MIT) — see assets/vendor/fzstd/LICENSE.txt
assets/samples/layerscope-demo.tar  bundled sample for "Try a sample image" (regenerate: node tools/make-sample.mjs)
src/app.js              UI orchestration (dropzone, tabs, rendering)
assets/samples/layerscope-demo.tar  bundled sample for "Try a sample image" (regenerate: node tools/make-sample.mjs)
tools/make-sample.mjs   deterministic sample generator (seeded PRNG)
src/core/tar.js         streaming tar parser (chunked, bounded memory)
src/core/zstd.js        zstd support (native DecompressionStream, else per-analysis worker + fzstd)
src/core/zstd-decode.js pure-JS streaming zstd decode with a hard byte cap (shared by worker + node)
src/core/zstd.worker.js per-analysis decode worker (browser)
src/core/model.js       FileTree, whiteouts, squash/merge
src/core/analyze.js     archive orchestration + dive-compatible analysis
src/core/format.js      byte/percent formatting
tools/                  fixture synth, golden verification, comparison, smoke test, benchmarks
tools/ci/               CI-only helpers (build zstd OCI fixtures)
tools/browser-bench.mjs real-browser cold/warm analysis times (Chromium, used by browser-bench.yml)
tools/bench-memory.mjs  rss + arrayBuffers memory bench for the zstd fallback path
tools/soak-zstd.mjs     2000x same-frame decompress soak + 50-analysis fingerprint soak (node)
tools/browser-soak.mjs  same soak in one Chromium tab (Playwright)
tools/browser-limit.mjs 600 MiB-claim archive vs the browser fallback limit (Playwright)
tools/check-real-images.sh  pull public images, compare vs dive CLI (used by ci.yml real-images job)
tests/                  node --test unit tests
LICENSE                 MIT
CHANGELOG.md            release history (Keep a Changelog + semver)
SECURITY.md             private vulnerability reporting channel
CONTRIBUTING.md         ground rules + workflow (PR checklist, dive compat)
.github/pull_request_template.md / .github/ISSUE_TEMPLATE/  contribution plumbing
.editorconfig / .gitattributes  whitespace and encoding hygiene
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
- **[fzstd](https://github.com/101Arrowz/fzstd)** (101Arrowz, MIT) —
  vendored in `assets/vendor/fzstd/` as the fallback decoder for zstd layers
  on browsers without native `DecompressionStream('zstd')`. Pure JavaScript —
  chosen because the WASM decoder previously used here returned different bytes
  for the same frame on reuse in Chromium (see "Decoder integrity"). It
  implements Meta's [Zstandard](https://github.com/facebook/zstd) format
  (BSD-3-Clause).
- **[Geist](https://github.com/vercel/geist-font)** (Vercel, OFL) — the
  self-hosted Sans/Mono pair in `assets/fonts/`.

## License

[MIT](LICENSE). Swappable — if a different license is needed for this codebase,
the MIT text can be replaced wholesale.
