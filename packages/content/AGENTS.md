# Content Package Notes

`packages/content` owns the iframe dashboard content loaded by the shell.

## Public Surface

- `createContentApp(deps)` creates the controller used by browser boot and tests.
- `ContentApp.init()` waits for shell init, sends `ready`, and renders an initial route when supplied.
- `ContentApp.render(route)` builds a center query request, renders dashboard markup, and reports failures through `error_report`.
- `registerPickTarget(target)` attaches pointer/click listeners and emits source-level pick ids to active content apps while picker mode is enabled.
- `createHttpCenterQueryClient(options)` posts protocol `QueryRequest` payloads to `/api/query` and validates the current `QueryResponse` shape.

## Runtime Model

The app has three local collaborators: `query` for center reads, `shell` for iframe messages, and the document `#root` for rendered markup. Dashboard rows prefer `eventText`, then `text`, then `message`; pick ids prefer `pickId`, then `sourceId`, then a deterministic row id.
