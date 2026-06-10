import { describe, expect, it, vi } from "vitest";

import { ContentError, createHttpCenterQueryClient } from "../src/index";

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
      endpoint: "https://center.example.test/",
      fetch,
      headers: new Headers([["authorization", "Bearer token"]]),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "dashboard",
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
          query: "dashboard",
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
      endpoint: "https://center.example.test",
      fetch: async () => Response.json({ rows: "bad", diagnostics: [] }),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "dashboard",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ContentError);
  });

  it("requires the shell-provided center endpoint before querying", async () => {
    const client = createHttpCenterQueryClient({
      fetch: async () => Response.json({ rows: [], diagnostics: [] }),
    });

    await expect(
      client.query({
        workspaceId: "workspace.local",
        query: "dashboard",
        params: {},
      }),
    ).rejects.toBeInstanceOf(ContentError);
  });
});
