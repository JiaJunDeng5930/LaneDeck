#!/usr/bin/env bash

EXPECTED_D1_DATABASE_ID="5d3e97c4-131f-4162-8c8c-b0d95366648b"
R2_BUCKET_NAME="lanedeck"
D1_DATABASE_NAME="lanedeck"
WORKER_NAME="lanedeck-center"
LANEDECK_SECRET_ENV=(
  LANEDECK_AGENT_TOKEN
  LANEDECK_AI_MUTATION_TOKEN
  LANEDECK_READ_TOKEN
)
LANEDECK_DEPLOY_ENV=(
  LANEDECK_CENTER_URL
  "${LANEDECK_SECRET_ENV[@]}"
)

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return
  fi

  echo "missing command: $1" >&2
  exit 127
}

require_env_names() {
  local missing=()
  local name
  for name in "$@"; do
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

require_lanedeck_d1() {
  local d1_json
  local d1_id

  d1_json="$(run_wrangler d1 info "$D1_DATABASE_NAME" --json)"
  d1_id="$(jq -er '.uuid // .id // .database_id' <<<"$d1_json")"
  if [[ "$d1_id" != "$EXPECTED_D1_DATABASE_ID" ]]; then
    echo "D1 database id mismatch: expected $EXPECTED_D1_DATABASE_ID, got $d1_id" >&2
    exit 1
  fi
}
