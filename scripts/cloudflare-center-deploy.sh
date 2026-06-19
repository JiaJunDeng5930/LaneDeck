#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/packages/center-worker"
EXPECTED_D1_DATABASE_ID="5d3e97c4-131f-4162-8c8c-b0d95366648b"
REQUIRED_ENV=(
  LANEDECK_CENTER_URL
  LANEDECK_AGENT_TOKEN
  LANEDECK_AI_MUTATION_TOKEN
  LANEDECK_READ_TOKEN
)

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return
  fi

  echo "missing command: $1" >&2
  exit 127
}

require_env() {
  local missing=()
  local name
  for name in "${REQUIRED_ENV[@]}"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
      continue
    fi
    if [[ "${!name}" == *$'\n'* || "${!name}" == *$'\r'* ]]; then
      echo "$name contains an unsupported newline character" >&2
      exit 64
    fi
  done

  if ((${#missing[@]} == 0)); then
    return
  fi

  printf 'missing required environment variables:' >&2
  printf ' %s' "${missing[@]}" >&2
  printf '\n' >&2
  exit 64
}

without_lanedeck_env() {
  env \
    -u LANEDECK_AGENT_TOKEN \
    -u LANEDECK_AI_MUTATION_TOKEN \
    -u LANEDECK_READ_TOKEN \
    "$@"
}

run_wrangler() {
  local output
  local status

  set +e
  output="$(without_lanedeck_env corepack pnpm exec wrangler "$@" 2>&1)"
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
require_env

CENTER_URL="${LANEDECK_CENTER_URL%/}"
CONTENT_BASE_URL="${LANEDECK_CONTENT_BASE_URL:-$CENTER_URL/content-by-workspace/}"
CONTENT_BASE_URL="${CONTENT_BASE_URL%/}/"

export VITE_LANEDECK_CENTER_URL="$CENTER_URL"
export VITE_LANEDECK_CONTENT_BASE_URL="$CONTENT_BASE_URL"
export VITE_LANEDECK_WORKSPACE_ID="${LANEDECK_WORKSPACE_ID:-workspace.local}"
unset VITE_LANEDECK_READ_TOKEN

corepack pnpm --filter @lanedeck/shell build

cd "$WORKER_DIR"

secret_file="$(mktemp)"
trap 'rm -f "$secret_file"' EXIT
chmod 600 "$secret_file"
without_lanedeck_env jq -Rn \
  'input as $agentToken
  | input as $aiMutationToken
  | input as $readToken
  | {
    LANEDECK_AGENT_TOKEN: $agentToken,
    LANEDECK_AI_MUTATION_TOKEN: $aiMutationToken,
    LANEDECK_READ_TOKEN: $readToken
  }' >"$secret_file" <<EOF
$LANEDECK_AGENT_TOKEN
$LANEDECK_AI_MUTATION_TOKEN
$LANEDECK_READ_TOKEN
EOF

without_lanedeck_env corepack pnpm exec wrangler --version
d1_json="$(without_lanedeck_env corepack pnpm exec wrangler d1 info lanedeck --json)"
d1_id="$(jq -er '.uuid // .id // .database_id' <<<"$d1_json")"
if [[ "$d1_id" != "$EXPECTED_D1_DATABASE_ID" ]]; then
  echo "D1 database id mismatch: expected $EXPECTED_D1_DATABASE_ID, got $d1_id" >&2
  exit 1
fi

r2_output="$(run_wrangler r2 bucket info lanedeck --json)" || {
  r2_kind="$(classify_r2_failure "$r2_output")"
  case "$r2_kind" in
    r2_not_enabled)
      echo "Cloudflare R2 is not enabled for this account." >&2
      echo "$r2_output" >&2
      exit 78
      ;;
    bucket_missing)
      without_lanedeck_env corepack pnpm exec wrangler r2 bucket create lanedeck
      ;;
    *)
      echo "R2 bucket check failed." >&2
      echo "$r2_output" >&2
      exit 1
      ;;
  esac
}

without_lanedeck_env corepack pnpm exec wrangler deploy --keep-vars --secrets-file "$secret_file" "$@"
