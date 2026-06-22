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
    expect(document.root.innerHTML).toContain("lane.alpha / metric / count");
    expect(document.root.innerHTML).toContain("<dd>2</dd>");
    expect(document.root.innerHTML).toContain("<dd>count</dd>");
    expect(document.root.innerHTML).toContain(
      "<dd>2026-06-11T00:01:00.000Z</dd>",
    );
    expect(document.root.innerHTML).toContain("beta quiet frame");
    expect(document.root.innerHTML).toContain("lane.beta");
    expect(document.root.innerHTML).toContain("lane.beta / event / time");
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

  it("renders the operational home sections, metrics, and refined pick ids", () => {
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
                laneId: "lane.alpha",
                stage: "raw",
                frameNo: 1,
                batchId: "batch-a",
                machineId: "machine-alpha",
                recordCount: 2,
                triggerKind: "count",
                closedAt: "2026-06-11T00:01:00.000Z",
                summary: { eventText: "raw collected" },
              },
              {
                laneId: "lane.alpha",
                stage: "metric",
                frameNo: 2,
                batchId: "batch-a",
                machineId: "machine-alpha",
                recordCount: 0,
                triggerKind: "time",
                closedAt: "2026-06-11T00:02:00.000Z",
                summary: { eventText: "quiet metric" },
              },
              {
                laneId: "lane.alpha",
                stage: "event",
                frameNo: 3,
                batchId: "batch-a",
                machineId: "machine-alpha",
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:03:00.000Z",
                summary: { eventText: "event emitted" },
              },
            ],
          },
        ],
        diagnostics: [],
      },
      { contentRevision: "rev-1234567890abcdef" },
    );

    expect(rendered.html).toContain("Lane pipeline operations");
    expect(rendered.html).toContain("dashboard / all lanes");
    expect(rendered.html).toContain("rev-1234...cdef");
    expect(rendered.html).toContain("Lane Pipeline Board");
    expect(rendered.html).toContain("Recent Events Stream");
    expect(rendered.html).toContain("Quiet signals");
    expect(rendered.html).toContain("Count activity");
    expect(rendered.html).toContain("raw collected");
    expect(rendered.html).toContain("quiet metric");
    expect(rendered.html).toContain("event emitted");
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.overview"',
    );
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.lane.lane.alpha"',
    );
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.stage.lane.alpha.raw"',
    );
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.stage.lane.alpha.metric"',
    );
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.stage.lane.alpha.event"',
    );
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.event.lane.alpha:raw:1:batch-a:machine-alpha:row-0:frame-0"',
    );
    expect(rendered.pickIds).toContain(
      "packages/content/src/views.tsx#dashboard.overview",
    );
    expect(rendered.pickIds).toContain(
      "packages/content/src/views.tsx#dashboard.lane.lane.alpha",
    );
  });

  it("preserves supplied source-level pick ids before generated event fallbacks", () => {
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
                laneId: "lane.picked",
                stage: "event",
                frameNo: 8,
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:08:00.000Z",
                summary: { eventText: "source mapped event" },
                pickId: "custom/source.tsx#event.card",
              },
            ],
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.html).toContain(
      'data-pick-id="custom/source.tsx#event.card"',
    );
    expect(rendered.pickIds).toContain("custom/source.tsx#event.card");
    expect(
      rendered.pickIds.some((pickId) =>
        pickId.startsWith("packages/content/src/views.tsx#dashboard.event"),
      ),
    ).toBe(false);
  });

  it("uses observedAt before closedAt for generic response rows", () => {
    const rendered = renderDashboardMarkup(
      {
        view: "dashboard",
        workspaceId: "workspace.local",
      },
      {
        rows: [
          {
            laneId: "lane.generic",
            eventText: "generic event",
            observedAt: "2026-06-11T00:09:00.000Z",
            closedAt: "2026-06-11T00:01:00.000Z",
            triggerKind: "count",
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.html).toContain("2026-06-11T00:09:00.000Z");
    expect(rendered.html).not.toContain("2026-06-11T00:01:00.000Z");
  });

  it("renders custom route rows without dashboard pipeline sections", () => {
    const rendered = renderDashboardMarkup(
      {
        view: "custom",
        workspaceId: "workspace.local",
        query: "custom_events",
        title: "Custom Events",
      },
      {
        rows: [
          {
            eventText: "custom row event",
            observedAt: "2026-06-11T00:09:00.000Z",
            triggerKind: "count",
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.html).toContain("Custom Events");
    expect(rendered.html).toContain("Query Results");
    expect(rendered.html).toContain("custom row event");
    expect(rendered.html).not.toContain("Lane Pipeline Board");
    expect(rendered.html).not.toContain("Overview metrics");
    expect(rendered.pickIds).not.toContain(
      "packages/content/src/views.tsx#dashboard.overview",
    );
  });

  it("uses direct title fields before summary fields for generic rows", () => {
    const rendered = renderDashboardMarkup(
      {
        view: "custom",
        workspaceId: "workspace.local",
        query: "custom_events",
      },
      {
        rows: [
          {
            eventText: "direct row title",
            observedAt: "2026-06-11T00:09:00.000Z",
            summary: { eventText: "summary title" },
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.html).toContain("direct row title");
    expect(rendered.html).not.toContain("summary title");
  });

  it("summarizes equal-timestamp lane frames by pipeline stage order", () => {
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
                laneId: "lane.tie",
                stage: "event",
                frameNo: 3,
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:10:00.000Z",
                summary: { eventText: "event completed" },
              },
              {
                laneId: "lane.tie",
                stage: "metric",
                frameNo: 2,
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:10:00.000Z",
                summary: { eventText: "metric completed" },
              },
              {
                laneId: "lane.tie",
                stage: "raw",
                frameNo: 1,
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:10:00.000Z",
                summary: { eventText: "raw completed" },
              },
            ],
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.html).toContain("<h3>lane.tie</h3><p>event completed</p>");
  });

  it("generates collision-free pick ids for escaped-looking lane ids", () => {
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
                laneId: "lane a",
                stage: "event",
                frameNo: 1,
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:11:00.000Z",
                summary: { eventText: "spaced lane" },
              },
              {
                laneId: "lane_20_a",
                stage: "event",
                frameNo: 1,
                recordCount: 1,
                triggerKind: "count",
                closedAt: "2026-06-11T00:12:00.000Z",
                summary: { eventText: "underscore lane" },
              },
            ],
          },
        ],
        diagnostics: [],
      },
    );

    expect(rendered.pickIds).toContain(
      "packages/content/src/views.tsx#dashboard.lane.lane%20a",
    );
    expect(rendered.pickIds).toContain(
      "packages/content/src/views.tsx#dashboard.lane.lane_20_a",
    );
    expect(new Set(rendered.pickIds).size).toBe(rendered.pickIds.length);
  });

  it("renders a pipeline skeleton empty state", () => {
    const rendered = renderDashboardMarkup(
      {
        view: "dashboard",
        workspaceId: "workspace.empty",
      },
      { rows: [], diagnostics: [] },
    );

    expect(rendered.html).toContain("Waiting for first frames");
    expect(rendered.html).toContain("workspace.empty");
    expect(rendered.html).toContain("Raw");
    expect(rendered.html).toContain("Metric");
    expect(rendered.html).toContain("Event");
    expect(rendered.html).toContain(
      'data-pick-id="packages/content/src/views.tsx#dashboard.empty"',
    );
    expect(rendered.pickIds).toEqual([
      "packages/content/src/views.tsx#dashboard.root",
      "packages/content/src/views.tsx#dashboard.overview",
      "packages/content/src/views.tsx#dashboard.empty",
    ]);
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
    expect(rendered.pickIds).toContain(
      "packages/content/src/views.tsx#dashboard.lane.lane.keep",
    );
    expect(
      rendered.pickIds.some((pickId) =>
        pickId.startsWith("packages/content/src/views.tsx#dashboard.event"),
      ),
    ).toBe(true);
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
      pickId.startsWith("packages/content/src/views.tsx#dashboard.event"),
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

  it("clears the previous read token when full host state changes query URL without a token", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          rows: [
            {
              laneId: "lane.public",
              eventText: "public center render",
            },
          ],
          diagnostics: [],
        }),
    );
    const shell = new FakeShell({
      hostState: {
        pickerEnabled: false,
        centerQueryUrl: "https://trusted-center.example.test/api/query",
        centerReadToken: "old-read-token",
      } as ShellHostState & { centerReadToken: string },
    });
    const app = createContentApp({
      query: createHttpCenterQueryClient({ fetch }),
      shell,
    });

    await app.init();
    shell.updateHostState({
      pickerEnabled: false,
      centerQueryUrl: "https://public-center.example.test/api/query",
      route: {
        view: "dashboard",
        workspaceId: "workspace.local",
        laneId: "lane.public",
      },
    });
    await drainAsyncWork();

    expect(fetch).toHaveBeenCalledWith(
      "https://public-center.example.test/api/query",
      expect.objectContaining({ method: "POST" }),
    );
    const publicQuery = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(publicQuery?.body))).toEqual({
      workspaceId: "workspace.local",
      query: "current_state",
      params: { laneId: "lane.public" },
    });
    expect((publicQuery?.headers as Headers).get("authorization")).toBeNull();
    expect(document.root.innerHTML).toContain("public center render");
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

  it("retries a pending same-route render after full host state repairs query access", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const route = {
      view: "dashboard" as const,
      workspaceId: "workspace.local",
      laneId: "lane.pending-repair",
    };
    const query = new PendingAccessRepairQuery({
      rows: [
        {
          laneId: "lane.pending-repair",
          eventText: "pending repair render",
        },
      ],
      diagnostics: [],
    });
    const shell = new FakeShell({
      hostState: {
        pickerEnabled: false,
        route,
      },
    });
    const app = createContentApp({
      query,
      shell,
    });

    const init = app.init();
    await drainAsyncWork();

    expect(query.requests).toEqual([
      {
        request: {
          workspaceId: "workspace.local",
          query: "current_state",
          params: { laneId: "lane.pending-repair" },
        },
        queryUrl: undefined,
        readToken: undefined,
      },
    ]);

    shell.updateHostState({
      pickerEnabled: false,
      centerQueryUrl: "https://center.example.test/api/query",
      centerReadToken: "pending-repair-token",
      route,
    } as ShellHostState & { centerReadToken: string });
    await Promise.resolve();

    expect(query.requests).toHaveLength(1);

    query.rejectPending(new ContentError("center query access missing"));
    await init;
    await drainAsyncWork();

    expect(query.requests).toEqual([
      {
        request: {
          workspaceId: "workspace.local",
          query: "current_state",
          params: { laneId: "lane.pending-repair" },
        },
        queryUrl: undefined,
        readToken: undefined,
      },
      {
        request: {
          workspaceId: "workspace.local",
          query: "current_state",
          params: { laneId: "lane.pending-repair" },
        },
        queryUrl: "https://center.example.test/api/query",
        readToken: "pending-repair-token",
      },
    ]);
    expect(document.root.innerHTML).toContain("pending repair render");
    expect(document.root.innerHTML).not.toContain("content render failed");
    app.dispose();
  });

  it("rerenders the same route after an error when full host state repairs query access", async () => {
    const document = new TestDocument();
    vi.stubGlobal("document", document as unknown as Document);
    const route = {
      view: "dashboard" as const,
      workspaceId: "workspace.local",
      laneId: "lane.same-repair",
    };
    const responses = [
      Response.json({
        rows: [
          {
            laneId: "lane.same-repair",
            eventText: "initial same route render",
          },
        ],
        diagnostics: [],
      }),
      Response.json({ rows: [], diagnostics: [] }, { status: 503 }),
      Response.json({
        rows: [
          {
            laneId: "lane.same-repair",
            eventText: "same route repaired render",
          },
        ],
        diagnostics: [],
      }),
    ];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("missing query response");
        }
        return response;
      },
    );
    const shell = new FakeShell({
      hostState: {
        pickerEnabled: false,
        centerQueryUrl: "https://old-center.example.test/api/query",
        centerReadToken: "old-read-token",
        route,
      } as ShellHostState & { centerReadToken: string },
    });
    const app = createContentApp({
      query: createHttpCenterQueryClient({ fetch }),
      shell,
    });

    try {
      await app.init();
      expect(document.root.innerHTML).toContain("initial same route render");

      await app.render(route);
      expect(document.root.innerHTML).toContain("content render failed");

      shell.updateHostState({
        pickerEnabled: false,
        centerQueryUrl: "https://repaired-center.example.test/api/query",
        centerReadToken: "repaired-read-token",
        route,
      } as ShellHostState & { centerReadToken: string });
      await drainAsyncWork();

      expect(fetch).toHaveBeenCalledTimes(3);
      const repairedQuery = fetch.mock.calls[2];
      expect(repairedQuery?.[0]).toBe(
        "https://repaired-center.example.test/api/query",
      );
      const repairedInit = repairedQuery?.[1];
      expect(JSON.parse(String(repairedInit?.body))).toEqual({
        workspaceId: "workspace.local",
        query: "current_state",
        params: { laneId: "lane.same-repair" },
      });
      expect((repairedInit?.headers as Headers).get("authorization")).toBe(
        "Bearer repaired-read-token",
      );
      expect(document.root.innerHTML).toContain("same route repaired render");
      expect(document.root.innerHTML).not.toContain("content render failed");
    } finally {
      app.dispose();
    }
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

class PendingAccessRepairQuery implements CenterQueryClient {
  readonly requests: Array<{
    request: QueryRequest;
    queryUrl: string | undefined;
    readToken: string | undefined;
  }> = [];
  private queryUrl: string | undefined;
  private readToken: string | undefined;
  private pendingReject: ((error: unknown) => void) | undefined;

  constructor(private readonly repairedResponse: QueryResponse) {}

  setQueryUrl(queryUrl: string): void {
    this.queryUrl = queryUrl;
  }

  setReadToken(readToken: string | undefined): void {
    this.readToken = readToken;
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    this.requests.push({
      request,
      queryUrl: this.queryUrl,
      readToken: this.readToken,
    });
    if (this.queryUrl === undefined || this.readToken === undefined) {
      return new Promise((_resolve, reject) => {
        this.pendingReject = reject;
      });
    }

    return this.repairedResponse;
  }

  rejectPending(error: unknown): void {
    this.pendingReject?.(error);
    this.pendingReject = undefined;
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
