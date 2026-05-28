#!/usr/bin/env bash
# Build Metadata Mender into an installable .xpi.
# Usage: ./build.sh
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="metadata-mender-${VERSION}.xpi"

# Drop stale builds (prior versions and the current one) before rebuilding.
rm -f metadata-mender-*.xpi

# An .xpi is just a zip with manifest.json at the root.
zip -r -FS "$OUT" \
  manifest.json \
  bootstrap.js \
  content \
  locale \
  -x "*.DS_Store" "*/.*" >/dev/null

echo "Built $OUT"
unzip -l "$OUT"
