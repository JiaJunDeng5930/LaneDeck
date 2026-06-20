#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/packages/center-worker"
source "$ROOT_DIR/scripts/cloudflare-center-lib.sh"

require_command corepack
require_command jq
require_env_names "${LANEDECK_DEPLOY_ENV[@]}"

bash "$ROOT_DIR/scripts/cloudflare-center-shell-build.sh"

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
      without_lanedeck_env corepack pnpm exec wrangler r2 bucket create "$R2_BUCKET_NAME"
      ;;
    *)
      echo "R2 bucket check failed." >&2
      echo "$r2_output" >&2
      exit 1
      ;;
  esac
}

without_lanedeck_env corepack pnpm exec wrangler deploy --keep-vars --secrets-file "$secret_file" "$@"
