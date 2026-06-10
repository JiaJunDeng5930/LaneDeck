import { describe, expect, it } from "vitest";

import {
  centerLiveUrl,
  createHttpCenterClient,
  createHttpMutationClient,
} from "../center";

describe("center clients", () => {
  it("queries the current content descriptor", async () => {
    const calls: RequestInit[] = [];
    const client = createHttpCenterClient({
      baseUrl: "https://center.example",
      workspaceId: "workspace.local",
      fetch: async (_input, init) => {
        calls.push(init ?? {});
        return jsonResponse({
          rows: [
            {
              contentRevision: "rev-1",
              path: "dashboards/home.html",
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
    });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      workspaceId: "workspace.local",
      query: "current_content",
      params: {},
    });
  });

  it("posts AI mutation requests and validates mutation results", async () => {
    const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
    const client = createHttpMutationClient({
      baseUrl: "https://center.example/root",
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
  });

  it("builds browser WSS live URLs for workspaces", () => {
    expect(centerLiveUrl("https://center.example", "workspace.local")).toBe(
      "wss://center.example/api/live/browser?workspaceId=workspace.local",
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
