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
  dashboardRoute,
  type ContentLoader,
  type ContentHostState,
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
  liveConnectTimeoutMs?: number;
  onContentSession?: (session: ContentSession) => void;
  onPickerModeChange?: (enabled: boolean) => void;
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
  let lifecycleGeneration = 0;
  const liveConnectTimeoutMs = deps.liveConnectTimeoutMs ?? 2_000;

  function enqueueContentLoad(): Promise<ContentSession> {
    const generation = lifecycleGeneration;
    const load = loadTail.then(
      () => performContentLoad(generation),
      () => performContentLoad(generation),
    );
    loadTail = load.then(
      () => undefined,
      () => undefined,
    );
    return load;
  }

  async function performContentLoad(
    generation: number,
  ): Promise<ContentSession> {
    if (isStaleGeneration(generation)) {
      return contentLoadFailure(new Error("shell is stopped"));
    }

    state = "LoadingContent";
    try {
      const descriptor = await deps.center.getCurrentContent();
      if (isStaleGeneration(generation)) {
        return contentLoadFailure(new Error("shell is stopped"), descriptor);
      }
      const session = await deps.contentLoader.loadCurrent(
        descriptor,
        hostStateFor(descriptor),
      );
      if (isStaleGeneration(generation)) {
        if (session.status === "ready") {
          await session.close();
        }
        return contentLoadFailure(new Error("shell is stopped"), descriptor);
      }
      if (session.status === "ready") {
        activeSession = session;
        state = picker.isEnabled() ? "PickerArmed" : "ContentReady";
        if (picker.isEnabled()) {
          deps.contentLoader.setPickerMode(true);
        }
        deps.onContentSession?.(session);
        return session;
      }
      state = "ContentError";
      await safelyRecordDiagnostics("content", session.diagnostics);
      deps.onContentSession?.(session);
      return session;
    } catch (error) {
      state = "ContentError";
      const failure = contentLoadFailure(error);
      await safelyRecordDiagnostics("content", failure.diagnostics);
      deps.onContentSession?.(failure);
      return failure;
    }
  }

  async function handleLiveEvent(event: BrowserLiveEvent): Promise<void> {
    if (state === "Stopped") {
      return;
    }
    if (event.type === "content_changed") {
      if (
        activeSession !== undefined &&
        (event.workspaceId !== activeSession.descriptor.workspaceId ||
          event.contentRevision === activeSession.revision)
      ) {
        return;
      }
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
      const liveAttempt = connectLive();
      await Promise.all([enqueueContentLoad(), waitForLiveStart(liveAttempt)]);
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
      deps.onPickerModeChange?.(enabled);
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
              if (picker.isEnabled()) {
                deps.contentLoader.setPickerMode(true);
              }
            }
            return;
          case "height_changed":
            deps.contentLoader.setHeight(parsed.payload.height);
            state = activeSession === undefined ? state : "ContentReady";
            return;
          case "pick_result": {
            if (!picker.isEnabled()) {
              return;
            }
            const generation = lifecycleGeneration;
            state = "PickCopied";
            const result = await picker.copyPickId(parsed.payload.pickId);
            if (isStaleGeneration(generation)) {
              return;
            }
            await finishPickerCopy(result);
            return;
          }
          case "error_report":
            state = "ContentError";
            await safelyRecordDiagnostics("shell-content", [
              {
                path: "payload.message",
                message:
                  parsed.payload.detail === undefined
                    ? parsed.payload.message
                    : `${parsed.payload.message}: ${parsed.payload.detail}`,
              },
            ]);
            return;
        }
      } catch (error) {
        await safelyRecordDiagnostics(
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
      lifecycleGeneration += 1;
      await liveConnection?.close();
      await deps.contentLoader.close();
      activeSession = undefined;
    },
  };

  async function connectLive(): Promise<void> {
    try {
      const connection = await deps.live.connect({
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
      if (state === "Stopped") {
        await connection.close();
        return;
      }
      liveConnection = connection;
    } catch (error) {
      await safelyRecordDiagnostics("live", [
        { path: "$", message: errorMessage(error) },
      ]);
    }
  }

  async function waitForLiveStart(liveAttempt: Promise<void>): Promise<void> {
    await Promise.race([
      liveAttempt,
      new Promise<void>((resolve) =>
        globalThis.setTimeout(resolve, liveConnectTimeoutMs),
      ),
    ]);
  }

  function isStaleGeneration(generation: number): boolean {
    return state === "Stopped" || generation !== lifecycleGeneration;
  }

  function hostStateFor(
    descriptor: LoadedContentSession["descriptor"],
  ): ContentHostState {
    const access = deps.center.getContentQueryAccess?.();
    const centerQueryUrl = descriptor.centerQueryUrl ?? access?.queryUrl;
    const centerReadToken = descriptor.centerReadToken ?? access?.readToken;
    return {
      pickerEnabled: picker.isEnabled(),
      workspaceId: descriptor.workspaceId,
      contentRevision: descriptor.revision,
      route: descriptor.route ?? dashboardRoute(descriptor.workspaceId),
      ...(centerQueryUrl === undefined
        ? {}
        : {
            centerQueryUrl,
            ...(centerReadToken === undefined ? {} : { centerReadToken }),
          }),
    };
  }

  async function finishPickerCopy(result: PickCopyResult): Promise<void> {
    picker.setEnabled(false);
    deps.contentLoader.setPickerMode(false);
    deps.onPickerModeChange?.(false);
    if (result.status === "failed") {
      await safelyRecordDiagnostics("shell-content", [
        {
          path: "picker.clipboard",
          message: `clipboard write failed for ${result.pickId}: ${errorMessage(result.error)}`,
        },
      ]);
    }
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
