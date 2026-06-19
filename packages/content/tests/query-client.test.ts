import { describe, expect, it, vi } from "vitest";

import {
  ContentError,
  createHttpCenterQueryClient,
  type CenterQueryClient,
} from "../src/index";

describe("center query client", () => {
  it("posts query requests to the center query API", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          rows: [{ eventText: "quiet signal", triggerKind: "time" }],
          diagnostics: [],
        }),
    );
    const client = createHttpCenterQueryClient({
      queryUrl: "https://center.example.test/api/query",
      fetch,
      headers: new Headers([["authorization", "Bearer token"]]),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "current_state",
        params: {},
      }),
    ).resolves.toEqual({
      rows: [{ eventText: "quiet signal", triggerKind: "time" }],
      diagnostics: [],
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://center.example.test/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace.local",
          query: "current_state",
          params: {},
        }),
      }),
    );
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).get("authorization")).toBe(
      "Bearer token",
    );
    expect((init?.headers as Headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("rejects invalid center query responses", async () => {
    const client = createHttpCenterQueryClient({
      queryUrl: "https://center.example.test/api/query",
      fetch: async () => Response.json({ rows: "bad", diagnostics: [] }),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "current_state",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ContentError);
  });

  it.each([
    {
      name: "sparse rows",
      body: () => {
        const rows: unknown[] = [];
        rows[1] = {};
        return { rows, diagnostics: [] };
      },
    },
    {
      name: "sparse diagnostics",
      body: () => {
        const diagnostics: unknown[] = [];
        diagnostics[1] = { path: "$", message: "bad response" };
        return { rows: [], diagnostics };
      },
    },
    {
      name: "sparse nested arrays",
      body: () => {
        const frames: unknown[] = [];
        frames[1] = { laneId: "lane.build" };
        return { rows: [{ frames }], diagnostics: [] };
      },
    },
  ])("rejects $name in query responses", async ({ body }) => {
    const client = createHttpCenterQueryClient({
      queryUrl: "https://center.example.test/api/query",
      fetch: async () => fakeJsonResponse(body()),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "current_state",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ContentError);
  });

  it("applies read tokens supplied after construction", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ rows: [], diagnostics: [] }),
    );
    const client = createHttpCenterQueryClient({
      queryUrl: "https://center.example.test/api/query",
      fetch,
    }) as CenterQueryClient & {
      setReadToken?: (readToken: string) => void;
    };

    client.setReadToken?.("shell-read-token");
    await client.query({
      workspaceId: "workspace.local",
      query: "current_state",
      params: {},
    });

    const init = fetch.mock.calls[0]?.[1];
    expect((init?.headers as Headers).get("authorization")).toBe(
      "Bearer shell-read-token",
    );
  });

  it("requires the shell-provided center query URL before querying", async () => {
    const client = createHttpCenterQueryClient({
      fetch: async () => Response.json({ rows: [], diagnostics: [] }),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "current_content",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ContentError);
  });
});

function fakeJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
