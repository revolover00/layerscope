# What works

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
  enforces the byte cap mid-decode** (see [Decoder integrity](ARCHITECTURE.md)). Verified
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
- **Image efficiency score and wasted bytes**, using [dive](https://github.com/wagoodman/dive)'s definitions: efficiency is Σ min(occurrence sizes) ÷ Σ cumulative sizes, and **wasted bytes** is the total bytes of every path seen in more than one layer or deleted — **including the copy that still exists** (the surviving copy). Whiteouts sizing the squashed directory they remove count as occurrences. The first (base) layer is excluded from the user-waste percentage.
- **Top 20 largest files**, two scopes: largest single layer entries across the
  whole image, and largest files in the final squashed image
- **File contents:** for uncompressed layers only tar headers are read; for
  compressed layers the data is decompressed locally in the browser to read
  those headers (zstd layers are additionally hashed locally — sha256 — to
  verify the image config's `diff_ids`). Nothing is uploaded.
- **Large files** are handled by streaming the archive in slices (`Blob.slice`)
  through `DecompressionStream`; the outer archive is never loaded whole into
  memory. Memory scales with the **largest single layer**, not with the archive's
  total size or file count: gzip layers and native-zstd layers stream end-to-end,
  while the fallback decoder holds one layer in memory at a time — released
  after each analysis (worker termination in the browser; GC-able in node) —
  see the [memory bench section](BENCHMARKS.md)
- **Suggestions tab** — one card per problem the data actually proves, each with severity, the affected layers and paths, an upper-bound byte figure and a plain-English fix: file added then deleted in a later layer; package-manager caches created and removed in different layers (apt lists, apk/dnf/yum/pacman caches, pip/npm/yarn caches); the same path rewritten in multiple layers; equal-size rewrites inside `chown`/`chmod`/`chgrp` commands (tar cannot express "metadata only", so full payloads are re-stored); and the five largest wasted paths. Only what the tar headers prove is claimed — upper bounds are labelled as such ([src/core/insights.js](../src/core/insights.js))
- **Compare two images** — a dedicated compare view with a second dropzone: total size, wasted, reclaimable, efficiency and layer-count deltas plus the final-manifest paths whose size changed most (top 10 by absolute delta). Both files are analyzed locally and stay on the device ([src/core/compare.js](../src/core/compare.js), squash-based comparison of the final manifests)
- **Export** — per-analysis **Export JSON** / **Export CSV** of the layers, diffs and wasted paths, honouring the active filters (`fileKind` + path filter narrow the diffs, the wasted-space filter narrows the wasted paths; selection, top-scope and row limit are recorded under `filters` but never limit the export). Schema and CSV layout are documented in [EXPORT.md](EXPORT.md) with a `schemaVersion` field; the CSV carries no timestamp so exports are byte-for-byte reproducible. No network calls ([src/core/exporter.js](../src/core/exporter.js))
- **UI:** filterable layer diff lists, wasted-space table with per-path copy counts, efficiency gauge, Wasted and Reclaimable byte stats (both defined in place), one-click copy of the creating command, keyboard-accessible dropzone, self-hosted Geist fonts (no CDN)

# What does not work (honestly)

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
  see the [browser benchmark table](BENCHMARKS.md). The python:3.12-slim single zstd layer
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

# How the efficiency score is computed

For every path, across layers in build order (leaf nodes only, whiteouts
resolved against the squashed lower tree):

- **occurrence** = 1 per layer that introduces the path (whiteout of a file
  counts as an occurrence of size 0; a whiteout of a directory occurrence sizes
  the directory's whole subtree in the squashed lower tree)
- **discovered** = Σ of occurrence sizes, **minimum** = Σ of per-path minima
- **efficiency** = minimum / discovered
- **wasted bytes** = Σ cumulative bytes of every path occurring more than
  once or deleted — including the surviving copy (dive's definition,
  byte-exact, verified against dive's goldens)
- **reclaimable** = wasted − bytes of the copies that survive in the final
  squashed image (layerscope's addition — e.g. 5.39 MB wasted → 5.20 MB
  reclaimable on `test3-zstd.tar`)
- **user wasted %** = wasted / (total bytes − first layer bytes)

Scores below 1.0 mean some bytes are shipped and then shadowed or deleted by a
later layer. This is dive's algorithm; matching it is the point of
`tools/verify-fixtures.mjs`.
