#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/cloudflare-center-lib.sh"

RESPONSE_STATUS=""
RESPONSE_BODY=""

curl_request() {
  local method="$1"
  local url="$2"
  local token="${3:-}"
  local body="${4:-}"
  local config
  local header_file
  local body_file=""
  local output
  local status
  local curl_status

  config="$(mktemp)"
  header_file="$(mktemp)"
  output="$(mktemp)"
  chmod 600 "$config" "$header_file" "$output"

  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'request = "%s"\n' "$method"
    printf 'url = "%s"\n' "$url"
    printf 'output = "%s"\n' "$output"
    printf 'write-out = "%%{http_code}"\n'
  } >"$config"

  if [[ -n "$token" ]]; then
    printf 'authorization: Bearer %s\n' "$token" >>"$header_file"
  fi
  if [[ -n "$body" ]]; then
    body_file="$(mktemp)"
    chmod 600 "$body_file"
    printf '%s' "$body" >"$body_file"
    printf 'content-type: application/json\n' >>"$header_file"
    printf 'data = "@%s"\n' "$body_file" >>"$config"
  fi
  if [[ -s "$header_file" ]]; then
    printf 'header = "@%s"\n' "$header_file" >>"$config"
  fi

  set +e
  status="$(
    without_lanedeck_env curl --config "$config"
  )"
  curl_status=$?
  set -e

  RESPONSE_STATUS="$status"
  RESPONSE_BODY="$(cat "$output")"
  if [[ "$curl_status" -ne 0 ]]; then
    RESPONSE_STATUS="curl-$curl_status"
  fi
  rm -f "$config" "$header_file" "$body_file" "$output"
}

expect_status() {
  local expected="$1"
  local label="$2"
  if [[ "$RESPONSE_STATUS" == "$expected" ]]; then
    return
  fi

  echo "$label returned HTTP $RESPONSE_STATUS, expected $expected" >&2
  echo "$RESPONSE_BODY" >&2
  exit 1
}

require_command curl
require_command jq
require_command base64
require_env_names "${LANEDECK_DEPLOY_ENV[@]}"

CENTER_URL="${LANEDECK_CENTER_URL%/}"
WORKSPACE_ID="${LANEDECK_VERIFY_WORKSPACE_ID:-deploy-health-$(date +%s)}"
MACHINE_ID="deploy-health-machine"
CONTENT_ID="deploy-health-content"
ENTRYPOINT="index.html"
SOURCE='<main data-pick-id="deploy-health">LaneDeck deploy health</main>'
HTML='<!doctype html><main data-pick-id="deploy-health">LaneDeck deploy health</main>'
ARTIFACT_BODY_BASE64="$(printf '%s' "$HTML" | base64 | tr -d '\n')"

query_body="$(
  jq -nc --arg workspaceId "$WORKSPACE_ID" \
    '{workspaceId: $workspaceId, query: "current_state", params: {}}'
)"

curl_request GET "$CENTER_URL/"
expect_status 200 "root page"

curl_request POST "$CENTER_URL/api/query" "" "$query_body"
expect_status 401 "unauthorized query"

curl_request POST "$CENTER_URL/api/query" "$LANEDECK_READ_TOKEN" "$query_body"
expect_status 200 "authorized query"

patch_body="$(
  jq -nc \
    --arg workspaceId "$WORKSPACE_ID" \
    --arg source "$SOURCE" \
    '{
      workspaceId: $workspaceId,
      mutation: "patch_content",
      payload: {
        path: "src/App.tsx",
        contentPath: "index.html",
        source: $source,
        metadata: {scenario: "deploy-health"}
      }
    }'
)"
curl_request POST "$CENTER_URL/api/ai/mutation" "$LANEDECK_AI_MUTATION_TOKEN" "$patch_body"
expect_status 200 "patch content mutation"
content_revision="$(jq -er '.contentRevision' <<<"$RESPONSE_BODY")"

build_request_body="$(
  jq -nc \
    --arg workspaceId "$WORKSPACE_ID" \
    --arg machineId "$MACHINE_ID" \
    --arg contentId "$CONTENT_ID" \
    --arg contentRevision "$content_revision" \
    '{
      workspaceId: $workspaceId,
      mutation: "request_local_build",
      payload: {
        machineId: $machineId,
        contentId: $contentId,
        contentRevision: $contentRevision,
        cwd: ".",
        command: "true"
      }
    }'
)"
curl_request POST "$CENTER_URL/api/ai/mutation" "$LANEDECK_AI_MUTATION_TOKEN" "$build_request_body"
expect_status 200 "local build request mutation"
build_request_id="$(jq -er '.buildRequestId' <<<"$RESPONSE_BODY")"

build_complete_body="$(
  jq -nc \
    --arg workspaceId "$WORKSPACE_ID" \
    --arg machineId "$MACHINE_ID" \
    --arg buildRequestId "$build_request_id" \
    --arg contentId "$CONTENT_ID" \
    --arg contentRevision "$content_revision" \
    --arg entrypoint "$ENTRYPOINT" \
    --arg bodyBase64 "$ARTIFACT_BODY_BASE64" \
    '{
      workspaceId: $workspaceId,
      machineId: $machineId,
      buildRequestId: $buildRequestId,
      contentId: $contentId,
      contentRevision: $contentRevision,
      entrypoint: $entrypoint,
      artifacts: [
        {
          path: $entrypoint,
          bodyBase64: $bodyBase64,
          contentType: "text/html; charset=utf-8"
        }
      ]
    }'
)"
curl_request POST "$CENTER_URL/api/content/build-complete" "$LANEDECK_AGENT_TOKEN" "$build_complete_body"
expect_status 200 "content build completion"

current_content_url="$CENTER_URL/api/content/current?workspaceId=$WORKSPACE_ID"
curl_request GET "$current_content_url" "$LANEDECK_READ_TOKEN"
expect_status 200 "current content query"
jq -e --arg revision "$content_revision" \
  '.rows[0].revision == $revision and .rows[0].assetKey != null' \
  <<<"$RESPONSE_BODY" >/dev/null

asset_url="$CENTER_URL/content/$content_revision/index.html"
curl_request GET "$asset_url"
expect_status 200 "content asset"
if [[ "$RESPONSE_BODY" != *"LaneDeck deploy health"* ]]; then
  echo "content asset did not contain deploy health marker" >&2
  exit 1
fi

printf 'verified center worker %s workspace=%s revision=%s\n' \
  "$CENTER_URL" "$WORKSPACE_ID" "$content_revision"
