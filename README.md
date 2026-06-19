# LaneDeck

Personal observability deck for local agents, lane pipelines, and AI-editable dashboards.

LaneDeck is a monorepo with a Rust local agent, a Cloudflare center service, a Tauri shell, and editable React content.

## Workspace

- `packages/protocol`
- `packages/lane-engine`
- `packages/agent-runtime`
- `packages/center-worker`
- `packages/shell`
- `packages/content`

Use `corepack pnpm` for TypeScript workspace commands and `cargo` for Rust workspace commands.

## Cloudflare Center

The center Worker is deployed with:

```bash
export LANEDECK_AGENT_TOKEN=...
export LANEDECK_AI_MUTATION_TOKEN=...
export LANEDECK_READ_TOKEN=...

corepack pnpm run preflight:center
corepack pnpm run deploy:center
export LANEDECK_CENTER_URL=https://lanedeck-center.<subdomain>.workers.dev
corepack pnpm run verify:center
```

Cloudflare R2 must be enabled on the account before deploy. The verification
script writes a `deploy-health-*` workspace to D1 and R2, then reads it back
through the deployed Worker.
