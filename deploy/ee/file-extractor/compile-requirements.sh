#!/bin/sh
# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
#
# Re-compiles the pinned, hash-checked lock files from the *.in files.
# Only versions published before CUTOFF are considered (supply-chain
# cool-down); move CUTOFF forward deliberately when upgrading.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
UV="${UV:-uv}"
CUTOFF="${CUTOFF:-2026-11-04T23:59:59Z}"
HEADER="# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE."
COMMON="--universal --python-version 3.12 --exclude-newer $CUTOFF --generate-hashes --quiet"

compile() {
  out="$1"; shift
  # shellcheck disable=SC2086
  "$UV" pip compile $COMMON "$@" -o "$out"
  { echo "$HEADER"; cat "$out"; } > "$out.tmp" && mv "$out.tmp" "$out"
}

compile requirements.txt requirements.in
compile requirements-ocr.txt requirements.in requirements-ocr.in --override ocr-overrides.txt -c requirements.txt
compile requirements-dev.txt requirements-dev.in -c requirements.txt
echo "lock files updated (cutoff $CUTOFF)"
