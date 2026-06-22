import { describe, expect, it } from "vitest";

import { createShellApp } from "../app";
import {
  contentLoadFailure,
  contentUriFor,
  type ContentHostState,
  type ContentLoader,
  type ContentSession,
  type LoadedContentSession,
} from "../content";
import type {
  BrowserLiveClient,
  BrowserLiveEvent,
  BrowserLiveHandlers,
  BrowserLiveConnection,
  CenterQueryClient,
  CurrentContentDescriptor,
  ProtocolDiagnosticRecord,
} from "../center";
import type { ClipboardWriter } from "../picker";

describe("shell app contract", () => {
  it("loads current content revision into the iframe session", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const live = new FakeLive();
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();

    expect(live.connectCount).toBe(1);
    expect(content.loads).toEqual([descriptor("workspace.local", "rev-1")]);
    const session = content.sessions[0];
    expect(session?.status).toBe("ready");
    expect(session?.status === "ready" ? session.uri : undefined).toBe(
      "lanedeck://content/workspace.local/rev-1/index.html",
    );
  });

  it("omits center read token from external content uri host state", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1", {
        uri: "https://evil.example/app.html",
        centerQueryUrl: "https://center.example/api/query",
        centerReadToken: "read-token",
      }),
    ]);
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();

    expect(content.hostStates[0]).toEqual({
      pickerEnabled: false,
      workspaceId: "workspace.local",
      contentRevision: "rev-1",
      centerQueryUrl: "https://center.example/api/query",
      route: { view: "dashboard", workspaceId: "workspace.local" },
    });
  });

  it("includes center read token for generated lanedeck content host state", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1", {
        centerQueryUrl: "https://center.example/api/query",
        centerReadToken: "read-token",
      }),
    ]);
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();

    expect(content.sessions[0]?.status).toBe("ready");
    expect(
      content.sessions[0]?.status === "ready"
        ? content.sessions[0].uri
        : undefined,
    ).toBe("lanedeck://content/workspace.local/rev-1/index.html");
    expect(content.hostStates[0]).toEqual({
      pickerEnabled: false,
      workspaceId: "workspace.local",
      contentRevision: "rev-1",
      centerQueryUrl: "https://center.example/api/query",
      centerReadToken: "read-token",
      route: { view: "dashboard", workspaceId: "workspace.local" },
    });
  });

  it("keeps custom descriptor routes in content host state", async () => {
    const route = {
      view: "custom" as const,
      workspaceId: "workspace.local",
      title: "Build failures",
      query: "current_content",
      params: { severity: "warning", laneId: "lane.build" },
    };
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1", { route }),
    ]);
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();

    expect(content.loads).toEqual([
      descriptor("workspace.local", "rev-1", { route }),
    ]);
    expect(content.hostStates[0]).toEqual({
      pickerEnabled: false,
      workspaceId: "workspace.local",
      contentRevision: "rev-1",
      route,
    });
  });

  it("reloads content when the live channel emits content_changed", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1"),
      descriptor("workspace.local", "rev-2"),
    ]);
    const live = new FakeLive();
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();
    live.emit({
      type: "content_changed",
      workspaceId: "workspace.local",
      contentRevision: "rev-2",
    });
    await drainAsyncWork();

    expect(content.loads.map((load) => load.revision)).toEqual([
      "rev-1",
      "rev-2",
    ]);
  });

  it("reloads content when the live channel emits ingest_committed", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1"),
      descriptor("workspace.local", "rev-2"),
    ]);
    const live = new FakeLive();
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();
    live.emit({
      type: "ingest_committed",
      workspaceId: "workspace.local",
      batchId: "batch-1",
      acceptedFrameCount: 1,
    });
    await drainAsyncWork();

    expect(content.loads.map((load) => load.revision)).toEqual([
      "rev-1",
      "rev-2",
    ]);
  });

  it("loads content after live connection failure", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const live = new FakeLive({ failConnect: true });
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();

    expect(content.loads).toHaveLength(1);
    expect(center.diagnostics[0]?.source).toBe("live");
  });

  it("loads initial content when the live connection remains pending", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive({ pendingConnect: true }),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
      liveConnectTimeoutMs: 0,
    });

    await app.start();

    expect(content.loads).toEqual([descriptor("workspace.local", "rev-1")]);
  });

  it("reports live connection changes only after connect resolves and stop closes it", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const live = new DeferredLive();
    const liveChanges: boolean[] = [];
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
      liveConnectTimeoutMs: 0,
      onLiveConnectionChange(connected) {
        liveChanges.push(connected);
      },
    });

    await app.start();

    expect(content.loads).toEqual([descriptor("workspace.local", "rev-1")]);
    expect(liveChanges).toEqual([]);

    live.resolve();
    await drainAsyncWork();

    expect(liveChanges).toEqual([true]);

    await app.stop();

    expect(live.closed).toBe(true);
    expect(liveChanges).toEqual([true, false]);
  });

  it("clears live readiness when an active live connection disconnects", async () => {
    const live = new FakeLive();
    const liveChanges: boolean[] = [];
    const app = createShellApp({
      center: new FakeCenter([descriptor("workspace.local", "rev-1")]),
      live,
      contentLoader: new FakeContentLoader(),
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
      onLiveConnectionChange(connected) {
        liveChanges.push(connected);
      },
    });

    await app.start();
    live.disconnect();
    live.disconnect();
    await drainAsyncWork();

    expect(liveChanges).toEqual([true, false]);
  });

  it("loadCurrentContent returns typed failures and records content diagnostics", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader([
      contentLoadFailure(new Error("iframe failed")),
    ]);
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    const session = await app.loadCurrentContent();

    expect(session.status).toBe("error");
    expect(center.diagnostics).toEqual([
      {
        source: "content",
        receivedAt: fixedNow(),
        diagnostics: [{ path: "content", message: "iframe failed" }],
      },
    ]);
  });

  it("retains the previous active session when replacement content fails", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1"),
      descriptor("workspace.local", "rev-2"),
    ]);
    const content = new FakeContentLoader([
      readySession(descriptor("workspace.local", "rev-1"), 1),
      contentLoadFailure(
        new Error("replacement failed"),
        descriptor("workspace.local", "rev-2"),
      ),
    ]);
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();
    await expect(app.loadCurrentContent()).resolves.toMatchObject({
      status: "error",
    });
    await app.handleContentMessage({
      type: "height_changed",
      payload: { height: 240 },
    });

    expect(content.heightChanges).toEqual([{ revision: "rev-1", height: 240 }]);
    expect(center.diagnostics).toContainEqual({
      source: "content",
      receivedAt: fixedNow(),
      diagnostics: [{ path: "content", message: "replacement failed" }],
    });
  });

  it("stop closes live and content and ignores later side effects", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1"),
      descriptor("workspace.local", "rev-2"),
    ]);
    const live = new FakeLive();
    const content = new FakeContentLoader();
    const clipboard = new FakeClipboard();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: clipboard.writer,
      now: fixedNow,
    });

    await app.start();
    await app.stop();
    live.emit({
      type: "content_changed",
      workspaceId: "workspace.local",
      contentRevision: "rev-2",
    });
    app.setPickerMode(true);
    await app.handleContentMessage({
      type: "pick_result",
      payload: { pickId: "content.home.title" },
    });
    await drainAsyncWork();

    expect(live.closed).toBe(true);
    expect(content.closeCount).toBe(1);
    expect(content.loads.map((load) => load.revision)).toEqual(["rev-1"]);
    expect(clipboard.writes).toEqual([]);
  });

  it("stop prevents pending startup loads from becoming active", async () => {
    const center = new DeferredCenter();
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    const startup = app.start();
    await app.stop();
    center.resolve(descriptor("workspace.local", "rev-1"));
    await startup;

    expect(content.loads).toEqual([]);
    expect(content.closeCount).toBe(1);
  });

  it("stop preserves terminal state after delayed picker copies", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const clipboard = new DeferredClipboard();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: clipboard.writer,
      now: fixedNow,
    });

    await app.start();
    app.setPickerMode(true);
    const copy = app.handleContentMessage({
      type: "pick_result",
      payload: { pickId: "content.home.title" },
    });
    await clipboard.waitForWrite();
    await app.stop();
    clipboard.resolve();
    await copy;
    app.setPickerMode(true);

    expect(content.closeCount).toBe(1);
    expect(content.pickerModes).toEqual([true]);
  });

  it("forwards picker mode and copies pick_result ids", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const clipboard = new FakeClipboard();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: clipboard.writer,
      now: fixedNow,
    });

    await app.start();
    app.setPickerMode(true);
    await app.handleContentMessage({ type: "ready", payload: {} });
    await app.handleContentMessage({
      type: "pick_result",
      payload: { pickId: "content.home.title" },
    });

    expect(content.pickerModes).toEqual([true, true, false]);
    expect(clipboard.writes).toEqual(["content.home.title"]);
  });

  it("records picker diagnostics when clipboard writes fail", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard({ failWrites: true }).writer,
      now: fixedNow,
    });

    await app.start();
    app.setPickerMode(true);
    await app.handleContentMessage({
      type: "pick_result",
      payload: { pickId: "content.home.title", ignored: "field" },
    });

    expect(content.pickerModes).toEqual([true, false]);
    expect(center.diagnostics).toEqual([
      {
        source: "shell-content",
        receivedAt: fixedNow(),
        diagnostics: [
          {
            path: "picker.clipboard",
            message:
              "clipboard write failed for content.home.title: clipboard unavailable",
          },
        ],
      },
    ]);
  });

  it("ignores pick_result messages while picker mode is disabled", async () => {
    const clipboard = new FakeClipboard();
    const app = createShellApp({
      center: new FakeCenter([descriptor("workspace.local", "rev-1")]),
      live: new FakeLive(),
      contentLoader: new FakeContentLoader(),
      clipboard: clipboard.writer,
      now: fixedNow,
    });

    await app.start();
    await app.handleContentMessage({
      type: "pick_result",
      payload: { pickId: "content.home.title" },
    });

    expect(clipboard.writes).toEqual([]);
  });

  it("handles ready, height_changed, and error_report shell-content messages", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();
    await app.handleContentMessage({ type: "ready", payload: {} });
    await app.handleContentMessage({
      type: "height_changed",
      payload: { height: 321.2 },
    });
    await app.handleContentMessage({
      type: "error_report",
      payload: { message: "render failed", detail: "missing chart" },
    });

    expect(content.heightChanges).toEqual([
      { revision: "rev-1", height: 321.2 },
    ]);
    expect(center.diagnostics).toContainEqual({
      source: "shell-content",
      receivedAt: fixedNow(),
      diagnostics: [
        {
          path: "payload.message",
          message: "render failed: missing chart",
        },
      ],
    });
  });

  it("ignores live events for other workspaces and already active revisions", async () => {
    const center = new FakeCenter([
      descriptor("workspace.local", "rev-1"),
      descriptor("workspace.local", "rev-2"),
    ]);
    const live = new FakeLive();
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.start();
    live.emit({
      type: "content_changed",
      workspaceId: "other.workspace",
      contentRevision: "rev-2",
    });
    live.emit({
      type: "content_changed",
      workspaceId: "workspace.local",
      contentRevision: "rev-1",
    });
    live.emit({
      type: "ingest_committed",
      workspaceId: "other.workspace",
      batchId: "batch-1",
      acceptedFrameCount: 1,
    });
    live.emit({
      type: "content_changed",
      workspaceId: "workspace.local",
      contentRevision: "rev-2",
    });
    await drainAsyncWork();

    expect(content.loads.map((load) => load.revision)).toEqual([
      "rev-1",
      "rev-2",
    ]);
  });

  it("records protocol diagnostics for invalid content messages", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: new FakeContentLoader(),
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await app.handleContentMessage({
      type: "pick_result",
      payload: {},
    });

    expect(center.diagnostics).toEqual([
      {
        source: "shell-content",
        receivedAt: fixedNow(),
        diagnostics: [{ path: "payload.pickId", message: "expected string" }],
      },
    ]);
  });

  it("keeps invalid content diagnostics from rejecting message handling", async () => {
    const app = createShellApp({
      center: new FakeCenter([descriptor("workspace.local", "rev-1")], {
        failDiagnostics: true,
      }),
      live: new FakeLive(),
      contentLoader: new FakeContentLoader(),
      clipboard: new FakeClipboard().writer,
      now: fixedNow,
    });

    await expect(
      app.handleContentMessage({
        type: "pick_result",
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });
});

function descriptor(
  workspaceId: string,
  revision: string,
  overrides: Partial<CurrentContentDescriptor> = {},
): CurrentContentDescriptor {
  return { workspaceId, revision, path: "index.html", ...overrides };
}

function fixedNow(): string {
  return "2026-06-11T00:00:00.000Z";
}

async function drainAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeCenter implements CenterQueryClient {
  readonly diagnostics: ProtocolDiagnosticRecord[] = [];
  private readIndex = 0;

  constructor(
    private readonly descriptors: CurrentContentDescriptor[],
    private readonly options: { failDiagnostics?: boolean } = {},
  ) {}

  async getCurrentContent(): Promise<CurrentContentDescriptor> {
    const descriptor =
      this.descriptors[Math.min(this.readIndex, this.descriptors.length - 1)];
    this.readIndex += 1;
    if (descriptor === undefined) {
      throw new Error("missing descriptor");
    }
    return descriptor;
  }

  async recordProtocolDiagnostic(
    record: ProtocolDiagnosticRecord,
  ): Promise<void> {
    if (this.options.failDiagnostics === true) {
      throw new Error("diagnostic write failed");
    }
    this.diagnostics.push(record);
  }
}

class DeferredCenter implements CenterQueryClient {
  readonly diagnostics: ProtocolDiagnosticRecord[] = [];
  private readonly deferred = deferredPromise<CurrentContentDescriptor>();

  async getCurrentContent(): Promise<CurrentContentDescriptor> {
    return await this.deferred.promise;
  }

  resolve(descriptor: CurrentContentDescriptor): void {
    this.deferred.resolve(descriptor);
  }

  async recordProtocolDiagnostic(
    record: ProtocolDiagnosticRecord,
  ): Promise<void> {
    this.diagnostics.push(record);
  }
}

class FakeLive implements BrowserLiveClient {
  connectCount = 0;
  closed = false;
  private handlers: BrowserLiveHandlers | undefined;

  constructor(
    private readonly options: {
      failConnect?: boolean;
      pendingConnect?: boolean;
    } = {},
  ) {}

  async connect(handlers: BrowserLiveHandlers): Promise<BrowserLiveConnection> {
    this.connectCount += 1;
    this.handlers = handlers;
    if (this.options.pendingConnect === true) {
      return new Promise<BrowserLiveConnection>(() => undefined);
    }
    if (this.options.failConnect === true) {
      throw new Error("wss unavailable");
    }
    return {
      close: async () => {
        this.closed = true;
      },
    };
  }

  emit(event: BrowserLiveEvent): void {
    this.handlers?.onEvent(event);
  }

  disconnect(): void {
    this.handlers?.onDisconnect?.();
  }
}

class DeferredLive implements BrowserLiveClient {
  connectCount = 0;
  closed = false;
  private readonly deferred = deferredPromise<BrowserLiveConnection>();
  private handlers: BrowserLiveHandlers | undefined;

  async connect(handlers: BrowserLiveHandlers): Promise<BrowserLiveConnection> {
    this.connectCount += 1;
    this.handlers = handlers;
    return await this.deferred.promise;
  }

  resolve(): void {
    this.deferred.resolve({
      close: async () => {
        this.closed = true;
      },
    });
  }

  emit(event: BrowserLiveEvent): void {
    this.handlers?.onEvent(event);
  }
}

class FakeContentLoader implements ContentLoader {
  readonly loads: CurrentContentDescriptor[] = [];
  readonly hostStates: Array<ContentHostState | undefined> = [];
  readonly pickerModes: boolean[] = [];
  readonly sessions: ContentSession[] = [];
  readonly heightChanges: Array<{
    revision: string | undefined;
    height: number;
  }> = [];
  closeCount = 0;
  private activeRevision: string | undefined;

  constructor(private readonly plannedSessions: ContentSession[] = []) {}

  async loadCurrent(
    descriptor: CurrentContentDescriptor,
    hostState?: ContentHostState,
  ): Promise<ContentSession> {
    this.loads.push(descriptor);
    this.hostStates.push(hostState);
    const session =
      this.plannedSessions.shift() ??
      readySession(descriptor, this.loads.length);
    this.sessions.push(session);
    if (session.status === "ready") {
      this.activeRevision = session.revision;
    }
    return session;
  }

  setPickerMode(enabled: boolean): void {
    this.pickerModes.push(enabled);
  }

  setHeight(height: number): void {
    this.heightChanges.push({ revision: this.activeRevision, height });
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.activeRevision = undefined;
  }
}

class FakeClipboard {
  readonly writes: string[] = [];

  constructor(private readonly options: { failWrites?: boolean } = {}) {}

  readonly writer: ClipboardWriter = async (text) => {
    if (this.options.failWrites === true) {
      throw new Error("clipboard unavailable");
    }
    this.writes.push(text);
  };
}

class DeferredClipboard {
  private readonly writeStarted = deferredPromise<void>();
  private readonly writeFinished = deferredPromise<void>();

  readonly writer: ClipboardWriter = async (_text) => {
    this.writeStarted.resolve();
    await this.writeFinished.promise;
  };

  async waitForWrite(): Promise<void> {
    await this.writeStarted.promise;
  }

  resolve(): void {
    this.writeFinished.resolve();
  }
}

function readySession(
  descriptor: CurrentContentDescriptor,
  reloadCount: number,
): LoadedContentSession {
  return {
    status: "ready",
    descriptor,
    revision: descriptor.revision,
    uri: contentUriFor(descriptor),
    reloadCount,
    postMessage: () => undefined,
    setHeight: () => undefined,
    close: async () => undefined,
  };
}

function deferredPromise<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}
