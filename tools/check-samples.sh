#!/usr/bin/env bash
# Build the sample images, save them, analyze with layerscope and (if a dive
# binary is available) compare against `dive --json` and exercise `dive --ci`.
#
# Usage:
#   tools/check-samples.sh                 # build + layerscope analysis
#   DIVE=/path/to/dive tools/check-samples.sh   # also compare vs dive
#
# Requires: docker. Optional: dive v0.13.1 (see DIVE env var).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${OUT_DIR:-/tmp/layerscope-samples}"
WORK="${OUT_DIR}/work"
mkdir -p "$WORK" "$OUT_DIR/out"

SAMPLES="clean add-delete overwrite multi-waste"

echo "==> building sample images"
for name in $SAMPLES; do
  docker build --no-cache -t "layerscope-samples/${name}" "samples/${name}" >/dev/null
  docker save -o "${WORK}/${name}.tar" "layerscope-samples/${name}"
  echo "    saved ${WORK}/${name}.tar"
done

echo "==> analyzing with layerscope"
for name in $SAMPLES; do
  node tools/analyze.mjs "${WORK}/${name}.tar" --json "${OUT_DIR}/out/${name}.layerscope.json"
done

if [ -n "${DIVE:-}" ] && [ -x "${DIVE}" ]; then
  echo "==> analyzing with dive (${DIVE}) via the docker daemon"
  for name in $SAMPLES; do
    docker load -i "${WORK}/${name}.tar" >/dev/null
  done
  for name in $SAMPLES; do
    "${DIVE}" --json "${OUT_DIR}/out/${name}.dive.json" "layerscope-samples/${name}"
  done

  echo "==> comparing layerscope vs dive"
  failed=0
  for name in $SAMPLES; do
    echo "--- ${name}"
    node tools/compare.mjs "${OUT_DIR}/out/${name}.dive.json" "${OUT_DIR}/out/${name}.layerscope.json" || failed=1
  done

  echo "==> dive --ci (default rules: lowestEfficiency=0.9, highestUserWastedPercent=0.1)"
  if "${DIVE}" --ci layerscope-samples/clean; then
    echo "    clean: PASS (expected)"
  else
    echo "    clean: FAIL (unexpected — investigate)"
    failed=1
  fi
  for name in add-delete overwrite multi-waste; do
    if "${DIVE}" --ci "layerscope-samples/${name}"; then
      echo "    ${name}: unexpectedly passed default CI rules"
    else
      echo "    ${name}: rejected by default CI rules (expected — wasteful by design)"
    fi
  done

  if [ "$failed" -ne 0 ]; then
    echo "SAMPLES CHECK FAILED"
    exit 1
  fi
  echo "SAMPLES CHECK OK"
else
  echo "==> dive binary not provided (set DIVE=/path/to/dive to enable comparison); skipped"
fi
