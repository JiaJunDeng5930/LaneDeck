#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/packages/center-worker"

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return
  fi

  echo "missing command: $1" >&2
  exit 127
}

require_command corepack

bash -n \
  "$ROOT_DIR/scripts/cloudflare-center-ci.sh" \
  "$ROOT_DIR/scripts/cloudflare-center-deploy.sh" \
  "$ROOT_DIR/scripts/cloudflare-center-preflight.sh" \
  "$ROOT_DIR/scripts/cloudflare-center-verify.sh" \
  "$ROOT_DIR/scripts/e2e.sh"

cd "$WORKER_DIR"

export LANEDECK_AGENT_TOKEN="${LANEDECK_AGENT_TOKEN:-ci-agent-token}"
export LANEDECK_AI_MUTATION_TOKEN="${LANEDECK_AI_MUTATION_TOKEN:-ci-ai-mutation-token}"
export LANEDECK_READ_TOKEN="${LANEDECK_READ_TOKEN:-ci-read-token}"

cleanup() {
  rm -rf "$WORKER_DIR/.wrangler-dry-run"
}
trap cleanup EXIT

corepack pnpm exec wrangler types worker-configuration.d.ts \
  --include-runtime false \
  --check
corepack pnpm exec wrangler deploy \
  --dry-run \
  --strict \
  --outdir .wrangler-dry-run
