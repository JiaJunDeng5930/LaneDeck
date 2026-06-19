#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/packages/center-worker"
EXPECTED_D1_DATABASE_ID="5d3e97c4-131f-4162-8c8c-b0d95366648b"
R2_BUCKET_NAME="lanedeck"
D1_DATABASE_NAME="lanedeck"
WORKER_NAME="lanedeck-center"

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return
  fi

  echo "missing command: $1" >&2
  exit 127
}

run_wrangler() {
  local output
  local status

  set +e
  output="$(
    env \
      -u LANEDECK_AGENT_TOKEN \
      -u LANEDECK_AI_MUTATION_TOKEN \
      -u LANEDECK_READ_TOKEN \
      corepack pnpm exec wrangler "$@" 2>&1
  )"
  status=$?
  set -e

  printf '%s' "$output"
  return "$status"
}

classify_r2_failure() {
  local output="$1"

  if grep -Eiq '10042|Please enable R2|NotEntitled|not entitled' <<<"$output"; then
    echo "r2_not_enabled"
    return
  fi

  if grep -Eiq 'not found|does not exist|could not find|no such bucket|missing bucket' <<<"$output"; then
    echo "bucket_missing"
    return
  fi

  echo "unknown"
}

require_command corepack
require_command jq

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

d1_json="$(run_wrangler d1 info "$D1_DATABASE_NAME" --json)"
d1_id="$(jq -er '.uuid // .id // .database_id' <<<"$d1_json")"
if [[ "$d1_id" != "$EXPECTED_D1_DATABASE_ID" ]]; then
  echo "D1 database id mismatch: expected $EXPECTED_D1_DATABASE_ID, got $d1_id" >&2
  exit 1
fi

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

if env \
  -u LANEDECK_AGENT_TOKEN \
  -u LANEDECK_AI_MUTATION_TOKEN \
  -u LANEDECK_READ_TOKEN \
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
