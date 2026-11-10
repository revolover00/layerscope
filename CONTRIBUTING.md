# Contributing to layerscope

Thanks for helping! The bar for merging is intentionally high because the
project's promise to users is simple: **the image you drop never leaves your
browser, and the analysis is dive-compatible to the byte.**

## Ground rules

- **No runtime network calls.** Everything must work offline on a static host.
  The only `fetch` is the bundled sample archive.
- **No frameworks, no CDNs.** Static files, self-hosted fonts, vanilla ES modules.
- **User-controlled text renders via `textContent`** (or `el()` in `src/app.js`)
  — never `innerHTML`. File paths and creating commands come from untrusted
  tar archives.
- **`npm test` must stay green** (see the CI badge) alongside the dive golden
  checks (`DIVE_REPO=/path/to/dive node tools/verify-fixtures.mjs` → 17/17) and
  `npm run smoke`.
- New deps need a reason someone else can quote in the PR description. Prefer
  stdlib and vendored-with-license files.

## Workflow

1. Fork, branch from `main`, keep the diff small and focused.
2. Run `npm ci && npm test && npm run smoke` locally before pushing.
3. If the change touches analysis logic, verify against dive:
   `git clone --depth 1 https://github.com/wagoodman/dive /tmp/dive-src`
   then `DIVE_REPO=/tmp/dive-src node tools/verify-fixtures.mjs`.
4. Open a PR using the template. Describe **what** and **why**; numbers from
   real runs beat adjectives.
5. CI has three jobs — `CI` (tests + goldens + samples vs dive), `Browser
   benchmark`, and `Deploy to GitHub Pages` (main only). All must be green.

## What will be rejected

- Registry/network resolution, daemon access, or any upload of image data.
- Rendering unsanitized markup from an archive.
- Weakening the integrity guarantees (`rootfs.diff_ids` checks, the 8 GiB
  fallback cap / `WINDOW_TOO_BIG` window policy) without a documented, discussed reason.
- Style-only diffs mixed into functional changes.

## License

Contributions are accepted under the MIT license (see `LICENSE`).
