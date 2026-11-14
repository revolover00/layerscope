# layerscope CLI

Analyze a `docker save` / OCI image archive on the command line — the same
engine the web UI runs, the same numbers, nothing uploaded. Node 20+, no
runtime dependencies beyond the vendored fzstd fallback decoder; no native
builds.

## Install

**npm (not published yet — maintained for publishing):**

```bash
npm install -g layerscope
layerscope --version
```

**From a checkout of this repository:**

```bash
npm ci
node bin/layerscope.mjs --help        # run directly
npm link                              # or put `layerscope` on your PATH
```

**Prerequisites:** Node.js ≥ 20 and an uncompressed `docker save` / OCI
archive. `docker save` already emits an uncompressed `.tar`; the CLI rejects
gzip/zstd-wrapped archives with a clear message (unpack with `gzip -d` first).

## Usage

```bash
layerscope analyze <image.tar> [options]
docker save myapp:latest | layerscope analyze -
```

Options:

| flag | meaning |
| --- | --- |
| `--json` | print the stable machine-readable report (schemaVersion 1, below) instead of the table |
| `--fail-under-efficiency N` | exit 1 when the efficiency ratio is below N. Fraction in `[0,1]` (`0.9`) or percent with `%` (`90%`) |
| `--fail-over-wasted BYTES` | exit 1 when wasted bytes exceed BYTES (non-negative integer; `1 MB` = 1000000) |
| `--max-layer-bytes N` | refuse zstd layers that declare or decode beyond N bytes (integer). Same option as the engine; default 160 MiB. gzip layers stream and are unaffected |
| `--platform OS/ARCH[/VARIANT]` | multi-manifest OCI archives only: select the manifest (e.g. `linux/arm64`, `linux/arm/v7`). Default: `linux/amd64` when present, else the first manifest; a missing request analyses the default and records a warning |
| `-h`, `--help` | help |
| `-v`, `--version` | version |

### Exit codes

| code | meaning |
| --- | --- |
| `0` | analysis completed, all thresholds satisfied |
| `1` | analysis completed, at least one `--fail-*` threshold breached (stdout still carries the full report) |
| `2` | bad input or error — unreadable/corrupt archive, unsupported wrapper, invalid option, analysis failure |

Threshold breaches are printed to stderr, one line each; all failing
thresholds are reported, not just the first.

### Reading from stdin

`layerscope analyze -` spools stdin to a temporary file first (memory stays
O(4 MiB chunks), disk usage equals the archive size), analyzes it, and deletes
the temporary file — including on failure. This is the intended shape for
`docker save myapp:latest | layerscope analyze -`.

### Memory model

The archive is never read into memory in full. Layers are streamed in 4 MiB
windows through the same code paths as the browser; only tar headers are
buffered. zstd layers are the exception by design: when the platform's native
streaming decoder is unavailable, the pure-JS fzstd fallback materializes one
layer (bounded by `--max-layer-bytes`, default 160 MiB) and verifies it
against the image config's `rootfs.diff_ids`.

## Example — real output

```console
$ layerscope analyze assets/samples/layerscope-demo.tar
layerscope/sample:latest — docker-save (legacy)
source: assets/samples/layerscope-demo.tar   archive on disk: 92.0 KB

Layers (4):
  #    size         compression  entries  command
  0   64.0 KB      none               5  echo layerscope-sample > /etc/sample-release
  1   45 B         none               3  sed -i 's/version:.*/version: 2/' app/config.yml
  2   0 B          none               2  rm /app/data.bin
  3   32 B         none               2  echo notes > /app/notes.txt

Summary:
  total layer bytes   64.1 KB
  wasted              64.0 KB (85,171% of user bytes)
  reclaimable         64.0 KB
  efficiency          0.154% (ratio 0.00153823)

Top files in the final image:
         32 B  /app/notes.txt
         24 B  /etc/sample-release
         23 B  /app/config.yml
         22 B  /app/helper.sh

Top wasted paths:
   2×      64.0 KB  /app/data.bin
   2×         46 B  /app/config.yml

Warnings: none
```

Threshold gating, exactly as a CI step would use it:

```console
$ layerscope analyze assets/samples/layerscope-demo.tar --fail-under-efficiency 0.9
layerscope: efficiency 0.154% (ratio 0.00153823) is below the required 90.0% (ratio 0.900000) (--fail-under-efficiency 0.9)
$ echo $?
1
```

## `--json` report — schemaVersion 1

The report is deterministic: same archive in, byte-identical document out
(no timestamps, raw numbers unrounded). Keys are always present; `null` means
"not applicable" (e.g. `image.name` for an unnamed archive, `digestId` for
archives without layer diff-ids). Consumers should check `schemaVersion` and
ignore keys they do not know. Additive changes may land without a
`schemaVersion` bump; any rename/removal/remeaning bumps it.

| field | type | meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | report schema version |
| `tool.name` / `tool.version` | string | `layerscope` and the CLI version |
| `image.name` | string\|null | repo tag from the archive's manifest |
| `image.format` | string | e.g. `docker-save (legacy)`, `docker-save (oci+legacy dual)`, `oci-archive` |
| `image.compressedArchiveBytes` | integer | size of the archive on disk (or the spooled stdin) |
| `image.selectedPlatform` | string\|null | `os/arch[/variant]` actually analyzed (multi-manifest OCI only) |
| `image.platforms` | object[]\|null | all descriptors in the index with a `selected` flag (multi-manifest OCI only) |
| `summary.layerCount` | integer | number of layers |
| `summary.totalSizeBytes` | integer | sum of uncompressed layer bytes |
| `summary.userSizeBytes` | integer | total minus the first (base) layer |
| `summary.wastedBytes` | integer | sum of cumulative bytes of paths written more than once |
| `summary.reclaimableBytes` | integer | wasted minus the copies surviving in the final image |
| `summary.wastedUserPercent` | number | `wastedBytes / userSizeBytes` (ratio, can exceed 100) |
| `summary.efficiency` | number | `sum(min) / sum(cumulative)` over all paths — dive's score (0..1) |
| `layers[]` | object[] | per layer: `index`, `digestId` (string\|null), `command` (string\|null), `sizeBytes`, `compressedBytes`, `compression` (`none`/`gzip`/`zstd`), `entryCount` |
| `inefficiencies[]` | object[] | paths written in multiple layers: `path`, `count`, `sizeBytes` (already sorted by sizeBytes desc) |
| `topFinalFiles[]` | object[] | largest files in the squashed final image (≤ 20): `path`, `size`, `type` |
| `topLayerEntries[]` | object[] | largest entries across all layers (≤ 20): `path`, `size`, `layer` |
| `warnings[]` | string[] | human-readable caveats (e.g. requested platform missing, config without diff-ids) |

Deliberately omitted: the per-layer full file inventories (they can exceed
the archive size). Use the web UI for per-layer browsing; use `inefficiencies`
and `topFinalFiles` for automation.

### Numbers match the engine

The CLI runs the identical `analyzeImage()` the web UI runs. CI
(`cli-real-images` job, `tools/check-real-cli.sh` +
`tools/ci/compare-cli-web.mjs`) runs the CLI's `--json` on the six public
images from `tools/check-real-images.sh` and requires a deep equality with
the in-process engine — no tolerances. `tests/cli.test.mjs` does the same for
every synthesizable dive fixture.

The human-readable table is for people and may change cosmetically between
releases; only `--json` is a contract.
