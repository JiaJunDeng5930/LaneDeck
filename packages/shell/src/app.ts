import {
  ProtocolError,
  parseShellContentMessage,
  type Diagnostic,
} from "@lanedeck/protocol";

import type {
  BrowserLiveClient,
  BrowserLiveEvent,
  BrowserLiveConnection,
  CenterQueryClient,
} from "./center";
import {
  contentLoadFailure,
  type ContentLoader,
  type ContentSession,
  type LoadedContentSession,
} from "./content";
import {
  PickerController,
  type ClipboardWriter,
  type PickCopyResult,
} from "./picker";

export interface ShellDeps {
  center: CenterQueryClient;
  live: BrowserLiveClient;
  contentLoader: ContentLoader;
  clipboard: ClipboardWriter;
  now?: () => string;
}

export interface ShellApp {
  start(): Promise<void>;
  loadCurrentContent(): Promise<ContentSession>;
  setPickerMode(enabled: boolean): void;
  handleContentMessage(message: unknown): Promise<void>;
  stop(): Promise<void>;
}

type ShellState =
  | "Created"
  | "ConnectingLive"
  | "LoadingContent"
  | "ContentReady"
  | "ContentError"
  | "PickerArmed"
  | "PickCopied"
  | "Stopped";

export function createShellApp(deps: ShellDeps): ShellApp {
  const picker = new PickerController(deps.clipboard);
  const now = deps.now ?? (() => new Date().toISOString());
  let state: ShellState = "Created";
  let liveConnection: BrowserLiveConnection | undefined;
  let activeSession: LoadedContentSession | undefined;
  let loadTail: Promise<void> = Promise.resolve();

  function enqueueContentLoad(): Promise<ContentSession> {
    const load = loadTail.then(performContentLoad, performContentLoad);
    loadTail = load.then(
      () => undefined,
      () => undefined,
    );
    return load;
  }

  async function performContentLoad(): Promise<ContentSession> {
    if (state === "Stopped") {
      return contentLoadFailure(new Error("shell is stopped"));
    }

    state = "LoadingContent";
    try {
      const descriptor = await deps.center.getCurrentContent();
      const session = await deps.contentLoader.loadCurrent(descriptor);
      if (session.status === "ready") {
        activeSession = session;
        state = picker.isEnabled() ? "PickerArmed" : "ContentReady";
        if (picker.isEnabled()) {
          deps.contentLoader.setPickerMode(true);
        }
        return session;
      }
      activeSession = undefined;
      state = "ContentError";
      await recordDiagnostics("content", session.diagnostics);
      return session;
    } catch (error) {
      activeSession = undefined;
      state = "ContentError";
      const failure = contentLoadFailure(error);
      await recordDiagnostics("content", failure.diagnostics);
      return failure;
    }
  }

  async function handleLiveEvent(event: BrowserLiveEvent): Promise<void> {
    if (state === "Stopped") {
      return;
    }
    if (event.type === "content_changed") {
      await enqueueContentLoad();
    }
  }

  async function recordDiagnostics(
    source: "shell-content" | "live" | "content",
    diagnostics: Diagnostic[],
  ): Promise<void> {
    await deps.center.recordProtocolDiagnostic({
      source,
      diagnostics,
      receivedAt: now(),
    });
  }

  async function safelyRecordDiagnostics(
    source: "shell-content" | "live" | "content",
    diagnostics: Diagnostic[],
  ): Promise<void> {
    try {
      await recordDiagnostics(source, diagnostics);
    } catch {
      // Diagnostic transport failures cannot block the shell state machine.
    }
  }

  return {
    async start(): Promise<void> {
      if (state !== "Created") {
        return;
      }
      state = "ConnectingLive";
      try {
        liveConnection = await deps.live.connect({
          onEvent(event: BrowserLiveEvent) {
            void handleLiveEvent(event);
          },
          onDiagnostic(diagnostics: Diagnostic[]) {
            void safelyRecordDiagnostics("live", diagnostics);
          },
          onError(error: unknown) {
            void safelyRecordDiagnostics("live", [
              { path: "$", message: errorMessage(error) },
            ]);
          },
        });
      } catch (error) {
        await safelyRecordDiagnostics("live", [
          { path: "$", message: errorMessage(error) },
        ]);
      }
      await enqueueContentLoad();
    },

    loadCurrentContent(): Promise<ContentSession> {
      return enqueueContentLoad();
    },

    setPickerMode(enabled: boolean): void {
      if (state === "Stopped") {
        return;
      }
      picker.setEnabled(enabled);
      deps.contentLoader.setPickerMode(enabled);
      if (enabled && state === "ContentReady") {
        state = "PickerArmed";
      }
      if (!enabled && state === "PickerArmed") {
        state = "ContentReady";
      }
    },

    async handleContentMessage(message: unknown): Promise<void> {
      if (state === "Stopped") {
        return;
      }

      try {
        const parsed = parseShellContentMessage(message);
        switch (parsed.type) {
          case "ready":
            if (activeSession !== undefined) {
              state = picker.isEnabled() ? "PickerArmed" : "ContentReady";
            }
            return;
          case "height_changed":
            deps.contentLoader.setHeight(parsed.payload.height);
            state = activeSession === undefined ? state : "ContentReady";
            return;
          case "pick_result": {
            state = "PickCopied";
            const result = await picker.copyPickId(parsed.payload.pickId);
            finishPickerCopy(result);
            return;
          }
          case "error_report":
            state = "ContentError";
            return;
        }
      } catch (error) {
        state = "ContentReady";
        await recordDiagnostics(
          "shell-content",
          diagnosticsFromProtocolError(error),
        );
      }
    },

    async stop(): Promise<void> {
      if (state === "Stopped") {
        return;
      }
      state = "Stopped";
      await liveConnection?.close();
      await deps.contentLoader.close();
      activeSession = undefined;
    },
  };

  function finishPickerCopy(_result: PickCopyResult): void {
    picker.setEnabled(false);
    deps.contentLoader.setPickerMode(false);
    state = "ContentReady";
  }
}

function diagnosticsFromProtocolError(error: unknown): Diagnostic[] {
  if (error instanceof ProtocolError) {
    return error.diagnostics;
  }
  return [{ path: "$", message: errorMessage(error) }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "shell operation failed";
}
