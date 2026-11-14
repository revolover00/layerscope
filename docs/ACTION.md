# layerscope GitHub Action

Composite action at the repository root (`action.yml`). It runs the
[layerscope CLI](CLI.md) on your image and fails the job when your
thresholds are breached — analysis happens on the runner, nothing is
uploaded anywhere. The Markdown summary is appended to the job's step
summary page.

## Requirements

- `image` input: the runner needs `docker` (true for GitHub-hosted
  `ubuntu-latest` runners) and the image must be built or pulled first.
- `image-tar` input: any runner with Node 20+ and an uncompressed
  `docker save` archive. No docker needed.
- Node 20+ available on PATH — add `actions/setup-node` before the action
  (see the examples). GitHub-hosted runners also ship a system Node, but
  pinning is recommended.

## Minimal example (image input)

```yaml
name: image bloat gate
on: [pull_request]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22

      - name: Build the image
        run: docker build -t layerscope-samples/add-delete samples/add-delete

      - name: Analyze and gate
        uses: revolover00/layerscope@main   # or revolover00/layerscope@v0.2.0, or ./ in this repo
        with:
          image: layerscope-samples/add-delete
          min-efficiency: '0.9'             # fail the job below 90% efficiency
          max-wasted-bytes: '52428800'      # fail the job above 50 MB wasted
```

## Example: gate on a pre-built tar archive

```yaml
      - name: Analyze and gate
        uses: revolover00/layerscope@main
        with:
          image-tar: ./build/image.tar
          min-efficiency: '0.9'
```

## Example: record the result without failing (report-only mode)

```yaml
      - name: Analyze (report only)
        id: layerscope
        uses: revolover00/layerscope@main
        continue-on-error: true
        with:
          image: myapp:ci
          min-efficiency: '0.9'

      - name: Show the outcome
        run: |
          echo "efficiency:  ${{ steps.layerscope.outputs.efficiency }}"
          echo "wasted:      ${{ steps.layerscope.outputs.wasted }}"
          echo "reclaimable: ${{ steps.layerscope.outputs.reclaimable }}"
          echo "step outcome: ${{ steps.layerscope.outcome }}"   # 'failure' when the gate tripped
```

## Inputs

| input | required | meaning |
| --- | --- | --- |
| `image` | one of the two | image name/tag to analyze; the action runs `docker save <image>` itself |
| `image-tar` | one of the two | path to an existing uncompressed `docker save` tar |
| `min-efficiency` | no | fail the job below this efficiency ratio. Fraction in `[0,1]` (`0.9`) or percent with `%` (`90%`). Empty = no check |
| `max-wasted-bytes` | no | fail the job above this many wasted bytes (integer). Empty = no check |

Providing both `image` and `image-tar` fails fast with an error — pick one.

## Outputs

| output | meaning |
| --- | --- |
| `efficiency` | efficiency ratio (0..1) of the analyzed image |
| `wasted` | wasted bytes (paths written more than once) |
| `reclaimable` | wasted minus the copies surviving in the final image |

Outputs are set whenever the analysis produced a report — including when the
threshold check failed but the analysis itself succeeded. They are not set
when the archive could not be read at all (the step writes an error summary
instead).

## What the step does

1. Resolves the archive (`docker save` for `image`, or validates `image-tar`).
2. Runs `node $GITHUB_ACTION_PATH/bin/layerscope.mjs analyze <tar> --json`
   with the threshold flags mapped onto `--fail-under-efficiency` /
   `--fail-over-wasted` (see [CLI.md](CLI.md)).
3. Writes a Markdown summary (format, size, layers, wasted, reclaimable,
   efficiency, top wasted paths, warnings) to `$GITHUB_STEP_SUMMARY`, and
   `efficiency` / `wasted` / `reclaimable` to `$GITHUB_OUTPUT`.
4. Exits with the CLI's code: `0` pass, `1` threshold breached (job fails),
   `2` bad input (job fails). The summary is written before the exit, so a
   failing run still renders.

## Local test of this action

`.github/workflows/ci.yml` (job `action`) exercises `uses: ./` on
`samples/add-delete` — the passing case (lenient threshold), the failing
case (`min-efficiency: 0.999999`, asserted to fail the step), the
`image-tar` input path, and the both-inputs rejection. The six public images
from `tools/check-real-images.sh` are covered by the `cli-real-images` job,
which compares the CLI's `--json` against the in-process engine for each one.

## Notes

- Numbers follow dive's definitions; `efficiency` and `wasted` are identical
  to what the web UI reports for the same archive.
- The step summary page inherits the CLI's honesty: warnings from the
  analysis (e.g. requested platform missing, unverifiable integrity) are
  listed verbatim.
- The archive is spooled or read from disk; the runner's disk holds one
  extra copy when `image` is used (the `docker save` output), deleted when
  the runner's temp directory is cleaned. Nothing leaves the runner.
