import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  QueryRequest,
  QueryResponse,
  ShellContentMessage,
} from "@lanedeck/protocol";

import {
  ContentError,
  createContentApp,
  createHttpCenterQueryClient,
  registerPickTarget,
  renderDashboardMarkup,
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
          pickId: "packages/content/src/views.tsx#dashboard.row.14",
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
        query: "current_state",
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

  it("renders frames from the current_state response in center order", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const query = new FakeQuery({
      rows: [
        {
          frames: [
            {
              laneId: "lane.alpha",
              stage: "metric",
              frameNo: 1,
              recordCount: 2,
              triggerKind: "count",
              closedAt: "2026-06-11T00:01:00.000Z",
              summary: { eventText: "alpha metric frame" },
            },
            {
              laneId: "lane.beta",
              stage: "event",
              frameNo: 2,
              recordCount: 0,
              triggerKind: "time",
              closedAt: "2026-06-11T00:02:00.000Z",
              summary: { eventText: "beta quiet frame" },
            },
          ],
        },
      ],
      diagnostics: [],
    });
    const app = createContentApp({
      query,
      shell: new FakeShell({ hostState: { pickerEnabled: false } }),
    });

    await app.render({
      view: "dashboard",
      workspaceId: "workspace.local",
    });

    expect(document.root.innerHTML).toContain("alpha metric frame");
    expect(document.root.innerHTML).toContain("lane.alpha");
    expect(document.root.innerHTML).toContain("<dd>metric</dd>");
    expect(document.root.innerHTML).toContain("<dd>2</dd>");
    expect(document.root.innerHTML).toContain("<dd>count</dd>");
    expect(document.root.innerHTML).toContain(
      "<dd>2026-06-11T00:01:00.000Z</dd>",
    );
    expect(document.root.innerHTML).toContain("beta quiet frame");
    expect(document.root.innerHTML).toContain("lane.beta");
    expect(document.root.innerHTML).toContain("<dd>event</dd>");
    expect(document.root.innerHTML).toContain("<dd>0</dd>");
    expect(document.root.innerHTML).toContain("<dd>time</dd>");
    expect(document.root.innerHTML).toContain(
      "<dd>2026-06-11T00:02:00.000Z</dd>",
    );
    expect(document.root.innerHTML.indexOf("alpha metric frame")).toBeLessThan(
      document.root.innerHTML.indexOf("beta quiet frame"),
    );
    app.dispose();
  });

  it("renders only frames for the dashboard lane route", () => {
    const rendered = renderDashboardMarkup(
      {
        view: "dashboard",
        workspaceId: "workspace.local",
        laneId: "lane.keep",
      },
      {
        rows: [
          {
            frames: [
              {
                laneId: "lane.keep",
                stage: "metric",
                frameNo: 3,
                recordCount: 4,
                triggerKind: "count",
                closedAt: "2026-06-11T00:03:00.000Z",
                summary: { eventText: "target lane frame" },
              },
              {
                laneId: "lane.drop",
                stage: "event",
                frameNo: 4,
                recordCount: 1,
                triggerKind: "time",
                closedAt: "2026-06-11T00:04:00.000Z",
                summary: { eventText: "other lane frame" },
              },
            ],
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.html).toContain("target lane frame");
    expect(rendered.html).toContain("lane.keep");
    expect(rendered.html).not.toContain("other lane frame");
    expect(rendered.html).not.toContain("lane.drop");
    expect(rendered.pickIds).toHaveLength(2);
    expect(rendered.pickIds[1]).toContain("lane.keep");
  });

  it("renders unique fallback pick ids for same lane stage frame identities", () => {
    const rendered = renderDashboardMarkup(
      {
        view: "dashboard",
        workspaceId: "workspace.local",
      },
      {
        rows: [
          {
            frames: [
              {
                laneId: "lane.same",
                stage: "event",
                frameNo: 7,
                batchId: "batch-a",
                machineId: "machine-alpha",
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:01:00.000Z",
              },
              {
                laneId: "lane.same",
                stage: "event",
                frameNo: 7,
                batchId: "batch-b",
                machineId: "machine-beta",
                recordCount: 2,
                triggerKind: "time",
                closedAt: "2026-06-11T00:02:00.000Z",
              },
            ],
          },
        ],
        diagnostics: [],
      },
    );
    const framePickIds = rendered.pickIds.filter((pickId) =>
      pickId.startsWith("packages/content/src/views.tsx#dashboard.frame"),
    );

    expect(framePickIds).toHaveLength(2);
    expect(new Set(framePickIds).size).toBe(2);
    expect(framePickIds[0]).toContain("lane.same:event:7");
    expect(framePickIds[1]).toContain("lane.same:event:7");
    expect(hasPickIdentity(framePickIds[0], ["batch-a", "frame-0"])).toBe(true);
    expect(hasPickIdentity(framePickIds[0], ["machine-alpha", "frame-0"])).toBe(
      true,
    );
    expect(hasPickIdentity(framePickIds[1], ["batch-b", "frame-1"])).toBe(true);
    expect(hasPickIdentity(framePickIds[1], ["machine-beta", "frame-1"])).toBe(
      true,
    );
    for (const pickId of framePickIds) {
      expect(rendered.html).toContain(`data-pick-id="${pickId}"`);
    }
  });

  it("uses the shell-provided center query URL and read token for initial dashboard render", async () => {
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
        centerQueryUrl: "https://center.example.test/api/query",
        centerReadToken: "shell-read-token",
        route: { view: "dashboard", workspaceId: "workspace.local" },
      } as ShellHostState & { centerReadToken: string },
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
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: "workspace.local",
      query: "current_state",
      params: {},
    });
    expect((init?.headers as Headers).get("authorization")).toBe(
      "Bearer shell-read-token",
    );
    expect(document.root.innerHTML).toContain("shell boot render");
    app.dispose();
  });

  it("keeps shell query access after a picker-only host state patch", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          rows: [
            {
              laneId: "lane.after-picker",
              eventText: "authorized render",
            },
          ],
          diagnostics: [],
        }),
    );
    const shell = new FakeShell({
      hostState: {
        pickerEnabled: false,
        centerQueryUrl: "https://center.example.test/api/query",
        centerReadToken: "shell-read-token",
        route: { view: "dashboard", workspaceId: "workspace.local" },
      } as ShellHostState & { centerReadToken: string },
    });
    const app = createContentApp({
      query: createHttpCenterQueryClient({ fetch }),
      shell,
    });

    await app.init();
    fetch.mockClear();
    shell.updateHostState({ pickerEnabled: true });
    await app.render({
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.after-picker",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://center.example.test/api/query",
      expect.objectContaining({ method: "POST" }),
    );
    const afterPatch = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(afterPatch?.body))).toEqual({
      workspaceId: "workspace.local",
      query: "current_state",
      params: { laneId: "lane.after-picker" },
    });
    expect((afterPatch?.headers as Headers).get("authorization")).toBe(
      "Bearer shell-read-token",
    );
    expect(document.root.innerHTML).toContain("authorized render");
    app.dispose();
  });

  it("rerenders the same route when full host state restores query access after an initial failure", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const route = {
      view: "dashboard" as const,
      workspaceId: "workspace.local",
      laneId: "lane.recovered",
    };
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          rows: [
            {
              laneId: "lane.recovered",
              eventText: "recovered render",
            },
          ],
          diagnostics: [],
        }),
    );
    const shell = new FakeShell({
      hostState: {
        pickerEnabled: false,
        route,
      },
    });
    const app = createContentApp({
      query: createHttpCenterQueryClient({ fetch }),
      shell,
    });

    await app.init();

    expect(fetch).toHaveBeenCalledTimes(0);
    expect(document.root.innerHTML).toContain("content render failed");

    shell.updateHostState({
      pickerEnabled: false,
      centerQueryUrl: "https://center.example.test/api/query",
      centerReadToken: "recovered-read-token",
      route,
    } as ShellHostState & { centerReadToken: string });
    await drainAsyncWork();

    expect(fetch).toHaveBeenCalledWith(
      "https://center.example.test/api/query",
      expect.objectContaining({ method: "POST" }),
    );
    const recovered = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(recovered?.body))).toEqual({
      workspaceId: "workspace.local",
      query: "current_state",
      params: { laneId: "lane.recovered" },
    });
    expect((recovered?.headers as Headers).get("authorization")).toBe(
      "Bearer recovered-read-token",
    );
    expect(document.root.innerHTML).toContain("recovered render");
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
      pickId: "packages/content/src/views.tsx#dashboard.manual-55",
      element: target as unknown as HTMLElement,
    });
    target.dispatch("click");
    shell.updateHostState({ pickerEnabled: true });
    target.dispatch("click");

    expect(shell.messages).toContainEqual({
      type: "pick_result",
      payload: { pickId: "packages/content/src/views.tsx#dashboard.manual-55" },
    });

    registration.unregister();
    app.dispose();
  });

  it("clears highlighted pick state when picker mode is disabled", async () => {
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
      pickId: "packages/content/src/views.tsx#dashboard.manual-66",
      element: target as unknown as HTMLElement,
    });
    target.dispatch("pointerenter");
    shell.updateHostState({ pickerEnabled: false });

    expect(target.getAttribute("data-pick-state")).toBe("registered");

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
      pickId: "packages/content/src/views.tsx#dashboard.manual-44",
      element: target as unknown as HTMLElement,
    });
    target.dispatch("click");

    expect(target.preventDefaultCalls).toBe(1);
    expect(target.stopPropagationCalls).toBe(1);
    expect(shell.messages).toContainEqual({
      type: "pick_result",
      payload: { pickId: "packages/content/src/views.tsx#dashboard.manual-44" },
    });

    registration.unregister();
    app.dispose();
  });

  it("rejects empty and non-source-level pick ids", () => {
    const target = new TestPickElement();

    expect(() =>
      registerPickTarget({
        pickId: "",
        element: target as unknown as HTMLElement,
      }),
    ).toThrow(ContentError);
    expect(() =>
      registerPickTarget({
        pickId: "packages/content/src/views.tsx.dashboard.manual",
        element: target as unknown as HTMLElement,
      }),
    ).toThrow(ContentError);
  });

  it("stops pointer and click reporting after unregister", async () => {
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
      pickId: "packages/content/src/views.tsx#dashboard.removed",
      element: target as unknown as HTMLElement,
    });
    registration.unregister();
    target.dispatch("pointerenter");
    target.dispatch("click");

    expect(target.getAttribute("data-pick-state")).toBeNull();
    expect(target.preventDefaultCalls).toBe(0);
    expect(target.stopPropagationCalls).toBe(0);
    expect(shell.messages).not.toContainEqual(
      expect.objectContaining({ type: "pick_result" }),
    );
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
      pickId: "packages/content/src/views.tsx#dashboard.manual-44",
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
      rows: [{ laneId: "lane.second", eventText: "second route event" }],
      diagnostics: [],
    });
    await secondRender;

    query.resolve("lane.first", {
      rows: [{ laneId: "lane.first", eventText: "first route event" }],
      diagnostics: [],
    });
    await firstRender;

    expect(document.root.innerHTML).toContain("second route event");
    expect(document.root.innerHTML).not.toContain("first route event");
    app.dispose();
  });

  it("renders routes delivered by host state updates", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const shell = new FakeShell({
      hostState: { pickerEnabled: false },
    });
    const query = new FakeQuery({
      rows: [
        {
          laneId: "lane.route-update",
          eventText: "route update render",
        },
      ],
      diagnostics: [],
    });
    const app = createContentApp({
      query,
      shell,
    });

    await app.init();
    shell.updateHostState({
      pickerEnabled: false,
      route: {
        view: "dashboard",
        workspaceId: "workspace.local",
        laneId: "lane.route-update",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(query.requests).toContainEqual({
      workspaceId: "workspace.local",
      query: "current_state",
      params: { laneId: "lane.route-update" },
    });
    expect(document.root.innerHTML).toContain("route update render");
    app.dispose();
  });

  it("updates picker state for an identical full host state route", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const route = {
      view: "dashboard" as const,
      workspaceId: "workspace.local",
      laneId: "lane.same",
      params: { severity: "warning" },
    };
    const query = new SequencedQuery([
      {
        rows: [
          {
            pickId: "packages/content/src/views.tsx#dashboard.same-route",
            eventText: "same route render",
          },
        ],
        diagnostics: [],
      },
      {
        rows: [
          {
            pickId: "packages/content/src/views.tsx#dashboard.replaced-route",
            eventText: "unexpected replacement render",
          },
        ],
        diagnostics: [],
      },
    ]);
    const shell = new FakeShell({
      hostState: { pickerEnabled: false },
    });
    const app = createContentApp({
      query,
      shell,
    });

    await app.init();
    await app.render(route);
    const renderedHtml = document.root.innerHTML;
    const target = new TestPickElement();
    const registration = registerPickTarget({
      pickId: "packages/content/src/views.tsx#dashboard.same-route-manual",
      element: target as unknown as HTMLElement,
    });
    shell.updateHostState({
      pickerEnabled: true,
      workspaceId: "workspace.local",
      contentRevision: "rev-1",
      centerQueryUrl: "https://center.example.test/api/query",
      centerReadToken: "shell-read-token",
      route: {
        view: "dashboard",
        workspaceId: "workspace.local",
        laneId: "lane.same",
        params: { severity: "warning" },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    target.dispatch("click");

    expect(query.requests).toEqual([
      {
        workspaceId: "workspace.local",
        query: "current_state",
        params: { severity: "warning", laneId: "lane.same" },
      },
    ]);
    expect(document.root.innerHTML).toBe(renderedHtml);
    expect(shell.messages).toContainEqual({
      type: "pick_result",
      payload: {
        pickId: "packages/content/src/views.tsx#dashboard.same-route-manual",
      },
    });

    registration.unregister();
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

function hasPickIdentity(pickId: string, candidates: string[]): boolean {
  return candidates.some((candidate) => pickId.includes(candidate));
}

async function drainAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class SequencedQuery implements CenterQueryClient {
  readonly requests: QueryRequest[] = [];

  constructor(private readonly responses: QueryResponse[]) {}

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("missing query response");
    }
    return response;
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
