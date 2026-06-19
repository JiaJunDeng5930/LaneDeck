#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

unset VITE_LANEDECK_READ_TOKEN
export VITE_LANEDECK_WORKSPACE_ID="${LANEDECK_WORKSPACE_ID:-${VITE_LANEDECK_WORKSPACE_ID:-workspace.local}}"

if [[ -n "${LANEDECK_CENTER_URL:-}" ]]; then
  CENTER_URL="${LANEDECK_CENTER_URL%/}"
  CONTENT_BASE_URL="${LANEDECK_CONTENT_BASE_URL:-$CENTER_URL/content-by-workspace/}"
  CONTENT_BASE_URL="${CONTENT_BASE_URL%/}/"

  export VITE_LANEDECK_CENTER_URL="$CENTER_URL"
  export VITE_LANEDECK_CONTENT_BASE_URL="$CONTENT_BASE_URL"
fi

cd "$ROOT_DIR"
corepack pnpm --filter @lanedeck/shell build
