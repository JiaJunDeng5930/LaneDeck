# center-worker

Cloudflare Worker center service for LaneDeck ingest, query, AI mutation,
content artifacts, and live WebSocket updates.

## Cloudflare Resources

- Worker: `lanedeck-center`
- Durable Object: `WORKSPACE_COORDINATOR`
- D1 database: `lanedeck`
- R2 bucket: `lanedeck`
- Required secrets:
  - `LANEDECK_AGENT_TOKEN`
  - `LANEDECK_AI_MUTATION_TOKEN`
  - `LANEDECK_READ_TOKEN`
- Access application:
  - browser entry route: `/shell`
  - team domain: `https://atticusdeng.cloudflareaccess.com`
  - allowed email: `atticusdeng@gmail.com`

## Deploy

Cloudflare R2 must be enabled on the account before deployment because content
source and build artifacts are stored through the `LANEDECK_BUCKET` binding.

Use either a Wrangler login session or a `CLOUDFLARE_API_TOKEN` with Workers,
D1, R2, and Workers Scripts secret permissions.

```bash
export LANEDECK_AGENT_TOKEN=...
export LANEDECK_AI_MUTATION_TOKEN=...
export LANEDECK_READ_TOKEN=...

corepack pnpm run preflight:center
corepack pnpm run deploy:center
```

`preflight:center` is read-only. It verifies Wrangler authentication, D1 id,
R2 availability, the `lanedeck` bucket, and the Worker dry-run package.

`deploy:center` creates the `lanedeck` R2 bucket only when the bucket is
missing. An account-level R2 entitlement failure stops the deployment.

The root route redirects to `/shell`. Cloudflare Access protects `/shell`.
The Worker validates the `Cf-Access-Jwt-Assertion` header against the
configured team domain and application audience, then mints the
`LaneDeckReadSession` HttpOnly cookie for same-origin shell reads, content
assets, and browser live updates. Machine routes and verification scripts stay
outside the Access application and are authorized by their Bearer tokens in the
Worker.

After deploy, run the center verification:

```bash
export LANEDECK_CENTER_URL=https://lanedeck-center.<subdomain>.workers.dev
corepack pnpm run verify:center
```

`verify:center` is a write verification. It creates a `deploy-health-*`
workspace, writes content mutation rows to D1, writes build artifacts to R2, and
then reads the promoted content asset back through the Worker.

Full-system e2e remains separate. It also requires a running shell, local agent
fixture endpoints, and the e2e harness artifact writer.
