import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  QueryRequest,
  QueryResponse,
  ShellContentMessage,
} from "@lanedeck/protocol";

import {
  createContentApp,
  createHttpCenterQueryClient,
  registerPickTarget,
  type CenterQueryClient,
  type ShellBridge,
  type ShellHostState,
  type ShellInitMessage,
} from "../src/index";

describe("content package contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends ready after shell init", async () => {
    const shell = new FakeShell({
      hostState: { pickerEnabled: false },
    });
    const app = createContentApp({
      query: new FakeQuery({ rows: [], diagnostics: [] }),
      shell,
    });

    await app.init();

    expect(shell.messages).toContainEqual(
      expect.objectContaining({ type: "ready" }),
    );
    app.dispose();
  });

  it("queries dashboard data and renders the result", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const query = new FakeQuery({
      rows: [
        {
          pickId: "content/source/dashboard.tsx:14",
          laneId: "lane.build",
          eventText: "build complete",
          triggerKind: "count",
        },
      ],
      diagnostics: [],
    });
    const shell = new FakeShell({ hostState: { pickerEnabled: false } });
    const app = createContentApp({
      query,
      shell,
    });

    await app.render({
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.build",
    });

    expect(query.requests).toEqual([
      {
        workspaceId: "workspace.local",
        query: "dashboard",
        params: { laneId: "lane.build" },
      },
    ]);
    expect(document.root.innerHTML).toContain("build complete");
    expect(document.root.innerHTML).toContain("lane.build");
    expect(shell.messages).toContainEqual({
      type: "height_changed",
      payload: { height: 320 },
    });
    app.dispose();
  });

  it("uses the shell-provided center endpoint for initial dashboard render", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          rows: [{ eventText: "shell boot render" }],
          diagnostics: [],
        }),
    );
    const shell = new FakeShell({
      hostState: {
        pickerEnabled: false,
        centerQueryEndpoint: "https://center.example.test/",
        route: { view: "dashboard", workspaceId: "workspace.local" },
      },
    });
    const app = createContentApp({
      query: createHttpCenterQueryClient({ fetch }),
      shell,
    });

    await app.init();

    expect(fetch).toHaveBeenCalledWith(
      "https://center.example.test/api/query",
      expect.objectContaining({ method: "POST" }),
    );
    expect(document.root.innerHTML).toContain("shell boot render");
    app.dispose();
  });

  it("applies picker mode updates after shell init", async () => {
    const shell = new FakeShell({
      hostState: { pickerEnabled: false },
    });
    const app = createContentApp({
      query: new FakeQuery({ rows: [], diagnostics: [] }),
      shell,
    });
    const target = new TestPickElement();

    await app.init();
    const registration = registerPickTarget({
      pickId: "content/source/dashboard.tsx:55",
      element: target as unknown as HTMLElement,
    });
    target.dispatch("click");
    shell.updateHostState({ pickerEnabled: true });
    target.dispatch("click");

    expect(shell.messages).toContainEqual({
      type: "pick_result",
      payload: { pickId: "content/source/dashboard.tsx:55" },
    });

    registration.unregister();
    app.dispose();
  });

  it("emits a source-level pick id for a registered target", async () => {
    const shell = new FakeShell({
      hostState: { pickerEnabled: true },
    });
    const app = createContentApp({
      query: new FakeQuery({ rows: [], diagnostics: [] }),
      shell,
    });
    const target = new TestPickElement();

    await app.init();
    const registration = registerPickTarget({
      pickId: "content/source/dashboard.tsx:44",
      element: target as unknown as HTMLElement,
    });
    target.dispatch("click");

    expect(target.preventDefaultCalls).toBe(1);
    expect(target.stopPropagationCalls).toBe(1);
    expect(shell.messages).toContainEqual({
      type: "pick_result",
      payload: { pickId: "content/source/dashboard.tsx:44" },
    });

    registration.unregister();
    app.dispose();
  });

  it("leaves target clicks alone while picker mode is disabled", async () => {
    const shell = new FakeShell({
      hostState: { pickerEnabled: false },
    });
    const app = createContentApp({
      query: new FakeQuery({ rows: [], diagnostics: [] }),
      shell,
    });
    const target = new TestPickElement();

    await app.init();
    const registration = registerPickTarget({
      pickId: "content/source/dashboard.tsx:44",
      element: target as unknown as HTMLElement,
    });
    target.dispatch("click");

    expect(target.preventDefaultCalls).toBe(0);
    expect(target.stopPropagationCalls).toBe(0);
    expect(shell.messages).not.toContainEqual(
      expect.objectContaining({ type: "pick_result" }),
    );

    registration.unregister();
    app.dispose();
  });

  it("renders only the latest route when queries resolve out of order", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const query = new DeferredQuery();
    const app = createContentApp({
      query,
      shell: new FakeShell({ hostState: { pickerEnabled: false } }),
    });

    const firstRender = app.render({
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.first",
    });
    const secondRender = app.render({
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.second",
    });

    query.resolve("lane.second", {
      rows: [{ eventText: "second route event" }],
      diagnostics: [],
    });
    await secondRender;

    query.resolve("lane.first", {
      rows: [{ eventText: "first route event" }],
      diagnostics: [],
    });
    await firstRender;

    expect(document.root.innerHTML).toContain("second route event");
    expect(document.root.innerHTML).not.toContain("first route event");
    app.dispose();
  });

  it("reports query failure through the shell protocol", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const shell = new FakeShell({
      hostState: { pickerEnabled: false },
    });
    const app = createContentApp({
      query: new RejectingQuery(),
      shell,
    });

    await app.render({ view: "dashboard", workspaceId: "workspace.local" });

    expect(shell.messages).toContainEqual(
      expect.objectContaining({
        type: "error_report",
        payload: expect.objectContaining({
          message: "content render failed",
        }),
      }),
    );
    expect(shell.messages).toContainEqual({
      type: "height_changed",
      payload: { height: 320 },
    });
    expect(document.root.innerHTML).toContain("content render failed");
    app.dispose();
  });

  it("ignores init that arrives after disposal", async () => {
    const shell = new DeferredShell();
    const app = createContentApp({
      query: new FakeQuery({ rows: [], diagnostics: [] }),
      shell,
    });
    const init = app.init();

    app.dispose();
    shell.resolve({
      hostState: {
        pickerEnabled: true,
        route: { view: "dashboard", workspaceId: "workspace.local" },
      },
    });
    await init;

    expect(shell.messages).toEqual([]);
  });
});

class FakeQuery implements CenterQueryClient {
  readonly requests: QueryRequest[] = [];

  constructor(private readonly response: QueryResponse) {}

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.requests.push(request);
    return this.response;
  }
}

class RejectingQuery implements CenterQueryClient {
  async query(_request: QueryRequest): Promise<QueryResponse> {
    throw new Error("center unavailable");
  }
}

class DeferredQuery implements CenterQueryClient {
  private readonly pending = new Map<
    string,
    (response: QueryResponse) => void
  >();

  async query(request: QueryRequest): Promise<QueryResponse> {
    return new Promise((resolve) => {
      this.pending.set(String(request.params.laneId), resolve);
    });
  }

  resolve(laneId: string, response: QueryResponse): void {
    this.pending.get(laneId)?.(response);
  }
}

class FakeShell implements ShellBridge {
  readonly messages: ShellContentMessage[] = [];
  private readonly hostStateListeners = new Set<
    (state: ShellHostState) => void
  >();

  constructor(private readonly initMessage: ShellInitMessage) {}

  async waitForInit(): Promise<ShellInitMessage> {
    return this.initMessage;
  }

  async send(message: ShellContentMessage): Promise<void> {
    this.messages.push(message);
  }

  subscribeHostState(listener: (state: ShellHostState) => void): {
    unsubscribe(): void;
  } {
    this.hostStateListeners.add(listener);

    return {
      unsubscribe: () => {
        this.hostStateListeners.delete(listener);
      },
    };
  }

  updateHostState(state: ShellHostState): void {
    for (const listener of this.hostStateListeners) {
      listener(state);
    }
  }
}

class DeferredShell implements ShellBridge {
  readonly messages: ShellContentMessage[] = [];
  private resolveInit: ((message: ShellInitMessage) => void) | undefined;

  async waitForInit(): Promise<ShellInitMessage> {
    return new Promise((resolve) => {
      this.resolveInit = resolve;
    });
  }

  async send(message: ShellContentMessage): Promise<void> {
    this.messages.push(message);
  }

  resolve(message: ShellInitMessage): void {
    this.resolveInit?.(message);
  }
}

class TestDocument {
  readonly root = new TestRootElement();

  getElementById(id: string): TestRootElement | null {
    return id === "root" ? this.root : null;
  }
}

class TestRootElement {
  innerHTML = "";
  scrollHeight = 320;

  querySelectorAll(): HTMLElement[] {
    return [];
  }
}

class TestPickElement {
  readonly listeners = new Map<string, EventListener>();
  readonly attributes = new Map<string, string>();
  preventDefaultCalls = 0;
  stopPropagationCalls = 0;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, listener);
  }

  removeEventListener(name: string): void {
    this.listeners.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  dispatch(name: string): void {
    this.listeners.get(name)?.({
      preventDefault: () => {
        this.preventDefaultCalls += 1;
      },
      stopPropagation: () => {
        this.stopPropagationCalls += 1;
      },
    } as Event);
  }
}
