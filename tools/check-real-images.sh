#!/usr/bin/env bash
# Pull real public images, `docker save` them, and compare layerscope against
# the dive CLI with the SAME comparison lib and tolerances as the sample-image
# job (tools/lib-compare.mjs: efficiencyScore relative tolerance 1e-9, everything
# else exact). The number of differing entries per layer is always printed; at
# most 10 example entries per layer are printed (same as the samples job).
# Nothing is suppressed and tolerances are not loosened.
#
# Usage:
#   DIVE=/path/to/dive tools/check-real-images.sh
# Optional:
#   IMAGES="alpine busybox"   override the image list (space separated)
#   OUT_DIR=/tmp/...          override the output directory
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGES="${IMAGES:-alpine busybox nginx:alpine python:3.12-slim node:20-alpine ubuntu:24.04}"
OUT="${OUT_DIR:-/tmp/layerscope-real-images}"
WORK="$OUT/work"
DIVE="${DIVE:-/tmp/dive}"
mkdir -p "$WORK" "$OUT/out"

tag_of() { echo "$1" | tr '/:' '__'; }

# Docker Hub anonymous pulls from shared CI runners are often rate-limited;
# mirror.gcr.io serves the same official-image namespace, so we try it first
# and fall back to docker.io, with one retry per registry. Images are always
# tagged back to their canonical name before saving.
pull_one() {
  local img="$1"
  for attempt in 1 2 3; do
    if docker pull "mirror.gcr.io/library/$img"; then
      docker tag "mirror.gcr.io/library/$img" "$img"
      return 0
    fi
    echo "mirror.gcr.io pull failed for $img (attempt $attempt) — falling back to docker.io"
    if docker pull "$img"; then return 0; fi
    sleep 8
  done
  echo "::error::could not pull $img from mirror.gcr.io or docker.io"
  return 1
}

echo "==> pulling images ($(echo $IMAGES | wc -w))"
for img in $IMAGES; do
  pull_one "$img" || { echo "::error::stage=pull image=$img"; exit 1; }
done

echo "==> docker save"
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  docker save -o "$WORK/${tag}.tar" "$img" || { echo "::error::stage=save image=$img"; exit 1; }
  printf '    %12s bytes  %s\n' "$(stat -c%s "$WORK/${tag}.tar")" "$img"
done

echo "==> loading into daemon + dive --json"
for img in $IMAGES; do docker load -i "$WORK/$(tag_of "$img").tar" >/dev/null || { echo "::error::stage=load image=$img"; exit 1; }; done
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  "$DIVE" --json "$OUT/out/${tag}.dive.json" "$img" || { echo "::error::stage=dive image=$img"; exit 1; }
done

echo "==> layerscope analyze"
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  node tools/analyze.mjs "$WORK/${tag}.tar" --json "$OUT/out/${tag}.layerscope.json" || { echo "::error::stage=analyze image=$img"; exit 1; }
done

echo "==> compare (tools/lib-compare.mjs; efficiencyScore rel tol 1e-9, everything else exact; all diffs are printed)"
failed=0
: > "$OUT/compare.log"
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  echo "" | tee -a "$OUT/compare.log"
  echo "==================== $img ====================" | tee -a "$OUT/compare.log"
  if node tools/compare.mjs "$OUT/out/${tag}.dive.json" "$OUT/out/${tag}.layerscope.json" 2>&1 | tee -a "$OUT/compare.log"; then
    echo "RESULT $img: match" | tee -a "$OUT/compare.log"
    echo "::notice::real-images RESULT $img: match"
  else
    echo "RESULT $img: MISMATCH (see diffs above)" | tee -a "$OUT/compare.log"
    echo "::error::stage=compare image=$img (mismatch vs dive — see job log for diffs)"
    failed=1
  fi
done
echo ""
if [ "$failed" -ne 0 ]; then
  echo "REAL IMAGES: differences found (see per-image output above)"
  exit 1
fi
echo "REAL IMAGES: all match dive"
