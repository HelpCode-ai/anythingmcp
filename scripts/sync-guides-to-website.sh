#!/usr/bin/env bash
# sync-guides-to-website.sh
#
# Syncs adapter guide MDX files from the AnythingMCP repo to the website repo.
# This script is meant to be run as a prebuild step in the website project,
# or manually when adapter guides are updated.
#
# Usage:
#   From the website repo root:
#     ANYTHINGMCP_REPO=https://github.com/HelpCode-ai/anythingmcp.git ./scripts/sync-guides.sh
#
#   Or with a local path:
#     ANYTHINGMCP_PATH=/path/to/anythingmcp ./scripts/sync-guides.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSITE_CONTENT="${WEBSITE_CONTENT_DIR:-}"
ANYTHINGMCP_PATH="${ANYTHINGMCP_PATH:-}"
ANYTHINGMCP_REPO="${ANYTHINGMCP_REPO:-https://github.com/HelpCode-ai/anythingmcp.git}"
ANYTHINGMCP_BRANCH="${ANYTHINGMCP_BRANCH:-main}"

# If WEBSITE_CONTENT_DIR is not set, try to detect it
if [ -z "$WEBSITE_CONTENT" ]; then
  # If run from the website repo
  if [ -d "./content/en/guides" ]; then
    WEBSITE_CONTENT="./content"
  else
    echo "Error: Could not detect website content directory. Set WEBSITE_CONTENT_DIR." >&2
    exit 1
  fi
fi

# Source: either local path or cloned repo
if [ -n "$ANYTHINGMCP_PATH" ]; then
  SOURCE_GUIDES="$ANYTHINGMCP_PATH/content/guides"
else
  # Clone to temp dir
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT
  echo "Cloning AnythingMCP repo (sparse checkout)..."
  git clone --depth 1 --filter=blob:none --sparse "$ANYTHINGMCP_REPO" -b "$ANYTHINGMCP_BRANCH" "$TMPDIR/repo" 2>/dev/null
  cd "$TMPDIR/repo"
  git sparse-checkout set content/guides 2>/dev/null
  cd - > /dev/null
  SOURCE_GUIDES="$TMPDIR/repo/content/guides"
fi

if [ ! -d "$SOURCE_GUIDES" ]; then
  echo "Error: Source guides directory not found at $SOURCE_GUIDES" >&2
  exit 1
fi

# Sync guides for each locale
SYNCED=0
for locale_dir in "$SOURCE_GUIDES"/*/; do
  locale=$(basename "$locale_dir")
  target_dir="$WEBSITE_CONTENT/$locale/guides"

  if [ ! -d "$target_dir" ]; then
    echo "Skipping locale '$locale' — no matching content directory in website"
    continue
  fi

  for guide in "$locale_dir"*.mdx; do
    [ -f "$guide" ] || continue
    filename=$(basename "$guide")
    cp "$guide" "$target_dir/$filename"
    SYNCED=$((SYNCED + 1))
  done
done

echo "Synced $SYNCED guide files from AnythingMCP to website."
