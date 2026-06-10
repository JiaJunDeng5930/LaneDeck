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
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace.local",
          query: "dashboard",
          params: {},
        }),
      },
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
});
