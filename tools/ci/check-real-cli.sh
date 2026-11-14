#!/usr/bin/env bash
# Pull the six public images already used by the real-images job
# (tools/check-real-images.sh), docker save them, and check that the
# `layerscope` CLI's --json report deep-equals the in-process analysis engine
# (the same analyzeImage() the web UI runs) over the same archive.
#
#   tools/ci/check-real-cli.sh
# Optional:
#   IMAGES="alpine busybox"   override the image list (space separated)
#   OUT_DIR=/tmp/...          override the output directory
#
# Exit 1 if any image mismatches; 0 when all match.
set -uo pipefail
cd "$(dirname "$0")/../.."

IMAGES="${IMAGES:-alpine busybox nginx:alpine python:3.12-slim node:20-alpine ubuntu:24.04}"
OUT="${OUT_DIR:-/tmp/layerscope-real-cli}"
WORK="$OUT/work"
mkdir -p "$WORK" "$OUT/out"

tag_of() { echo "$1" | tr '/:' '__'; }

# Same registry strategy as tools/check-real-images.sh: Docker Hub anonymous
# pulls from shared CI runners are often rate-limited; mirror.gcr.io serves the
# same official-image namespace, so we try it first and fall back to
# docker.io, with one retry per registry. Images are always tagged back to
# their canonical name before saving.
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

echo "==> compare the CLI report against the in-process engine (tools/ci/compare-cli-web.mjs)"
failed=0
for img in $IMAGES; do
  tag="$(tag_of "$img")"
  echo ""
  echo "==================== $img ===================="
  if ! node tools/ci/compare-cli-web.mjs "$WORK/${tag}.tar" "$img" | tee "$OUT/out/${tag}.cli-vs-web.txt"; then
    failed=1
  fi
done

echo ""
if [ "$failed" -ne 0 ]; then
  echo "CLI vs engine: MISMATCH on at least one image (see above)"
  exit 1
fi
echo "CLI vs engine: all six images match"
