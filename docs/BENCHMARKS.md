# Benchmarks (measured, with environment)

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

## Real-browser timings (Playwright Chromium in GitHub Actions)

Measured by `browser-bench.yml` (headless Chromium, ubuntu-latest, site served
locally, archive uploaded through the real file input; time from upload until
the analysis view is fully rendered). "warm" is the second analysis in the same
page; since the fix for the decoder degradation (see [Decoder integrity](ARCHITECTURE.md)),
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
Timings vary noticeably run-to-run (we have seen differences of up to ~70% between runs); treat them as order-of-magnitude, not
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

Browser timings will differ; the bundled sample is 92 KiB and analyzes in milliseconds.
¹ Synthetic 6-layer OCI-save archive (gzip: `tools/synth-lib.mjs`; zstd:
`tools/ci/build-incompressible-zstd.mjs`), ~10.3 MiB of incompressible random
data per layer plus a 68-byte file duplicated across two layers. Content is
random, so compression achieves almost nothing — these rows describe decode+parse
cost on incompressible bytes, not on typical images.

## Big legacy docker-save fixture (~3 GB) — added in PR #31

A sparse ~3.15 GB legacy `docker save` tar (file bodies are holes; generated
on the fly in the `Browser benchmark` workflow, never committed):
3 layers × 1000 × 1 MiB zero files + one shared 1 MiB `shared/dup.bin` per layer
(+3 occurrences) + a per-layer `app/config.yml`. The fixture
(`tools/ci/build-big-legacy.mjs`) is built in ~4 s. In the browser fixture job
(`tools/browser-big.mjs`, desktop 1440×900) the archive is uploaded through
the real file input; layers / total / wasted / reclaimable / efficiency are
asserted equal to an independent Node reference analysis on the same file
(`tools/ci/analyze-big.mjs`, the same `src/core/analyze.js` code path, over an
fs-backed lazy Blob).

Content bytes (header-counted, dive semantics): **3,148,873,761 B total
("2.93 GB")**; **wasted 3,145,761 B ("3.00 MB")** (`shared/dup.bin` ×3 =
3,145,728 B + `app/config.yml` ×3 = 33 B); **reclaimable 2,097,174 B
("2.00 MB")**; efficiency **0.99933**; wsPaths **2**; per-layer content
1,049,624,587 B × 3 (checked against the analyzer's output — they match).
`diff_ids` are sha256 over the written regions and are deterministic across
generator rewrites.

| where | wall time | memory |
|---|---|---|
| Node reference analysis, Linux, Node v22.22.3 (this table's environment) | **9.37 s** (`elapsedMs` 9,372) | RSS peak **≈ 1.08 GiB** (pass 1 buffers one ~1.05 GiB layer tar at a time before skipping it; JS heap stays ≈ 11 MB — external buffers dominate) |
| GitHub Actions run [42408649792](https://github.com/revolover00/layerscope/actions/runs/42408649792) (ubuntu-latest, Chromium via playwright-core, desktop 1440×900) | step green; whole job **2 m 9 s** end to end (includes zstd fixture builds, docker pulls, bench, soak, limit and fixture steps) | peak `usedJSHeapSize` sampled in-page every 200 ms — **not retrievable**: the `::notice::` metrics live in the job log, and GitHub's log storage was unreachable (EOF) from the measurement environment; job success is the evidence the analysis finished with zero console/page errors and all numbers matched the Node reference |

The ~3 GB of zero bodies are never decompressed — uncompressed legacy layers
are parsed by skipping data sections (buffering one at a time) — so this
fixture measures archive-scale scanning and analysis, **not** multi-GB decode
throughput; the 150/160 MiB single-layer zstd rows above remain the
decode-scale evidence. The file is sparse end to end, so container CI disk
usage stays ~12 MB for the fixture itself.
