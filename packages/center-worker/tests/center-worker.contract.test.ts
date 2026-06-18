import { describe, expect, it } from "vitest";

import { LiveHub, restoreLiveSockets, type LiveSocket } from "../src/live";
import { handleRequest } from "../src/router";
import { rewriteViteAssetReferences } from "../src/storage/r2";
import type {
  CenterStorage,
  ContentObjectKeys,
  ContentObjectStore,
  ContentObjectWrite,
  ContentRevisionRecord,
  LaneRevisionRecord,
} from "../src/storage/types";
import { WorkspaceService } from "../src/workspace";
import type {
  IngestBatch,
  JsonObject,
  MutationRequest,
} from "@lanedeck/protocol";

const validFrame = {
  laneId: "lane.local",
  stage: "event",
  frameNo: 1,
  openedAt: "2026-06-10T10:00:00.000Z",
  closedAt: "2026-06-10T10:00:05.000Z",
  triggerKind: "count",
  recordCount: 1,
  records: [
    {
      id: "record-1",
      observedAt: "2026-06-10T10:00:01.000Z",
      body: { text: "hello" },
    },
  ],
  summary: { event: "hello" },
} satisfies IngestBatch["frames"][number];

describe("center-worker contract", () => {
  it("POST /api/ingest persists structured rows and returns ack", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ingest",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          batchId: "batch-1",
          frames: [validFrame],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      batchId: "batch-1",
      acceptedFrameCount: 1,
      diagnostics: [],
    });
    expect(harness.storage.batches).toHaveLength(1);
    expect(harness.storage.frames).toHaveLength(1);
  });

  it("invalid ingest payload returns validation diagnostics", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ingest",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          batchId: "batch-1",
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "protocol_validation_failed",
      diagnostics: [expect.objectContaining({ path: "frames" })],
    });
  });

  it("POST /api/ingest rejects missing agent token before writes", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest("/api/ingest", {
        workspaceId: "workspace.local",
        machineId: "machine.local",
        batchId: "batch-1",
        frames: [validFrame],
      }),
      harness.env,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "authentication_failed",
      diagnostics: [expect.objectContaining({ path: "authorization" })],
    });
    expect(harness.storage.writeCount).toBe(0);
  });

  it("POST /api/query reads current state without mutation", async () => {
    const harness = createHarness();
    await harness.workspace.ingest({
      workspaceId: "workspace.local",
      machineId: "machine.local",
      batchId: "batch-1",
      frames: [validFrame],
    });
    const writesBeforeQuery = harness.storage.writeCount;

    const response = await handleRequest(
      jsonRequest("/api/query", {
        workspaceId: "workspace.local",
        query: "current_state",
        params: {},
      }),
      harness.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rows: [
        {
          workspaceId: "workspace.local",
          frames: [expect.objectContaining({ batchId: "batch-1" })],
        },
      ],
      diagnostics: [],
    });
    expect(harness.storage.writeCount).toBe(writesBeforeQuery);
  });

  it("keeps same batch ids from different machines distinct in current state", async () => {
    const harness = createHarness();
    await harness.workspace.ingest({
      workspaceId: "workspace.local",
      machineId: "machine-a",
      batchId: "batch-1",
      frames: [validFrame],
    });
    await harness.workspace.ingest({
      workspaceId: "workspace.local",
      machineId: "machine-b",
      batchId: "batch-1",
      frames: [{ ...validFrame, frameNo: 2 }],
    });

    const response = await handleRequest(
      jsonRequest("/api/query", {
        workspaceId: "workspace.local",
        query: "current_state",
        params: {},
      }),
      harness.env,
    );

    await expect(response.json()).resolves.toMatchObject({
      rows: [
        {
          frames: [
            expect.objectContaining({
              machineId: "machine-a",
              batchId: "batch-1",
            }),
            expect.objectContaining({
              machineId: "machine-b",
              batchId: "batch-1",
            }),
          ],
        },
      ],
    });
  });

  it("POST /api/ai/mutation writes content source to R2 and metadata to D1", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ai/mutation",
        {
          workspaceId: "workspace.local",
          mutation: "patch_content",
          payload: {
            path: "src/dashboard.tsx",
            contentPath: "index.html",
            source: "<h1>patched</h1>",
            metadata: { pickId: "content.home" },
          },
        },
        "ai-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mutation: "patch_content",
      mutationId: "id-1",
      contentRevision: "id-2",
      diagnostics: [],
    });
    expect(
      harness.objects.writes.get(
        "content-source/workspace.local/id-2/src/dashboard.tsx",
      ),
    ).toBe("<h1>patched</h1>");
    expect(harness.objects.writes.get("content/id-2/index.html")).toBe(
      "<h1>patched</h1>",
    );
    expect(harness.storage.contentRevisions).toEqual([
      expect.objectContaining({
        workspaceId: "workspace.local",
        mutationId: "id-1",
        revision: "id-2",
        sourcePath: "src/dashboard.tsx",
        contentPath: "index.html",
      }),
    ]);
  });

  it("invalid content mutation payload returns diagnostics without mutation log writes", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ai/mutation",
        {
          workspaceId: "workspace.local",
          mutation: "patch_content",
          payload: {
            source: "<h1>missing path</h1>",
          },
        },
        "ai-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_mutation_payload",
      diagnostics: [expect.objectContaining({ path: "payload.path" })],
    });
    expect(harness.storage.mutations).toHaveLength(0);
  });

  it("POST /api/ai/mutation rejects wrong token before payload validation", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ai/mutation",
        {
          workspaceId: "workspace.local",
          mutation: "patch_content",
          payload: {
            source: "<h1>missing path</h1>",
          },
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "authentication_failed",
      diagnostics: [expect.objectContaining({ path: "authorization" })],
    });
    expect(harness.storage.mutations).toHaveLength(0);
  });

  it("unsupported API GET returns JSON diagnostics", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      new Request("https://center.local/api/query", { method: "GET" }),
      harness.env,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toMatchObject({
      error: "route_not_found",
    });
  });

  it("WebSocket routes proxy upgrade requests through the workspace fetch handler", async () => {
    let fetchedPath = "";
    const response = await handleRequest(
      new Request(
        "https://center.local/ws/browser?workspaceId=workspace.local",
        {
          method: "GET",
          headers: { upgrade: "websocket" },
        },
      ),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => ({
            fetch: async (request: Request) => {
              fetchedPath = new URL(request.url).pathname;
              return new Response(null, { status: 204 });
            },
          }),
        },
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(204);
    expect(fetchedPath).toBe("/ws/browser");
  });

  it("agent WebSocket rejects missing agent token before coordinator fetch", async () => {
    let fetched = false;
    const response = await handleRequest(
      new Request("https://center.local/ws/agent?workspaceId=workspace.local", {
        method: "GET",
        headers: { upgrade: "websocket" },
      }),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => ({
            fetch: async () => {
              fetched = true;
              return new Response(null, { status: 204 });
            },
          }),
        },
        LANEDECK_AI_MUTATION_TOKEN: "ai-token",
        LANEDECK_AGENT_TOKEN: "agent-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(401);
    expect(fetched).toBe(false);
  });

  it("browser WSS receives content_changed after content mutation", async () => {
    const harness = createHarness();
    const browser = new RecordingSocket();
    harness.live.addBrowser(browser);

    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "patch_content",
      payload: {
        path: "index.html",
        source: "<main>live</main>",
      },
    });

    expect(browser.decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "content_changed",
        workspaceId: "workspace.local",
        mutationId: "id-1",
        contentRevision: "id-2",
      }),
    );
  });

  it("agent WSS receives build command when mutation requires local build", async () => {
    const harness = createHarness();
    const agent = new RecordingSocket();
    harness.live.addAgent(agent);

    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "request_local_build",
      payload: { reason: "content_changed" },
    });

    expect(agent.decodedMessages()).toContainEqual({
      type: "build_content",
      workspaceId: "workspace.local",
      mutationId: "id-1",
      buildRequestId: "id-2",
      payload: { reason: "content_changed" },
    });
  });

  it("restores hibernated sockets into the live hub", () => {
    const live = new LiveHub();
    const browser = new RecordingSocket();
    const agent = new RecordingSocket();

    restoreLiveSockets(live, [agent], [browser]);
    live.broadcastToBrowsers({
      type: "ingest_committed",
      workspaceId: "workspace.local",
      batchId: "batch-1",
      acceptedFrameCount: 1,
    });
    live.sendToAgents({
      type: "build_content",
      workspaceId: "workspace.local",
      mutationId: "mutation-1",
      buildRequestId: "build-1",
      payload: {},
    });

    expect(browser.decodedMessages()).toContainEqual(
      expect.objectContaining({ type: "ingest_committed" }),
    );
    expect(agent.decodedMessages()).toContainEqual(
      expect.objectContaining({ type: "build_content" }),
    );
  });

  it("rewrites Vite root asset URLs into revision-scoped content URLs", () => {
    expect(
      rewriteViteAssetReferences(
        '<link rel="stylesheet" href="/assets/index.css"><script src="/assets/index.js"></script>',
        "revision-1",
      ),
    ).toBe(
      '<link rel="stylesheet" href="/content/revision-1/assets/index.css"><script src="/content/revision-1/assets/index.js"></script>',
    );
  });
});

function createHarness() {
  const storage = new MemoryCenterStorage();
  const objects = new MemoryContentObjectStore();
  const live = new LiveHub();
  let nextId = 0;
  const workspace = new WorkspaceService({
    storage,
    contentStore: objects,
    live,
    clock: () => "2026-06-10T10:00:00.000Z",
    idGenerator: () => `id-${(nextId += 1).toString()}`,
  });
  const env = {
    WORKSPACE_COORDINATOR: {
      getByName: () => ({
        ...workspace,
        ingest: (batch: IngestBatch) => workspace.ingest(batch),
        query: (request: Parameters<WorkspaceService["query"]>[0]) =>
          workspace.query(request),
        mutate: (request: Parameters<WorkspaceService["mutate"]>[0]) =>
          workspace.mutate(request),
        connectAgent: async () => new Response(null, { status: 204 }),
        connectBrowser: async () => new Response(null, { status: 204 }),
        fetch: async () => new Response(null, { status: 204 }),
      }),
    },
    LANEDECK_DB: {},
    LANEDECK_BUCKET: {},
    LANEDECK_AI_MUTATION_TOKEN: "ai-token",
    LANEDECK_AGENT_TOKEN: "agent-token",
  };

  return { storage, objects, live, workspace, env };
}

function jsonRequest(path: string, body: JsonObject, token?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return new Request(`https://center.local${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

class RecordingSocket implements LiveSocket {
  readonly messages: string[] = [];

  send(message: string): void {
    this.messages.push(message);
  }

  decodedMessages(): JsonObject[] {
    return this.messages.map((message) => JSON.parse(message) as JsonObject);
  }
}

class MemoryContentObjectStore implements ContentObjectStore {
  readonly writes = new Map<string, string>();

  async writeContentSource(
    write: ContentObjectWrite,
  ): Promise<ContentObjectKeys> {
    const sourceKey = [
      "content-source",
      write.workspaceId,
      write.revision,
      write.sourcePath,
    ].join("/");
    const assetKey = ["content", write.revision, write.contentPath].join("/");
    this.writes.set(sourceKey, write.source);
    this.writes.set(assetKey, write.source);
    return { sourceKey, assetKey };
  }
}

class MemoryCenterStorage implements CenterStorage {
  readonly batches: IngestBatch[] = [];
  readonly frames: IngestBatch["frames"] = [];
  readonly contentRevisions: ContentRevisionRecord[] = [];
  readonly mutations: MutationRequest[] = [];
  readonly laneRevisions: LaneRevisionRecord[] = [];
  writeCount = 0;

  async initialize(): Promise<void> {}

  async saveIngestBatch(batch: IngestBatch): Promise<void> {
    this.writeCount += 1;
    this.batches.push(batch);
    this.frames.push(...batch.frames);
  }

  async getCurrentState(workspaceId: string): Promise<JsonObject> {
    const currentContent =
      this.contentRevisions[this.contentRevisions.length - 1] ?? null;
    return {
      workspaceId,
      frames: this.batches.flatMap((batch) =>
        batch.workspaceId === workspaceId
          ? batch.frames.map((frame) => ({
              batchId: batch.batchId,
              laneId: frame.laneId,
              machineId: batch.machineId,
              stage: frame.stage,
              frameNo: frame.frameNo,
              triggerKind: frame.triggerKind,
              recordCount: frame.recordCount,
              summary: frame.summary,
            }))
          : [],
      ),
      currentContent:
        currentContent === null
          ? null
          : {
              revision: currentContent.revision,
              sourcePath: currentContent.sourcePath,
              contentPath: currentContent.contentPath,
            },
    };
  }

  async saveContentRevision(record: ContentRevisionRecord): Promise<void> {
    this.writeCount += 1;
    this.contentRevisions.push(record);
  }

  async getCurrentContent(
    workspaceId: string,
  ): Promise<ContentRevisionRecord | null> {
    const records = this.contentRevisions.filter(
      (record) => record.workspaceId === workspaceId,
    );
    return records[records.length - 1] ?? null;
  }

  async saveLaneRevision(record: LaneRevisionRecord): Promise<void> {
    this.writeCount += 1;
    this.laneRevisions.push(record);
  }

  async saveMutation(request: MutationRequest): Promise<void> {
    this.writeCount += 1;
    this.mutations.push(request);
  }
}
