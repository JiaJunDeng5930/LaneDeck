import { describe, expect, it } from "vitest";

import type { Diagnostic } from "@lanedeck/protocol";
import {
  centerLiveUrl,
  createBrowserDiagnosticReporter,
  createHttpCenterClient,
  createHttpMutationClient,
  createWebSocketLiveClient,
  type BrowserLiveEvent,
} from "../center";

describe("center clients", () => {
  it("queries the current content descriptor", async () => {
    const calls: RequestInit[] = [];
    const client = createHttpCenterClient({
      baseUrl: "https://center.example",
      workspaceId: "workspace.local",
      readToken: "read-token",
      fetch: async (_input, init) => {
        calls.push(init ?? {});
        return jsonResponse({
          rows: [
            {
              revision: "rev-1",
              contentPath: "dashboards/home.html",
            },
          ],
          diagnostics: [],
        });
      },
    });

    await expect(client.getCurrentContent()).resolves.toEqual({
      workspaceId: "workspace.local",
      revision: "rev-1",
      path: "dashboards/home.html",
      centerQueryUrl: "https://center.example/api/query",
      centerReadToken: "read-token",
    });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      workspaceId: "workspace.local",
      query: "current_content",
      params: {},
    });
    expect(new Headers(calls[0]?.headers).get("authorization")).toBe(
      "Bearer read-token",
    );
  });

  it("derives explicit HTTP content uris from a configured content base url", async () => {
    const client = createHttpCenterClient({
      baseUrl: "https://center.example",
      workspaceId: "workspace.local",
      contentBaseUrl: "http://lanedeck.localhost:4174/content/",
      fetch: async () =>
        jsonResponse({
          rows: [
            {
              revision: "rev-1",
              contentPath: "dashboards/home.html",
            },
          ],
          diagnostics: [],
        }),
    });

    await expect(client.getCurrentContent()).resolves.toMatchObject({
      workspaceId: "workspace.local",
      revision: "rev-1",
      path: "dashboards/home.html",
      uri: "http://lanedeck.localhost:4174/content/workspace.local/rev-1/dashboards/home.html",
    });
  });

  it("decodes browser live events with stable mutation ids", async () => {
    const events: BrowserLiveEvent[] = [];
    const diagnostics: Diagnostic[] = [];
    const client = createWebSocketLiveClient({
      url: "wss://center.example/ws/browser?workspaceId=workspace.local",
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connection = client.connect({
      onEvent: (event) => events.push(event),
      onDiagnostic: (items) => diagnostics.push(...items),
    });
    const socket = FakeWebSocket.last();
    socket.emit("open");
    await connection;
    socket.emit("message", {
      data: JSON.stringify({
        type: "content_changed",
        workspaceId: "workspace.local",
        contentRevision: "rev-2",
        mutationId: "mutation-2",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "content_changed",
        workspaceId: "workspace.local",
        contentRevision: "rev-3",
        mutationId: 3,
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "ingest_committed",
        workspaceId: "workspace.local",
        batchId: "batch-1",
        acceptedFrameCount: 1,
      }),
    });
    await drainAsyncWork();

    expect(events).toEqual([
      {
        type: "content_changed",
        workspaceId: "workspace.local",
        contentRevision: "rev-2",
        mutationId: "mutation-2",
      },
      {
        type: "ingest_committed",
        workspaceId: "workspace.local",
        batchId: "batch-1",
        acceptedFrameCount: 1,
      },
    ]);
    expect(diagnostics).toEqual([
      { path: "mutationId", message: "expected string" },
    ]);
  });

  it("reports browser live disconnects after an opened socket closes or errors", async () => {
    const disconnects: string[] = [];
    const client = createWebSocketLiveClient({
      url: "wss://center.example/ws/browser?workspaceId=workspace.local",
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connection = client.connect({
      onEvent: () => undefined,
      onError: () => disconnects.push("error"),
      onDisconnect: () => disconnects.push("disconnected"),
    });
    const socket = FakeWebSocket.last();
    socket.emit("open");
    await connection;

    socket.emit("error");
    socket.emit("close");

    expect(disconnects).toEqual(["error", "disconnected"]);
  });

  it("posts AI mutation requests and validates mutation results", async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const client = createHttpMutationClient({
      baseUrl: "https://center.example/root",
      mutationToken: "ai-token",
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return jsonResponse({
          mutation: "patch_content",
          mutationId: "mutation-1",
          contentRevision: "rev-2",
          diagnostics: [],
        });
      },
    });

    const result = await client.patchContent("workspace.local", {
      pickId: "content.home.title",
      text: "Updated",
    });

    expect(result.contentRevision).toBe("rev-2");
    expect(calls[0]?.input).toBe("https://center.example/api/ai/mutation");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      workspaceId: "workspace.local",
      mutation: "patch_content",
      payload: {
        pickId: "content.home.title",
        text: "Updated",
      },
    });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer ai-token",
    );
  });

  it("builds browser WSS live URLs for workspaces", () => {
    expect(centerLiveUrl("https://center.example", "workspace.local")).toBe(
      "wss://center.example/ws/browser?workspaceId=workspace.local",
    );
    expect(
      centerLiveUrl("https://center.example", "workspace.local", "read-token"),
    ).toBe(
      "wss://center.example/ws/browser?workspaceId=workspace.local&readToken=read-token",
    );
  });

  it("records protocol diagnostics into browser storage", async () => {
    const storage = new MemoryStorage();
    const report = createBrowserDiagnosticReporter({
      storage,
      key: "diagnostics",
    });

    await report({
      source: "shell-content",
      receivedAt: "2026-06-11T00:00:00.000Z",
      diagnostics: [{ path: "type", message: "expected ready" }],
    });

    expect(JSON.parse(storage.getItem("diagnostics") ?? "[]")).toEqual([
      {
        source: "shell-content",
        receivedAt: "2026-06-11T00:00:00.000Z",
        diagnostics: [{ path: "type", message: "expected ready" }],
      },
    ]);
  });
});

async function drainAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) {
      throw new Error("missing fake websocket");
    }
    return socket;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push((event: unknown) => {
      if (typeof listener === "function") {
        listener(event as Event);
        return;
      }
      listener.handleEvent(event as Event);
    });
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {
    this.emit("close");
  }
}
