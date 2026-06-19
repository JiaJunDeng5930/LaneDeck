# E2E Tests

E2E tests compose the local agent, Cloudflare center Worker, shell, and content through their public protocols.

## Harness Boundary

The default e2e run validates the test harness and reports skipped full-system scenarios. Full runs require an externally started LaneDeck system and these environment values:

- `LANEDECK_E2E_FULL=1`
- `LANEDECK_AGENT_SOURCE_INPUT_URL`
- `LANEDECK_CENTER_HTTP_URL`
- `LANEDECK_SHELL_HTTP_URL`
- `LANEDECK_LIVE_WS_URL`
- `LANEDECK_AGENT_SPOOL_OBSERVATION_URL`
- `LANEDECK_READ_TOKEN`
- `LANEDECK_AI_MUTATION_TOKEN`
- `LANEDECK_AGENT_TOKEN`

`LANEDECK_E2E_FIXTURE` may point to a JSON file with the same camelCase fields used by `support/harness.ts`. Environment values override fixture file values.

The scenarios use `LANEDECK_READ_TOKEN` for center query reads, `LANEDECK_AI_MUTATION_TOKEN` for AI mutation requests, and `LANEDECK_AGENT_TOKEN` for content build-complete callbacks.

## Scenario Files

- `specs/agent-to-center-flow.spec.ts` covers count-triggered ingest, live update, shell/content visibility, spool ack observation, and time-triggered quiet-signal ingest.
- `specs/content-mutation-flow.spec.ts` covers picker-id based content mutation, content revision observation, shell iframe reload, and patched content visibility.

The tests use `@lanedeck/protocol` validators for fixture construction. Scenario requests target public HTTP, WSS, shell, and iframe surfaces.

The agent source input fixture drives the agent-runtime in-memory source boundary. It accepts the source envelope from `support/contract-fixtures.ts` and returns the uploaded `batchId`. The spool observation fixture is read-only and accepts `batchId` as a query parameter.
