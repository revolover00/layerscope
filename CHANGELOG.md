# Changelog

All notable changes to layerscope are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- README restructured; long material moved to docs/
- Landing-page copy accuracy pass: the hero's multi-GB streaming claim
  replaced with what is tested (memory scales with the largest layer;
  tested up to 150 MiB per layer); footer "Honest limits" renamed to
  "Limits"; the bundled-sample sentence repaired; "Try a sample image"
  now uses the secondary `.btn-ghost` style like the other secondary
  buttons; the browser fixture job now asserts the idle landing page
  (sample button visible/enabled; no visible "Reading archive" text) on
  desktop and on a 390x844 viewport

## [0.1.1] — 2026-11-07

Released 2026-11-07 via tag `v0.1.1` on `34a1def` (squashed from PR #22).

### Added

- `404.html`: branded not-found page (served by GitHub Pages for bad paths)
- `assets/og.png`: social-preview card; `index.html` gains canonical link,
  `og:url` / `og:site_name` / `og:image` (1730×909) and
  `twitter:card summary_large_image`
- `robots.txt` and `sitemap.xml`; `pages.yml` now stages `404.html`,
  `robots.txt` and `sitemap.xml` with the deploy
- `CONTRIBUTING.md` (contribution invariants + workflow), `SECURITY.md`
  (private reporting via GitHub Security advisories), this changelog
- PR + issue templates, `dependabot.yml` (github-actions and npm, weekly),
  `.editorconfig`, `.gitattributes`
- **Reclaimable** metric: `reclaimableBytes` in the analysis output and in
  `tools/analyze.mjs` output; shown as a clearly-labelled summary stat card
  and scorecard row, defined in place (wasted minus the copies that survive
  in the final squashed image). `Wasted` keeps dive's definition unchanged —
  still verified byte-exact against dive's goldens (17/17)
- Unit tests pinning both metrics on synthetic images
  (`tests/reclaimable.test.mjs`)
- `tools/test-fixtures.mjs` — deterministic generators for the two browser-bench
  fixtures: `test1-waste.tar` (legacy docker-save layout) and `test3-zstd.tar`
  (same content, OCI layout with zstd layers). The content spec: base layer
  with 200 KiB random `app/config.txt` + small files; layer 2 adds a 5 MiB
  random `data/big.bin`; layer 3 is the whiteout `data/.wh.big.bin`; layer 4
  rewrites `app/config.txt` (200 KiB random); one `empty_layer` CMD history
  entry. Analysis on both layouts: 4 layers, wasted **5,652,480 bytes**,
  efficiency ≈ 3.6% (~3.62%).
- Browser benchmark now asserts those exact numbers in real Chromium on every
  push/PR (`tools/browser-fixtures.mjs` + new step in `browser-bench.yml`),
  including identical stats across 3 consecutive uploads in the same page.
- `tests/long-back-reference.test.mjs` — zstd frame with a 10 MiB
  back-reference distance (> 8 MiB) decodes byte-identically through the
  fallback decoder; includes an FCS-less variant so streamed-compression
  windows are covered too.
- `pull_request` trigger on the browser benchmark (it was `push`/dispatch
  only), so the required check reports on every PR (#19)

### Fixed

- README unit-test count corrected so it matches the actual suite (no
  hard-coded number remains in prose; the CI badge is authoritative); the
  headless-Chromium verification note now names `playwright-core` +
  `browser-bench.yml` instead of a non-dev dependency
- `src/core/analyze.js`: worker-lifetime comment no longer refers to the
  removed WebAssembly build
- Removed the meta `Content-Security-Policy` added in 9789e7b: it broke the
  analysis flow in headless Chromium (`Browser benchmark` failed at the
  first-analysis step on both branch and main). It will be re-introduced
  only behind a green browser-bench run.
- Layer-diff kind badge was truncated to four characters ("ADDE"); the
  badge column now fits ADDED / MODIFIED / DELETED
- Wasted stat explains the definition in place (tooltip + sub-line) and
  points at Reclaimable; the wasted-space panel documents the exact dive
  formula and the reclaimable rule; README explains both metrics with the
  `test3-zstd.tar` example (5.39 MB wasted, 3.6% efficiency, 5.20 MB reclaimable)
- README "Image efficiency score and wasted bytes" bullet now states dive's
  actual formulas (efficiency = Σ min ÷ Σ cumulative; wasted = full cumulative
  of every path in ≥ 2 layers or deleted, surviving copy included); the
  "File contents" bullet describes the real pipeline (uncompressed layers →
  tar headers only; compressed layers → decompressed locally to read headers;
  zstd → also sha256-hashed locally for the integrity check); nothing is uploaded
- README gains an explicit AI-assistance disclosure line; hard-coded unit-test
  counts were removed from prose (the CI badge is authoritative); the stale
  CHANGELOG "corrected to 44/44" line now matches the actual suite
- README and `tools/verify-fixtures.mjs` document exactly which dive ref the
  golden-file check uses: dive's committed goldens exist only on dive `main`
  (dive#727, the stereoscope port); the verifier pins upstream commit
  `e97febbeb6956b11f679f6d823762752185e3fef`. Released dive v0.13.1 carries no
  `internal/imagefixture` tree (verified), so cloning it makes every fixture
  silently skip. The docker-daemon compare jobs keep using the released
  v0.13.1 binary.
- Backup tags `backup/*-pre-rewrite-2026-11-06` and merged session branches
  were deleted on 2026-11-07 (the pre-rewrite history had been preserved there
  by the history rewrite, including agent attribution trailers)

### Changed

- GitHub Actions refreshed: actions/checkout v4→v7, actions/setup-node v4→v7,
  actions/upload-artifact v4→v7, actions/configure-pages v5→v6,
  actions/upload-pages-artifact v3→v5, actions/deploy-pages v4→v5

[0.1.1]: https://github.com/revolover00/layerscope/releases/tag/v0.1.1
[unreleased]: https://github.com/revolover00/layerscope/commits/main

## [0.1.0] — 2026-11-06

First public release.

### Added

- Browser-only Docker image inspector: drop a `docker save` tarball, everything
  runs locally — nothing is uploaded, no backend.
- Legacy (`manifest.json` + `<id>/layer.tar`) and OCI (`index.json` +
  `blobs/sha256/...`) archive layouts, including dual-format archives.
- Multi-manifest OCI indexes with an in-place platform picker; `linux/amd64`
  by default with a warning naming the selected manifest.
- gzip layers streamed through `DecompressionStream`.
- zstd layers decoded one per analysis in a dedicated Web Worker:
  natively via `DecompressionStream('zstd')` where available, otherwise with a
  vendored pure-JavaScript streaming decoder (fzstd, MIT) — no shared linear
  memory, no instance reuse across analyses.
- Two-tier byte cap enforced mid-decode at 160 MiB (configurable via the
  `maxLayerBytes` option of `analyzeImage()`): frames with a content size are
  refused pre-allocation; frames without one (containerd/buildx streamed
  compression) are cut off the moment the running total crosses the cap.
- Every fallback-decoded layer is sha256-verified against the image config's
  `rootfs.diff_ids`; mismatch fails the analysis with layer index and digests.
- Per-layer added/modified/deleted/moved diffs with whiteout and
  opaque-directory handling; hidden-bytes reporting for whiteouts.
- dive-compatible efficiency score, wasted bytes per path (min occurrence
  across layers is useful), base layer excluded from user-waste percentage,
  same "leaf nodes only" scoring rule.
- Top-20 largest files in two scopes (single-layer entries, final squashed
  image), filterable layer lists, copyable creating commands, keyboard-
  accessible dropzone.
- Bundled 92 KiB sample image (`assets/samples/layerscope-demo.tar`,
  regenerate with `node tools/make-sample.mjs`).
- Full offline toolbelt: fixture synth, dive golden verification
  (`17/17`), comparison tooling, decoder soaks, memory benchmarks, jsdom UI
  smoke test, browser benchmark workflow.

### Development notes

- History was rewritten to a single author (`revolover00`). The pre-rewrite
  snapshot tags that were mentioned here (`backup/*-pre-rewrite-2026-11-06`)
  were deleted on 2026-11-07; pre-rewrite commit SHAs remain reachable only
  via pull-request refs.
- Node unit tests (`npm test`; counts deliberately not hard-coded here — the
  CI badge is authoritative), 17/17 dive golden fixtures, decoder soak
  green in CI, real-Chromium cold/warm timings in the Browser benchmark
  workflow.

[0.1.0]: https://github.com/revolover00/layerscope/releases/tag/v0.1.0
