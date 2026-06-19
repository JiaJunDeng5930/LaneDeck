# E2E Tests

E2E tests compose the local agent, Cloudflare center Worker, shell, and content through their public protocols.

## Harness Boundary

The default e2e run validates the test harness and reports skipped full-system scenarios. Full runs require an externally started LaneDeck system and these environment values:

- `LANEDECK_E2E_FULL=1`
- `LANEDECK_WORKSPACE_ID`
- `LANEDECK_AGENT_SOURCE_INPUT_URL`
- `LANEDECK_CENTER_HTTP_URL`
- `LANEDECK_SHELL_HTTP_URL`
- `LANEDECK_SHELL_CONTENT_BASE_URL`
- `LANEDECK_SHELL_CONTENT_ARTIFACT_WRITE_URL`
- `LANEDECK_LIVE_WS_URL`
- `LANEDECK_AGENT_SPOOL_OBSERVATION_URL`
- `LANEDECK_READ_TOKEN`
- `LANEDECK_AI_MUTATION_TOKEN`
- `LANEDECK_AGENT_TOKEN`

`LANEDECK_E2E_FIXTURE` may point to a JSON file with the same camelCase fields used by `support/harness.ts`. Environment values override fixture file values.

The scenarios use `LANEDECK_WORKSPACE_ID` for every ingest, query, live, mutation, and build-complete payload. Start the shell with the same value as `VITE_LANEDECK_WORKSPACE_ID`.

The scenarios use `LANEDECK_READ_TOKEN` for center query reads, `LANEDECK_AI_MUTATION_TOKEN` for AI mutation requests, and `LANEDECK_AGENT_TOKEN` for content build-complete callbacks.

`LANEDECK_SHELL_CONTENT_BASE_URL` is the HTTP base used by the browser shell for content artifacts. Start the shell with the same value as `VITE_LANEDECK_CONTENT_BASE_URL`. It must be an HTTP(S) URL on `lanedeck.localhost`; the shell trusts that host for center read access in browser e2e.

`LANEDECK_SHELL_CONTENT_ARTIFACT_WRITE_URL` is a harness-only endpoint. It accepts the content build-complete payload shape, or at minimum `{ workspaceId, contentRevision, entrypoint, artifacts }`, and writes artifacts into the HTTP content root served at `LANEDECK_SHELL_CONTENT_BASE_URL/{workspaceId}/{contentRevision}/{entrypoint}` before center promotion broadcasts a reload.

## Scenario Files

- `specs/agent-to-center-flow.spec.ts` covers count-triggered ingest, live update, shell/content visibility, spool ack observation, and time-triggered quiet-signal ingest. It seeds dashboard-capable current content before opening the shell, so a fresh center has the current-content pointer required by shell rendering.
- `specs/content-mutation-flow.spec.ts` covers picker-id based content mutation, content revision observation, shell iframe reload, and patched content visibility.

The tests use `@lanedeck/protocol` validators for fixture construction. Scenario requests target public HTTP, WSS, shell, and iframe surfaces.

The agent source input fixture drives the agent-runtime in-memory source boundary. It accepts the source envelope from `support/contract-fixtures.ts` and returns the uploaded `batchId`. The spool observation fixture is read-only and accepts `batchId` as a query parameter.
