# Shell Package Notes

`packages/shell` owns the stable desktop shell. Content remains mutable data loaded into an iframe through `lanedeck://content/...`.

## Module Boundaries

- `app.ts`: shell state machine and public `createShellApp` controller.
- `center.ts`: center HTTP query/mutation clients and browser WSS live client.
- `content.ts`: iframe host/session loading, reload count, shell-to-content messages.
- `picker.ts`: picker mode state and clipboard writes.
- `ui/`: React desktop shell wiring around the controller.

`createShellApp` depends on injected center, live, content loader, and clipboard adapters. Tests should use fakes for those adapters.

## Contracts

- `start()` attempts the live connection and always performs the first content load attempt.
- `content_changed` live events enqueue a content reload.
- Picker mode forwards `{ type: "picker_mode" }` to the active content session.
- `pick_result` copies the pick id, clears picker mode, and returns to content-ready state.
- Invalid shell-content messages are parsed through `@lanedeck/protocol` and recorded as protocol diagnostics.
