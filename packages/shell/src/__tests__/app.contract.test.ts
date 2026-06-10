import { describe, expect, it } from "vitest";

import { createShellApp } from "../app";
import {
  contentUriFor,
  type ContentLoader,
  type ContentSession,
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
      clipboard: new FakeClipboard(),
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
      clipboard: new FakeClipboard(),
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

  it("loads content after live connection failure", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const live = new FakeLive({ failConnect: true });
    const content = new FakeContentLoader();
    const app = createShellApp({
      center,
      live,
      contentLoader: content,
      clipboard: new FakeClipboard(),
      now: fixedNow,
    });

    await app.start();

    expect(content.loads).toHaveLength(1);
    expect(center.diagnostics[0]?.source).toBe("live");
  });

  it("forwards picker mode and copies pick_result ids", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const content = new FakeContentLoader();
    const clipboard = new FakeClipboard();
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: content,
      clipboard,
      now: fixedNow,
    });

    await app.start();
    app.setPickerMode(true);
    await app.handleContentMessage({
      type: "pick_result",
      payload: { pickId: "content.home.title" },
    });

    expect(content.pickerModes).toEqual([true, false]);
    expect(clipboard.writes).toEqual(["content.home.title"]);
  });

  it("records protocol diagnostics for invalid content messages", async () => {
    const center = new FakeCenter([descriptor("workspace.local", "rev-1")]);
    const app = createShellApp({
      center,
      live: new FakeLive(),
      contentLoader: new FakeContentLoader(),
      clipboard: new FakeClipboard(),
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
});

function descriptor(
  workspaceId: string,
  revision: string,
): CurrentContentDescriptor {
  return { workspaceId, revision, path: "index.html" };
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

  constructor(private readonly descriptors: CurrentContentDescriptor[]) {}

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
    this.diagnostics.push(record);
  }
}

class FakeLive implements BrowserLiveClient {
  connectCount = 0;
  closed = false;
  private handlers: BrowserLiveHandlers | undefined;

  constructor(private readonly options: { failConnect?: boolean } = {}) {}

  async connect(handlers: BrowserLiveHandlers): Promise<BrowserLiveConnection> {
    this.connectCount += 1;
    this.handlers = handlers;
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
}

class FakeContentLoader implements ContentLoader {
  readonly loads: CurrentContentDescriptor[] = [];
  readonly pickerModes: boolean[] = [];
  readonly sessions: ContentSession[] = [];

  async loadCurrent(
    descriptor: CurrentContentDescriptor,
  ): Promise<ContentSession> {
    this.loads.push(descriptor);
    const session: ContentSession = {
      status: "ready",
      descriptor,
      revision: descriptor.revision,
      uri: contentUriFor(descriptor),
      reloadCount: this.loads.length,
      postMessage: () => undefined,
      setHeight: () => undefined,
      close: async () => undefined,
    };
    this.sessions.push(session);
    return session;
  }

  setPickerMode(enabled: boolean): void {
    this.pickerModes.push(enabled);
  }

  setHeight(_height: number): void {}

  async close(): Promise<void> {}
}

class FakeClipboard implements ClipboardWriter {
  readonly writes: string[] = [];

  async writeText(text: string): Promise<void> {
    this.writes.push(text);
  }
}
