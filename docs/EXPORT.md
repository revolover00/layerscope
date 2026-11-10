# Exporting an analysis (JSON & CSV)

Every analysis in layerscope can be downloaded as a single JSON document or a
single flat CSV file. The export happens entirely in the browser tab — nothing
is sent anywhere; the `.json`/`.csv` file is written with the same
`Blob` + object-URL machinery as any other client-side download.

Both formats are produced from one document (`buildExport()` in
`src/core/exporter.js`), so the two files always agree. The JSON is the
contract; the CSV is a flattened rendering of the same document.

## `schemaVersion`

Both exports carry `"schemaVersion": 1`. The rules:

- **Additive** changes (new keys, new sections appended at the end) keep the
  version.
- **Breaking** changes (renamed/removed/retyped fields, changed semantics)
  bump `schemaVersion`.

Consumers should read `schemaVersion` first and refuse documents with a major
version they do not understand. The CSV carries `1` as the first column of
every row, so every CSV row is self-describing.

The JSON also carries `"tool": "layerscope"` and an `exportedAt` ISO-8601 UTC
timestamp. The **CSV deliberately carries no timestamp** — exports of the same
analysis are byte-for-byte identical every time.

## JSON document

Top-level keys, in order:

| Key | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | the export contract (see above) |
| `tool` | `"layerscope"` | producer name |
| `exportedAt` | ISO-8601 string | when the export was generated |
| `image` | object | `name` (from the image config's RepoTags when present, else the dropped file name) and `format` (`docker-save (legacy)` or `oci-save` / `oci-archive`) |
| `summary` | object | headline numbers — see below |
| `filters` | object | the UI filters that were active — see below |
| `layers` | array | one row per layer, in layer order |
| `diffs` | array | one row per file change, filtered — see below |
| `wastedPaths` | array | paths seen in ≥ 2 layers or deleted — dive's `fileReference` data, filtered by `wastedPathFilter` |

`summary`:

| Key | Type | Meaning |
|---|---|---|
| `layerCount` | number | number of (non-empty-history) layers |
| `totalSizeBytes` | number | uncompressed size of all layers |
| `userSizeBytes` | number | `totalSizeBytes` minus the first layer |
| `wastedBytes` | number | dive's wasted bytes (surviving copies included) |
| `reclaimableBytes` | number | wasted minus the copies surviving in the final squashed image |
| `wastedUserPercent` | number | `wastedBytes / userSizeBytes` (only meaningful when `userSizeBytes > 0`) |
| `efficiency` | number | dive's efficiency score, 0–1 |
| `compressedArchiveBytes` | number | size of the original tarball on disk |
| `platforms` | array \| null | multi-arch OCI only: `{ os, architecture, variant?, selected }` per manifest; `null` otherwise |
| `selectedPlatform` | string \| null | e.g. `linux/amd64`; `null` for legacy archives |

`filters` — recorded verbatim from the UI at export time:

| Key | Type | Applied to |
|---|---|---|
| `fileKind` | `"all" \| "added" \| "modified" \| "deleted"` | `diffs` section: `deleted` covers whiteouts **and** opaque markers (the same semantics as the Deleted bucket in the Layers tab) |
| `pathFilter` | string | `diffs` — case-insensitive substring on `path` |
| `wastedPathFilter` | string | `wastedPaths` — case-insensitive substring on `path` |
| `selectedLayer` | number \| null | **recorded only** — does not limit the export; every layer's diffs are included |
| `topScope` | `"layers" \| "final" \| null` | **recorded only** — the top-20 tables are not part of the export |
| `rowLimit` | number \| null | **recorded only** — the UI row cap does not limit the export |

`layers[]`:

| Key | Meaning |
|---|---|
| `index` | 0-based layer index |
| `command` | the `created_by` string from the image config (best effort) |
| `digestId` | `sha256:…` diff id when present, else `null` |
| `sizeBytes` / `compressedBytes` | uncompressed / on-disk layer blob size |
| `compression` | `none`, `gzip` or `zstd` |
| `entryCount` | number of tar entries |
| `counts` | `{ added, modified, deleted, opaqued }` entry counts |

`diffs[]` rows (sorted by `layer`, then `path`, then `kind`):

| Kind | Keys present | Notes |
|---|---|---|
| `added` | `layer, kind, path, sizeBytes` | new file payload size |
| `modified` | `layer, kind, path, sizeBytes, oldSizeBytes` | `sizeBytes` is the new size; `oldSizeBytes` the size in the previous squashed filesystem |
| `deleted` | `layer, kind, path, removedBytes, whiteoutPath, targetKnown, directory` | `removedBytes` is the full subtree size for directory whiteouts (0 when there was no lower target); `targetKnown=false` means the whiteout removed nothing below |
| `opaque` | `layer, kind, path, opaque: true` | an opaque directory marker — everything below `path` was hidden from lower layers |

Directories themselves are never listed (they carry no payload in the tar
header sense); only whiteout *targets* are, via `directory`.

`wastedPaths[]`: `{ path, count, sizeBytes }` — `count` is the number of
layer occurrences (whiteout of a lower file counts as one),
`sizeBytes` is the cumulative occurrence size (dive's `cumulativeSize`).
Sorted by `sizeBytes` descending, ties by path ascending.

## CSV document

RFC 4180, UTF-8, LF line endings, no BOM. Exactly one header row, then data
rows. Every row starts with `schemaVersion`. Column order:

```
schemaVersion,section,layer,kind,path,sizeBytes,oldSizeBytes,compressedBytes,copies,cumulativeBytes,removedBytes,whiteoutPath,targetKnown,directory,opaque
```

| Column | `section=layer` | `section=diff` | `section=wasted` |
|---|---|---|---|
| `schemaVersion` | `1` | `1` | `1` |
| `layer` | layer index | layer index | empty |
| `kind` | empty | `added`/`modified`/`deleted`/`opaque` | empty |
| `path` | empty | change path | wasted path |
| `sizeBytes` | layer size | new size (added/modified); empty otherwise | empty |
| `oldSizeBytes` | empty | previous size (modified only) | empty |
| `compressedBytes` | layer blob size | empty | empty |
| `copies` | empty | empty | occurrence count |
| `cumulativeBytes` | empty | empty | cumulative bytes |
| `removedBytes` | empty | deleted only | empty |
| `whiteoutPath` | empty | deleted only (`.wh.…` path) | empty |
| `targetKnown` | empty | deleted only (`true`/`false`) | empty |
| `directory` | empty | deleted only (`true`/`false`) | empty |
| `opaque` | empty | opaque rows only (`true`) | empty |

Empty cells mean "not applicable for this row kind" — they are never
fabricated zeros. Cells containing `,` `"` or newlines are quoted with `"…"`
and embedded quotes doubled, per RFC 4180.

Example (verbatim from the bundled `assets/samples/layerscope-demo.tar`,
trimmed to the first rows — real output, not invented):

```
schemaVersion,section,layer,kind,path,sizeBytes,oldSizeBytes,compressedBytes,copies,cumulativeBytes,removedBytes,whiteoutPath,targetKnown,directory,opaque
1,layer,0,,,65583,,70144,,,,,,,
1,layer,1,,,45,,3584,,,,,,,
1,layer,2,,,0,,2048,,,,,,,
1,layer,3,,,32,,2560,,,,,,,
1,diff,0,added,/app,0,,,,,,,,,
1,diff,0,added,/app/config.yml,23,,,,,,,,,
1,diff,0,added,/app/data.bin,65536,,,,,,,,,
```

## Guarantees and caveats

- **No network.** The export is assembled from the analysis already in
  memory and downloaded via an object URL. There is no upload, beacon or
  analytics of any kind.
- **Determinism.** For the same analysis object, `buildExport()` output is a
  pure function of the filters. The CSV is byte-for-byte reproducible; the
  JSON differs only in `exportedAt`.
- **Filter honouring.** `diffs` honours `fileKind` and `pathFilter`;
  `wastedPaths` honours `wastedPathFilter`. Everything else in the UI
  (`selectedLayer`, `topScope`, `rowLimit`) is recorded under `filters` for
  provenance but never limits the export.
- **tar-header sizes.** All byte figures are tar-header sizes; hardlinks
  count as 0 bytes. Wasted/reclaimable numbers mirror dive's semantics —
  see [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the formulas.
- **Names.** `image.name` is the repo tag from the image config when the
  archive carries one; otherwise the name you dropped in, otherwise `null`.
