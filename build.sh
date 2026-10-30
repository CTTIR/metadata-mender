#!/usr/bin/env bash
# Build the current plugin without deleting earlier artifacts.
set -euo pipefail
cd "$(dirname "$0")"
python3 tools/build.py "$@"
