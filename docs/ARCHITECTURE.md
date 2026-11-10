# Decoder integrity


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
  2. **Byte-cap enforced mid-decode, streaming end to end.** Every fallback
     frame flows through `createZstdDecompressor()` — an `ondata` handler
     throws the instant the running total crosses `maxLayerBytes` — and the
     decoded blocks feed straight into the tar parser over a
     `ReadableStream`; a layer is never materialized in memory. Frames without
     a content size (streamed compression) cannot allocate past the cap, full
     stop. Zstd blocks are ≤ 128 KiB, so overshoot is at most one block.
     Additionally, a frame whose **explicit window descriptor** exceeds
     32 MiB is refused with `WINDOW_TOO_BIG` before allocating (single-segment
     frames are exempt — window == content size); the check reads the frame
     header only.
  3. **Streaming worker protocol with bounded in-flight bytes.** In the
     browser the page feeds the worker compressed blocks (exact-size,
     zero-copy transfers) with at most 32 MiB acknowledged-in-flight
     (ack-driven flow control), and decoded blocks cross back the other way
     as exact-size copies — never views into fzstd's window, so a sentinel
     byte can never leak into the layer (the original one-shot transfer bug).
  4. **Integrity verification (unchanged).** Every fallback-decoded layer is
     sha256-compared against the config's `rootfs.diff_ids` (incremental
     pure-JS SHA-256, cross-verified against WebCrypto and the NIST
     vectors); mismatch fails the analysis with the layer index and both
     digests. gzip / plain-tar / native-zstd layers are streamed and not
     hashed — they are unverified.
  5. **Soak, both environments** — `tools/soak-zstd.mjs` (node), and
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
2^25 bytes (32 MiB) — a frame whose explicit window descriptor exceeds 32 MiB
is refused with `WINDOW_TOO_BIG` before allocating (single-segment frames are
exempt; the check applies to a blob's first frame, and later frames are
bounded by the byte budget and the decoder's internal ~2 GB hard cap). Such
frames are rare in registry images and error out cleanly rather than silently
corrupting. The integrity check would catch any undetected case regardless.

# Repository layout


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
tools/browser-limit.mjs crafted 17 GiB-FCS archive vs the 8 GiB browser fallback ceiling (Playwright)
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
