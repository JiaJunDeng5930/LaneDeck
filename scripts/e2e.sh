#!/usr/bin/env bash
set -euo pipefail

corepack pnpm --filter @lanedeck/protocol build
corepack pnpm exec tsc -p e2e/tsconfig.json --noEmit
node scripts/e2e-preflight.mjs "$@"
if [[ "${LANEDECK_E2E_FULL:-0}" == "1" ]]; then
  corepack pnpm exec playwright install chromium
fi
corepack pnpm exec playwright test -c e2e/playwright.config.ts "$@"
