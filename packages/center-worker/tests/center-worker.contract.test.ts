import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors";
import { LiveHub, restoreLiveSockets, type LiveSocket } from "../src/live";
import { handleRequest } from "../src/router";
import { rewriteViteAssetReferences } from "../src/storage/r2";
import type {
  ContentBuildArtifactWrite,
  ContentBuildObjectKeys,
  ContentBuildRequestRecord,
  CenterStorage,
  ContentObjectStore,
  ContentObjectWrite,
  ContentRevisionPromotion,
  ContentRevisionPromotionResult,
  ContentRevisionRecord,
  ContentSourceObjectKeys,
  LaneRevisionRecord,
} from "../src/storage/types";
import { WorkspaceService } from "../src/workspace";
import type {
  IngestBatch,
  JsonObject,
  LaneConfig,
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

const validLaneConfig = {
  laneId: "lane.local",
  displayName: "Local lane",
  rawStage: {
    mode: "script",
    settings: { command: "collect", cwd: "/workspace" },
  },
  metricStage: {
    mode: "passthrough",
    settings: {},
  },
  eventStage: {
    mode: "passthrough",
    settings: {},
  },
} satisfies LaneConfig;

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

  it("ingest rejects duplicate frame identities before writes", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ingest",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          batchId: "batch-1",
          frames: [validFrame, { ...validFrame, summary: { duplicate: true } }],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_ingest_payload",
      diagnostics: [expect.objectContaining({ path: "frames.1" })],
    });
    expect(harness.storage.writeCount).toBe(0);
  });

  it("ingest rejects duplicate frame identities before coordinator RPC", async () => {
    let fetched = false;
    const response = await handleRequest(
      jsonRequest(
        "/api/ingest",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          batchId: "batch-1",
          frames: [validFrame, { ...validFrame, summary: { duplicate: true } }],
        },
        "agent-token",
      ),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => {
            fetched = true;
            return createHarness().env.WORKSPACE_COORDINATOR.getByName(
              "workspace.local",
            );
          },
        },
        LANEDECK_AGENT_TOKEN: "agent-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_ingest_payload",
      diagnostics: [expect.objectContaining({ path: "frames.1" })],
    });
    expect(fetched).toBe(false);
  });

  it("ingest rejects duplicate record ids within a frame before writes", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ingest",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          batchId: "batch-1",
          frames: [
            {
              ...validFrame,
              recordCount: 2,
              records: [
                validFrame.records[0],
                { ...validFrame.records[0], body: { duplicate: true } },
              ],
            },
          ],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_ingest_payload",
      diagnostics: [expect.objectContaining({ path: "frames.0.records.1.id" })],
    });
    expect(harness.storage.writeCount).toBe(0);
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
      jsonRequest(
        "/api/query",
        {
          workspaceId: "workspace.local",
          query: "current_state",
          params: {},
        },
        "read-token",
      ),
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
      jsonRequest(
        "/api/query",
        {
          workspaceId: "workspace.local",
          query: "current_state",
          params: {},
        },
        "read-token",
      ),
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

  it("POST /api/query rejects missing read token before coordinator fetch", async () => {
    let fetched = false;
    const response = await handleRequest(
      jsonRequest("/api/query", {
        workspaceId: "workspace.local",
        query: "current_state",
        params: {},
      }),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => {
            fetched = true;
            return createHarness().env.WORKSPACE_COORDINATOR.getByName(
              "workspace.local",
            );
          },
        },
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
        LANEDECK_READ_TOKEN: "read-token",
      },
    );

    expect(response.status).toBe(401);
    expect(fetched).toBe(false);
  });

  it("POST /api/ai/mutation writes content source to R2 and metadata to D1", async () => {
    const harness = createHarness();
    const browser = new RecordingSocket();
    harness.live.addBrowser(browser);
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
    expect(harness.objects.writes.has("content/id-2/index.html")).toBe(false);
    expect(harness.storage.contentRevisions).toEqual([
      expect.objectContaining({
        workspaceId: "workspace.local",
        mutationId: "id-1",
        revision: "id-2",
        sourcePath: "src/dashboard.tsx",
        contentPath: "index.html",
      }),
    ]);
    await expect(
      harness.storage.getCurrentContent("workspace.local"),
    ).resolves.toBeNull();
    expect(browser.decodedMessages()).toEqual([]);
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

  it("POST /api/ai/mutation rejects backslash object paths before coordinator fetch", async () => {
    let fetched = false;
    const response = await handleRequest(
      jsonRequest(
        "/api/ai/mutation",
        {
          workspaceId: "workspace.local",
          mutation: "patch_content",
          payload: {
            path: "src/dashboard.tsx",
            contentPath: "assets\\logo.svg",
            source: "<h1>bad path</h1>",
          },
        },
        "ai-token",
      ),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => {
            fetched = true;
            return createHarness().env.WORKSPACE_COORDINATOR.getByName(
              "workspace.local",
            );
          },
        },
        LANEDECK_AI_MUTATION_TOKEN: "ai-token",
        LANEDECK_AGENT_TOKEN: "agent-token",
        LANEDECK_READ_TOKEN: "read-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "payload.contentPath" })],
    });
    expect(fetched).toBe(false);
  });

  it("invalid local build mutation payload returns diagnostics without mutation log writes", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ai/mutation",
        {
          workspaceId: "workspace.local",
          mutation: "request_local_build",
          payload: { reason: "content_changed" },
        },
        "ai-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_mutation_payload",
      diagnostics: [expect.objectContaining({ path: "payload.machineId" })],
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
        "https://center.local/ws/browser?workspaceId=workspace.local&readToken=read-token",
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
        LANEDECK_READ_TOKEN: "read-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(204);
    expect(fetchedPath).toBe("/ws/browser");
  });

  it("browser WebSocket rejects missing read token before coordinator fetch", async () => {
    let fetched = false;
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
            fetch: async () => {
              fetched = true;
              return new Response(null, { status: 204 });
            },
          }),
        },
        LANEDECK_READ_TOKEN: "read-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(401);
    expect(fetched).toBe(false);
  });

  it("GET /api/content/current rejects missing read token before coordinator fetch", async () => {
    let fetched = false;
    const response = await handleRequest(
      new Request(
        "https://center.local/api/content/current?workspaceId=workspace.local",
      ),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => {
            fetched = true;
            return createHarness().env.WORKSPACE_COORDINATOR.getByName(
              "workspace.local",
            );
          },
        },
        LANEDECK_READ_TOKEN: "read-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(401);
    expect(fetched).toBe(false);
  });

  it("GET /content decodes browser-encoded asset path segments before R2 lookup", async () => {
    const harness = createHarness();
    const bucket = new RouteR2Bucket();
    bucket.putObject(
      "content/revision-1/assets/my logo.svg",
      "<svg></svg>",
      "image/svg+xml",
    );

    const response = await handleRequest(
      new Request(
        "https://center.local/content/revision-1/assets/my%20logo.svg",
      ),
      {
        ...harness.env,
        LANEDECK_BUCKET: bucket as unknown as R2Bucket,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<svg></svg>");
  });

  it("GET /content rejects encoded slash inside asset path segments", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      new Request(
        "https://center.local/content/revision-1/assets/my%2Flogo.svg",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_content_path",
      diagnostics: [expect.objectContaining({ path: "path" })],
    });
  });

  it("GET /content rejects encoded backslash inside asset path segments", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      new Request(
        "https://center.local/content/revision-1/assets/my%5Clogo.svg",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_content_path",
      diagnostics: [expect.objectContaining({ path: "path" })],
    });
  });

  it("GET /content rejects malformed encoded path segments", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      new Request("https://center.local/content/revision-1/assets/my%logo.svg"),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_content_path",
      diagnostics: [expect.objectContaining({ path: "path" })],
    });
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

  it("agent WebSocket rejects missing machine identity before coordinator fetch", async () => {
    let fetched = false;
    const response = await handleRequest(
      new Request("https://center.local/ws/agent?workspaceId=workspace.local", {
        method: "GET",
        headers: {
          authorization: "Bearer agent-token",
          upgrade: "websocket",
        },
      }),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => {
            fetched = true;
            return createHarness().env.WORKSPACE_COORDINATOR.getByName(
              "workspace.local",
            );
          },
        },
        LANEDECK_AI_MUTATION_TOKEN: "ai-token",
        LANEDECK_AGENT_TOKEN: "agent-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "missing_machine_id",
      diagnostics: [expect.objectContaining({ path: "machineId" })],
    });
    expect(fetched).toBe(false);
  });

  it("POST /api/content/build-complete promotes content and broadcasts content_changed", async () => {
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
    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "request_local_build",
      payload: {
        machineId: "machine.local",
        contentId: "content.home",
        contentRevision: "id-2",
        cwd: "/workspace/content",
        command: "corepack pnpm --filter @lanedeck/content build",
      },
    });

    const response = await handleRequest(
      jsonRequest(
        "/api/content/build-complete",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          buildRequestId: "id-4",
          contentRevision: "id-2",
          entrypoint: "index.html",
          artifacts: [
            {
              path: "index.html",
              body: '<div id="root"></div>',
              contentType: "text/html; charset=utf-8",
            },
            {
              path: "assets/index.js",
              body: "console.log('ok')",
              contentType: "text/javascript; charset=utf-8",
            },
          ],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contentRevision: "id-2",
      diagnostics: [],
    });
    expect(harness.objects.writes.get("content/id-2/index.html")).toBe(
      '<div id="root"></div>',
    );
    expect(harness.objects.writes.get("content/id-2/assets/index.js")).toBe(
      "console.log('ok')",
    );
    await expect(
      harness.storage.getCurrentContent("workspace.local"),
    ).resolves.toMatchObject({ revision: "id-2", contentPath: "index.html" });
    expect(browser.decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "content_changed",
        workspaceId: "workspace.local",
        mutationId: "id-1",
        contentRevision: "id-2",
      }),
    );
  });

  it("POST /api/content/build-complete rejects mismatched build identity before promotion", async () => {
    const harness = createHarness();
    const browser = new RecordingSocket();
    harness.live.addBrowser(browser);

    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "patch_content",
      payload: {
        path: "index.html",
        source: "<main>pending</main>",
      },
    });
    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "request_local_build",
      payload: {
        machineId: "machine.expected",
        contentId: "content.home",
        contentRevision: "id-2",
        cwd: "/workspace/content",
        command: "corepack pnpm --filter @lanedeck/content build",
      },
    });

    const response = await handleRequest(
      jsonRequest(
        "/api/content/build-complete",
        {
          workspaceId: "workspace.local",
          machineId: "machine.other",
          buildRequestId: "id-4",
          contentRevision: "id-2",
          entrypoint: "index.html",
          artifacts: [{ path: "index.html", body: "<main>built</main>" }],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_content_build_completion",
      diagnostics: [expect.objectContaining({ path: "machineId" })],
    });
    await expect(
      harness.storage.getCurrentContent("workspace.local"),
    ).resolves.toBeNull();
    expect(browser.decodedMessages()).toEqual([]);
  });

  it("POST /api/content/build-complete returns DO validation diagnostics as JSON", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/content/build-complete",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          buildRequestId: "missing-build",
          contentRevision: "revision-1",
          entrypoint: "index.html",
          artifacts: [{ path: "index.html", body: "<main>built</main>" }],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_content_build_completion",
      diagnostics: [expect.objectContaining({ path: "buildRequestId" })],
    });
  });

  it("POST /api/content/build-complete converts coordinator validation results to JSON errors", async () => {
    const response = await handleRequest(
      jsonRequest(
        "/api/content/build-complete",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          buildRequestId: "missing-build",
          contentRevision: "revision-1",
          entrypoint: "index.html",
          artifacts: [{ path: "index.html", body: "<main>built</main>" }],
        },
        "agent-token",
      ),
      {
        WORKSPACE_COORDINATOR: {
          getByName: () => ({
            buildComplete: async () => ({
              ok: false,
              error: {
                status: 400,
                code: "invalid_content_build_completion",
                diagnostics: [
                  {
                    path: "buildRequestId",
                    message: "expected existing content build request",
                  },
                ],
              },
            }),
          }),
        },
        LANEDECK_AI_MUTATION_TOKEN: "ai-token",
        LANEDECK_AGENT_TOKEN: "agent-token",
        LANEDECK_READ_TOKEN: "read-token",
        LANEDECK_DB: {},
        LANEDECK_BUCKET: {},
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_content_build_completion",
      diagnostics: [expect.objectContaining({ path: "buildRequestId" })],
    });
  });

  it("historical content build completion skips live broadcast and reports current diagnostic", async () => {
    const harness = createHarness(new SupersededStorage());
    const browser = new RecordingSocket();
    harness.live.addBrowser(browser);

    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "patch_content",
      payload: {
        path: "index.html",
        source: "<main>historical</main>",
      },
    });
    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "request_local_build",
      payload: {
        machineId: "machine.local",
        contentId: "content.home",
        contentRevision: "id-2",
        cwd: "/workspace/content",
        command: "corepack pnpm --filter @lanedeck/content build",
      },
    });

    const response = await handleRequest(
      jsonRequest(
        "/api/content/build-complete",
        {
          workspaceId: "workspace.local",
          machineId: "machine.local",
          buildRequestId: "id-4",
          contentRevision: "id-2",
          entrypoint: "index.html",
          artifacts: [{ path: "index.html", body: "<main>built</main>" }],
        },
        "agent-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mutation: "patch_content",
      mutationId: "id-1",
      contentRevision: "id-2",
      diagnostics: [
        {
          path: "currentContent",
          message: "superseded by newer mutation sequence",
        },
      ],
    });

    expect(browser.decodedMessages()).toEqual([]);
  });

  it("agent WSS receives build command when mutation requires local build", async () => {
    const harness = createHarness();
    const agent = new RecordingSocket();
    harness.live.addAgent(agent, "machine.devbox");
    const buildPayload = {
      machineId: "machine.devbox",
      contentId: "content.home",
      contentRevision: "revision-1",
      cwd: "/workspace/content",
      command: "corepack pnpm --filter @lanedeck/content build",
    };

    await expect(
      harness.workspace.mutate({
        workspaceId: "workspace.local",
        mutation: "request_local_build",
        payload: buildPayload,
      }),
    ).resolves.toEqual({
      mutation: "request_local_build",
      mutationId: "id-1",
      buildRequestId: "id-2",
      diagnostics: [],
    });

    expect(agent.decodedMessages()).toContainEqual({
      type: "build_content",
      messageId: "id-2",
      machineId: "machine.devbox",
      contentId: "content.home",
      contentRevision: "revision-1",
      cwd: "/workspace/content",
      command: "corepack pnpm --filter @lanedeck/content build",
    });
  });

  it("local build mutation reports empty agent delivery", async () => {
    const harness = createHarness();

    await expect(
      harness.workspace.mutate({
        workspaceId: "workspace.local",
        mutation: "request_local_build",
        payload: {
          machineId: "machine.devbox",
          contentId: "content.home",
          contentRevision: "revision-1",
          cwd: "/workspace/content",
          command: "corepack pnpm --filter @lanedeck/content build",
        },
      }),
    ).resolves.toEqual({
      mutation: "request_local_build",
      mutationId: "id-1",
      buildRequestId: "id-2",
      diagnostics: [
        {
          path: "agents",
          message: "no connected agent accepted build_content",
        },
      ],
    });
  });

  it("local build mutation sends a build command to the requested machine agent", async () => {
    const harness = createHarness();
    const firstAgent = new RecordingSocket();
    const secondAgent = new RecordingSocket();
    harness.live.addAgent(firstAgent, "machine.first");
    harness.live.addAgent(secondAgent, "machine.second");

    await expect(
      harness.workspace.mutate({
        workspaceId: "workspace.local",
        mutation: "request_local_build",
        payload: {
          machineId: "machine.second",
          contentId: "content.home",
          contentRevision: "revision-1",
          cwd: "/workspace/content",
          command: "corepack pnpm --filter @lanedeck/content build",
        },
      }),
    ).resolves.toMatchObject({
      mutation: "request_local_build",
      diagnostics: [],
    });

    expect(firstAgent.decodedMessages()).toEqual([]);
    expect(secondAgent.decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "build_content",
        machineId: "machine.second",
        contentRevision: "revision-1",
      }),
    );
  });

  it("lane config mutation stores revision and asks agents to reload", async () => {
    const harness = createHarness();
    const agent = new RecordingSocket();
    const browser = new RecordingSocket();
    harness.live.addAgent(agent);
    harness.live.addBrowser(browser);

    await expect(
      harness.workspace.mutate({
        workspaceId: "workspace.local",
        mutation: "patch_lane_config",
        payload: { config: validLaneConfig },
      }),
    ).resolves.toEqual({
      mutation: "patch_lane_config",
      mutationId: "id-1",
      laneRevision: "id-2",
      diagnostics: [],
    });

    expect(harness.storage.laneRevisions).toEqual([
      expect.objectContaining({
        workspaceId: "workspace.local",
        mutationId: "id-1",
        laneId: "lane.local",
        revision: "id-2",
        settings: validLaneConfig,
      }),
    ]);
    expect(browser.decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "lane_settings_changed",
        workspaceId: "workspace.local",
        mutationId: "id-1",
        laneId: "lane.local",
        laneRevision: "id-2",
      }),
    );
    expect(agent.decodedMessages()).toContainEqual({
      type: "reload_lane_config",
      messageId: "reload_lane_config:id-2",
      config: validLaneConfig,
    });
  });

  it("historical lane config mutation skips live and agent control side effects", async () => {
    const harness = createHarness(new SupersededStorage());
    const agent = new RecordingSocket();
    const browser = new RecordingSocket();
    harness.live.addAgent(agent);
    harness.live.addBrowser(browser);

    await expect(
      harness.workspace.mutate({
        workspaceId: "workspace.local",
        mutation: "patch_lane_config",
        payload: { config: validLaneConfig },
      }),
    ).resolves.toMatchObject({
      mutation: "patch_lane_config",
      mutationId: "id-1",
      laneRevision: "id-2",
      diagnostics: [
        {
          path: "currentLane",
          message: "superseded by newer mutation sequence",
        },
      ],
    });

    expect(browser.decodedMessages()).toEqual([]);
    expect(agent.decodedMessages()).toEqual([]);
  });

  it("lane config mutation reports empty agent delivery after saving revision", async () => {
    const harness = createHarness();

    await expect(
      harness.workspace.mutate({
        workspaceId: "workspace.local",
        mutation: "patch_lane_config",
        payload: { config: validLaneConfig },
      }),
    ).resolves.toEqual({
      mutation: "patch_lane_config",
      mutationId: "id-1",
      laneRevision: "id-2",
      diagnostics: [
        {
          path: "agents",
          message: "no connected agent accepted reload_lane_config",
        },
      ],
    });
    expect(harness.storage.laneRevisions).toHaveLength(1);
  });

  it("agent connect replay sends current lane configs with revision-stable control ids", async () => {
    const harness = createHarness();

    await harness.workspace.mutate({
      workspaceId: "workspace.local",
      mutation: "patch_lane_config",
      payload: { config: validLaneConfig },
    });

    const agent = new RecordingSocket();
    await expect(
      harness.workspace.replayCurrentLaneConfigs("workspace.local", agent),
    ).resolves.toBe(1);

    expect(agent.decodedMessages()).toContainEqual({
      type: "reload_lane_config",
      messageId: "reload_lane_config:id-2",
      config: validLaneConfig,
    });
  });

  it("lane config mutation validates current lane schema before mutation log writes", async () => {
    const harness = createHarness();
    const response = await handleRequest(
      jsonRequest(
        "/api/ai/mutation",
        {
          workspaceId: "workspace.local",
          mutation: "patch_lane_config",
          payload: {
            config: {
              laneId: "lane.local",
              rawStage: { mode: "passthrough", settings: {} },
              metricStage: { mode: "passthrough", settings: {} },
              eventStage: { mode: "passthrough", settings: {} },
            },
          },
        },
        "ai-token",
      ),
      harness.env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "protocol_validation_failed",
      diagnostics: [expect.objectContaining({ path: "displayName" })],
    });
    expect(harness.storage.mutations).toHaveLength(0);
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
      messageId: "build-1",
      contentId: "content.home",
      cwd: "/workspace/content",
      command: "corepack pnpm --filter @lanedeck/content build",
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

function createHarness(storage = new MemoryCenterStorage()) {
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
        buildComplete: async (
          request: Parameters<WorkspaceService["buildComplete"]>[0],
        ) => {
          try {
            return { ok: true, value: await workspace.buildComplete(request) };
          } catch (error) {
            if (error instanceof ApiError) {
              return {
                ok: false,
                error: {
                  status: error.status,
                  code: error.code,
                  diagnostics: error.diagnostics,
                },
              };
            }
            throw error;
          }
        },
        connectAgent: async () => new Response(null, { status: 204 }),
        connectBrowser: async () => new Response(null, { status: 204 }),
        fetch: async () => new Response(null, { status: 204 }),
      }),
    },
    LANEDECK_DB: {},
    LANEDECK_BUCKET: {},
    LANEDECK_AI_MUTATION_TOKEN: "ai-token",
    LANEDECK_AGENT_TOKEN: "agent-token",
    LANEDECK_READ_TOKEN: "read-token",
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

class RouteR2Bucket {
  private readonly objects = new Map<
    string,
    { body: string; contentType: string }
  >();

  putObject(key: string, body: string, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return null;
    }

    return {
      body: object.body,
      httpMetadata: { contentType: object.contentType },
      text: async () => object.body,
    } as unknown as R2ObjectBody;
  }
}

class MemoryContentObjectStore implements ContentObjectStore {
  readonly writes = new Map<string, string>();

  async writeContentSource(
    write: ContentObjectWrite,
  ): Promise<ContentSourceObjectKeys> {
    const sourceKey = [
      "content-source",
      write.workspaceId,
      write.revision,
      write.sourcePath,
    ].join("/");
    this.writes.set(sourceKey, write.source);
    return { sourceKey };
  }

  async writeContentBuildArtifacts(
    write: ContentBuildArtifactWrite,
  ): Promise<ContentBuildObjectKeys> {
    const assetKeys: string[] = [];
    let entrypointKey = "";
    for (const artifact of write.artifacts) {
      const key = ["content", write.revision, artifact.path].join("/");
      this.writes.set(key, artifact.body);
      assetKeys.push(key);
      if (artifact.path === write.entrypoint) {
        entrypointKey = key;
      }
    }
    return { entrypointKey, assetKeys };
  }
}

class MemoryCenterStorage implements CenterStorage {
  readonly batches: IngestBatch[] = [];
  readonly frames: IngestBatch["frames"] = [];
  readonly contentRevisions: ContentRevisionRecord[] = [];
  readonly contentBuildRequests: ContentBuildRequestRecord[] = [];
  readonly mutations: MutationRequest[] = [];
  readonly laneRevisions: LaneRevisionRecord[] = [];
  writeCount = 0;
  private mutationSequence = 0;
  protected currentContentRevision: string | null = null;

  async initialize(): Promise<void> {}

  async saveIngestBatch(batch: IngestBatch): Promise<void> {
    this.writeCount += 1;
    this.batches.push(batch);
    this.frames.push(...batch.frames);
  }

  async getCurrentState(workspaceId: string): Promise<JsonObject> {
    const currentContent =
      this.currentContentRevision === null
        ? null
        : (this.contentRevisions.find(
            (record) =>
              record.workspaceId === workspaceId &&
              record.revision === this.currentContentRevision,
          ) ?? null);
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

  async saveContentSourceRevision(
    record: ContentRevisionRecord,
  ): Promise<void> {
    this.writeCount += 1;
    this.contentRevisions.push(record);
  }

  async promoteContentRevision(
    promotion: ContentRevisionPromotion,
  ): Promise<ContentRevisionPromotionResult> {
    this.writeCount += 1;
    const record = this.contentRevisions.find(
      (candidate) =>
        candidate.workspaceId === promotion.workspaceId &&
        candidate.revision === promotion.revision,
    );
    if (record === undefined) {
      throw new Error("content revision was not found");
    }
    record.contentPath = promotion.contentPath;
    record.assetKey = promotion.assetKey;
    this.currentContentRevision = record.revision;
    return { record, isCurrent: true };
  }

  async getCurrentContent(
    workspaceId: string,
  ): Promise<ContentRevisionRecord | null> {
    if (this.currentContentRevision === null) {
      return null;
    }
    return (
      this.contentRevisions.find(
        (record) =>
          record.workspaceId === workspaceId &&
          record.revision === this.currentContentRevision,
      ) ?? null
    );
  }

  async saveContentBuildRequest(
    record: ContentBuildRequestRecord,
  ): Promise<void> {
    this.writeCount += 1;
    this.contentBuildRequests.push(record);
  }

  async getContentBuildRequest(
    workspaceId: string,
    buildRequestId: string,
  ): Promise<ContentBuildRequestRecord | null> {
    return (
      this.contentBuildRequests.find(
        (record) =>
          record.workspaceId === workspaceId &&
          record.buildRequestId === buildRequestId,
      ) ?? null
    );
  }

  async saveLaneRevision(record: LaneRevisionRecord): Promise<boolean> {
    this.writeCount += 1;
    this.laneRevisions.push(record);
    return (
      currentByMutationSequence(
        this.laneRevisions.filter(
          (candidate) =>
            candidate.workspaceId === record.workspaceId &&
            candidate.laneId === record.laneId,
        ),
      )?.revision === record.revision
    );
  }

  async listCurrentLaneRevisions(
    workspaceId: string,
  ): Promise<LaneRevisionRecord[]> {
    const byLane = new Map<string, LaneRevisionRecord>();
    for (const record of this.laneRevisions) {
      if (record.workspaceId !== workspaceId) {
        continue;
      }
      const current = byLane.get(record.laneId);
      if (
        current === undefined ||
        current.mutationSequence <= record.mutationSequence
      ) {
        byLane.set(record.laneId, record);
      }
    }
    return [...byLane.values()].sort((left, right) =>
      left.laneId.localeCompare(right.laneId),
    );
  }

  async saveMutation(request: MutationRequest): Promise<number> {
    this.writeCount += 1;
    this.mutationSequence += 1;
    this.mutations.push(request);
    return this.mutationSequence;
  }
}

class SupersededStorage extends MemoryCenterStorage {
  async promoteContentRevision(
    promotion: ContentRevisionPromotion,
  ): Promise<ContentRevisionPromotionResult> {
    const previousCurrent = this.currentContentRevision;
    const result = await super.promoteContentRevision(promotion);
    this.currentContentRevision = previousCurrent;
    return { ...result, isCurrent: false };
  }

  async saveLaneRevision(record: LaneRevisionRecord): Promise<boolean> {
    await super.saveLaneRevision(record);
    return false;
  }
}

function currentByMutationSequence<T extends { mutationSequence: number }>(
  records: T[],
): T | null {
  return records.reduce<T | null>(
    (current, record) =>
      current === null || current.mutationSequence <= record.mutationSequence
        ? record
        : current,
    null,
  );
}
