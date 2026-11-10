# Verification — what was actually run

Numbers below are real output from this repository, not aspirations.

## Unit tests

```
$ npm test          # node --test
# tests 49   # pass 49   # fail 0
```

## layerscope vs. dive's own golden files

dive commits golden analysis exports for its fixture suite
(`internal/imagefixture/testdata/golden/*.export.json`). layerscope recreates
every synthesized fixture byte-for-byte (the fixture tar writer matches Go's
`archive/tar` GNU-format output) and diffs its analysis against those goldens —
no expected values are hardcoded, and no goldens are rewritten by tooling.

**Pin, and why:** dive's committed goldens live only on dive's `main` branch —
they arrived in dive#727 (the stereoscope port); tag **v0.13.1 has no
`internal/imagefixture` tree at all**, so cloning it makes every fixture
silently skip. This verifier therefore pins the exact upstream commit the
goldens were last verified against, `e97febbeb6956b11f679f6d823762752185e3fef`
(tip of dive `main` at the time of writing), rather than a moving branch head.
When dive releases a tag containing the golden suite, pin that tag instead.
(The docker-daemon comparison jobs use the released dive **v0.13.1** binary.)

```
$ git init -q /tmp/dive-src
$ git -C /tmp/dive-src remote add origin https://github.com/wagoodman/dive
$ git -C /tmp/dive-src fetch -q --depth 1 origin e97febbeb6956b11f679f6d823762752185e3fef
$ git -C /tmp/dive-src checkout -q FETCH_HEAD
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

## Real public images vs. the real dive CLI

CI (`.github/workflows/ci.yml`, `real-images` job, `tools/check-real-images.sh`)
pulls six public images — `alpine`, `busybox`, `nginx:alpine`, `python:3.12-slim`,
`node:20-alpine`, `ubuntu:24.04` — `docker save`s them, analyzes with dive
v0.13.1 via the daemon (`dive --json`) and with layerscope on the same tar, and
compares with the same `tools/lib-compare.mjs` and tolerances as the golden
verification (efficiencyScore rel tol 1e-9; everything else exact;
fileReference as described above). Every difference is printed — nothing is
suppressed. See the CI badge
(pulls via `mirror.gcr.io` with docker.io fallback; the job is re-run on every
push). The one real discrepancy found during bring-up was python:3.12-slim's
three zero-byte dpkg lock entries — the dive v0.13.1 intra-tie order artifact
described above, not a layerscope bug; after the multiset comparison landed,
python:3.12-slim matches exactly (image sizeBytes 119,470,750; inefficientBytes
5,690,470; efficiencyScore 0.9671877593469531 identical to dive).

## Sample images vs. the real dive CLI

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

**See the CI badge.** The comparison step passed on all four samples — layerscope's
numbers match the real dive CLI exactly on images built by docker. dive --ci
passes on `clean` and rejects the three wasteful samples as designed. (An
earlier revision of the job fed dive the archives via the `docker-archive:`
source scheme; dive exited non-zero with it, so the job now uses the daemon.)

You can reproduce it where docker and dive are available:

```bash
DIVE=/path/to/dive tools/check-samples.sh
```

## UI smoke test

`tools/smoke-ui.mjs` (jsdom, no browser needed) loads `index.html`, serves the
bundled sample archive from disk in place of the HTTP fetch, clicks
**Try a sample image** and walks the whole analysis view — layers, tabs,
filters, gauge, platform-picker visibility — asserting the DOM updates.
`npm install && npm run smoke` → `SMOKE TEST PASSED`.

## Browser check (headless Chromium)

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
- **A gzip- or zstd-wrapped outer archive was rejected with a targeted
  message** (`docker save … | gzip` produces one) instead of the generic
  "no manifest.json" error. Wrapper archives are now **supported** —
  stream-decompressed into the tar parser with numbers identical to the
  unwrapped archive (asserted in node unit tests and in real Chromium).

Other fixes from the same passes: deleted-file rows now show the actual
lower-layer size ("file · 1.50 MB hidden below"), modified directories render
as "directory" instead of "0 B → 0 B", whiteout/opaque markers are excluded
from top-largest-file lists, and extreme user-wasted ratios render grouped
("2,042,740%"). Zero console/page errors were observed across the landing,
layers, wasted-space and top-files views after the fixes.
