# center-worker Notes

`src/index.ts` is the Cloudflare adapter. It owns the `DurableObject` subclass,
WebSocket upgrades, and generated `Env` binding shape.

`src/workspace.ts` is the package coordination core. It receives parsed protocol
DTOs, persists before broadcasting, and keeps query/mutation names local to the
center package.

`src/router.ts` owns HTTP route matching and protocol validation. POST bodies are
validated through `@lanedeck/protocol`; route errors return JSON diagnostics.

`src/storage/d1.ts` owns structured D1 tables. `src/storage/r2.ts` owns content
object keys and path validation. `src/live.ts` owns agent/browser socket fanout.
