# Changelog

All notable changes to layerscope are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-11-06 (site & repo hardening)

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

### Fixed

- README unit-test count corrected to 44/44; the headless-Chromium
  verification note now names `playwright-core` + `browser-bench.yml`
  instead of a non-dev dependency
- `src/core/analyze.js`: worker-lifetime comment no longer refers to the
  removed WebAssembly build
- Removed the meta `Content-Security-Policy` added in 9789e7b: it broke the
  analysis flow in headless Chromium (`Browser benchmark` failed at the
  first-analysis step on both branch and main). It will be re-introduced
  only behind a green browser-bench run.

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

- History was rewritten to a single author (`revolover00`); the original
  pre-rewrite history is preserved under the `backup/*-pre-rewrite-2026-11-06`
  tags on the remote.
- 44 node unit tests (`npm test`), 17/17 dive golden fixtures, decoder soak
  green in CI, real-Chromium cold/warm timings in the Browser benchmark
  workflow.

[0.1.0]: https://github.com/revolover00/layerscope/releases/tag/v0.1.0
