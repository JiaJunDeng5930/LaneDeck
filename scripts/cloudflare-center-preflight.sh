#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/packages/center-worker"
source "$ROOT_DIR/scripts/cloudflare-center-lib.sh"

require_command corepack
require_command jq

bash "$ROOT_DIR/scripts/cloudflare-center-shell-build.sh"

cd "$WORKER_DIR"

run_wrangler --version
whoami_output="$(run_wrangler whoami)" || {
  echo "$whoami_output" >&2
  exit 1
}
if grep -Eiq 'not authenticated|not logged in|please run.*wrangler login' <<<"$whoami_output"; then
  echo "$whoami_output" >&2
  exit 1
fi

require_lanedeck_d1

r2_output="$(run_wrangler r2 bucket info "$R2_BUCKET_NAME" --json)" || {
  r2_kind="$(classify_r2_failure "$r2_output")"
  case "$r2_kind" in
    r2_not_enabled)
      echo "Cloudflare R2 is not enabled for this account." >&2
      echo "$r2_output" >&2
      exit 78
      ;;
    bucket_missing)
      echo "R2 bucket '$R2_BUCKET_NAME' is missing; deploy:center will create it." >&2
      ;;
    *)
      echo "R2 bucket preflight failed." >&2
      echo "$r2_output" >&2
      exit 1
      ;;
  esac
}

if without_lanedeck_env \
  LANEDECK_AGENT_TOKEN=preflight-agent-token \
  LANEDECK_AI_MUTATION_TOKEN=preflight-ai-mutation-token \
  LANEDECK_READ_TOKEN=preflight-read-token \
  corepack pnpm exec wrangler deploy --dry-run --strict --outdir .wrangler-preflight >/dev/null; then
  rm -rf .wrangler-preflight
else
  rm -rf .wrangler-preflight
  exit 1
fi

echo "Cloudflare center preflight passed for worker=$WORKER_NAME d1=$D1_DATABASE_NAME r2=$R2_BUCKET_NAME"
