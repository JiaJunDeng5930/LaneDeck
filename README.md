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
export LANEDECK_CENTER_URL=https://lanedeck-center.<subdomain>.workers.dev

corepack pnpm run preflight:center
corepack pnpm run deploy:center
corepack pnpm run verify:center
```

Cloudflare R2 must be enabled on the account before deploy. The verification
script writes a `deploy-health-*` workspace to D1 and R2, then reads it back
through the deployed Worker.

The browser shell is served by the center Worker through Workers Static Assets.
Open `https://lanedeck-center.<subdomain>.workers.dev/`; the root route
redirects to the Cloudflare Access-protected `/shell` route. The Worker
validates the Access JWT and establishes the HttpOnly read session cookie.
Browser JavaScript does not carry the read token.
The deployed shell loads iframe content through the Worker route
`/content-by-workspace/{workspaceId}/{revision}/{assetPath}`.
