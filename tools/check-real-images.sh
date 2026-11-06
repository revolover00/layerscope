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

echo "==> pulling images ($(echo $IMAGES | wc -w))"
for img in $IMAGES; do
  docker pull "$img" || { echo "pull failed: $img"; exit 1; }
done

echo "==> docker save"
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  docker save -o "$WORK/${tag}.tar" "$img" || exit 1
  printf '    %12s bytes  %s\n' "$(stat -c%s "$WORK/${tag}.tar")" "$img"
done

echo "==> loading into daemon + dive --json"
for img in $IMAGES; do docker load -i "$WORK/$(tag_of "$img").tar" >/dev/null || exit 1; done
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  "$DIVE" --json "$OUT/out/${tag}.dive.json" "$img" || { echo "dive failed on $img"; exit 1; }
done

echo "==> layerscope analyze"
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  node tools/analyze.mjs "$WORK/${tag}.tar" --json "$OUT/out/${tag}.layerscope.json" || exit 1
done

echo "==> compare (tools/lib-compare.mjs; efficiencyScore rel tol 1e-9, everything else exact; all diffs are printed)"
failed=0
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  echo ""
  echo "==================== $img ===================="
  if node tools/compare.mjs "$OUT/out/${tag}.dive.json" "$OUT/out/${tag}.layerscope.json"; then
    echo "RESULT $img: match"
  else
    echo "RESULT $img: MISMATCH (see diffs above)"
    failed=1
  fi
done
echo ""
if [ "$failed" -ne 0 ]; then
  echo "REAL IMAGES: differences found (see per-image output above)"
  exit 1
fi
echo "REAL IMAGES: all match dive"
