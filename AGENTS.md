# LaneDeck Working Notes

LaneDeck is a personal observability deck built around lane pipelines, local agents, a Cloudflare center, and AI-editable dashboard content.

## Design Source

- The exported discussion is `/mnt/e/Downloads/ChatGPT-个人运维面板需求.md`.
- Local detailed design lives under `design/`. That directory is excluded through `.git/info/exclude`.
- Tracked files should keep only durable engineering context that future work needs immediately.

## Package Topology

1. `packages/protocol`: JSON protocol, current schema validation, TS types, Rust DTOs.
2. `packages/lane-engine`: Rust lane pipeline engine for `raw collection -> metric/process -> event`.
3. `packages/agent-runtime`: Rust local agent runtime, source runners, local spool, HTTP ingest, WSS control.
4. `packages/center-worker`: Cloudflare Worker, Durable Object, D1, R2, query API, ingest API, AI mutation API.
5. `packages/shell`: Tauri v2 + React shell, iframe host, picker, WSS live updates.
6. `packages/content`: React content bundle loaded by the shell through `lanedeck://content/...`.

Dependency direction:

`protocol -> lane-engine -> agent-runtime`

`protocol -> center-worker`

`protocol -> shell`

`protocol -> content`

E2E tests compose the packages at runtime and introduce no package dependency.

## Current Product Boundaries

- A lane always has three execution stages: raw collection, metric/process, event.
- Frame metadata records close trigger: `count` or `time`. A time-triggered empty frame carries quiet-signal checks through the same pipeline.
- Metric/process and event stages receive current frame, configured history, and lane settings.
- Schema validation uses the current schema. Schema versioning belongs to a future formal release stage.
- Runner limits are side-effect boundaries for user scripts.
- Picker identifiers map UI elements to content source locations.
- HTTP query APIs read data. AI mutation APIs write content, lane settings, and mutable data files.
- Cloudflare core state uses Workers, Durable Objects, D1, and R2.

## Review And Contract Rules

- Cross-cutting contracts live in `design/02-cross-cutting-contracts.md`.
- Treat every review finding as a problem-surface signal. Before rerunning review, sweep the related contract, design, test, and implementation surface and commit the full surface fix.
- If one branch exceeds three review rounds, classify review findings against cross-cutting contracts before further implementation.
- Missing or ambiguous contracts are fixed in design first, then in tests and implementation.
- Package tests and package implementation are separate tasks and should be delegated to different subagents.

## Commands

- Use `corepack pnpm` for workspace commands on this machine.
- Use `cargo` for Rust workspace commands.
- Use local package scripts once package implementations exist.
