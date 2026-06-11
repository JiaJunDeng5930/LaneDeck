import { describe, expect, it } from "vitest";

import {
  centerLiveUrl,
  createBrowserDiagnosticReporter,
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
