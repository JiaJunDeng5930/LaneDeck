import { DurableObject } from "cloudflare:workers";
import type {
  IngestAck,
  IngestBatch,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
  ContentBuildCompleteRequest,
} from "@lanedeck/protocol";

import { ApiError, errorResponse } from "./errors";
import { LiveHub, restoreLiveSockets } from "./live";
import { handleRequest } from "./router";
import { D1CenterStorage } from "./storage/d1";
import { R2ContentStore } from "./storage/r2";
import { WorkspaceService } from "./workspace";
import type { CenterWorkerEnv, WorkspaceRpcResult } from "./runtime-types";

export class WorkspaceCoordinator extends DurableObject<CenterWorkerEnv> {
  private readonly live = new LiveHub();
  private readonly service: WorkspaceService;

  constructor(ctx: DurableObjectState, env: CenterWorkerEnv) {
    super(ctx, env);
    restoreLiveSockets(
      this.live,
      ctx.getWebSockets("agent"),
      ctx.getWebSockets("browser"),
    );
    this.service = new WorkspaceService({
      storage: new D1CenterStorage(env.LANEDECK_DB),
      contentStore: new R2ContentStore(env.LANEDECK_BUCKET),
      live: this.live,
    });
    ctx.blockConcurrencyWhile(async () => {
      await this.service.initialize();
    });
  }

  async ingest(batch: IngestBatch): Promise<IngestAck> {
    return await this.service.ingest(batch);
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    return await this.service.query(request);
  }

  async mutate(
    request: MutationRequest,
  ): Promise<WorkspaceRpcResult<MutationResult>> {
    return await rpcResult(() => this.service.mutate(request));
  }

  async buildComplete(
    request: ContentBuildCompleteRequest,
  ): Promise<WorkspaceRpcResult<MutationResult>> {
    return await rpcResult(() => this.service.buildComplete(request));
  }

  async connectAgent(request: Request): Promise<Response> {
    return await this.openLiveSocket(request, "agent");
  }

  async connectBrowser(request: Request): Promise<Response> {
    return await this.openLiveSocket(request, "browser");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws/agent") {
      return await this.openLiveSocket(request, "agent");
    }

    if (url.pathname === "/ws/browser") {
      return await this.openLiveSocket(request, "browser");
    }

    return errorResponse(
      new ApiError(404, "route_not_found", [
        { path: "path", message: "expected workspace WebSocket route" },
      ]),
    );
  }

  async alarm(): Promise<void> {
    await this.service.alarm(this.ctx.id.name ?? "workspace");
  }

  webSocketClose(ws: WebSocket): void {
    this.live.remove(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.live.remove(ws);
  }

  private async openLiveSocket(
    request: Request,
    kind: "agent" | "browser",
  ): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(
        new ApiError(426, "upgrade_required", [
          { path: "headers.upgrade", message: "expected websocket upgrade" },
        ]),
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const machineId = kind === "agent" ? this.machineIdForRequest(request) : "";
    server.serializeAttachment({ kind, machineId });
    this.ctx.acceptWebSocket(
      server,
      kind === "agent" ? [kind, `machine:${machineId}`] : [kind],
    );

    if (kind === "agent") {
      this.live.addAgent(server, machineId);
      await this.service.replayCurrentLaneConfigs(
        this.workspaceIdForRequest(request),
        server,
      );
    } else {
      this.live.addBrowser(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private workspaceIdForRequest(request: Request): string {
    return (
      new URL(request.url).searchParams.get("workspaceId") ??
      this.ctx.id.name ??
      "workspace"
    );
  }

  private machineIdForRequest(request: Request): string {
    const machineId = new URL(request.url).searchParams.get("machineId");
    if (machineId !== null && machineId.length > 0) {
      return machineId;
    }

    throw new ApiError(400, "missing_machine_id", [
      { path: "machineId", message: "expected machineId query parameter" },
    ]);
  }
}

export default {
  async fetch(
    request: Request,
    env: CenterWorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return await handleRequest(request, env);
  },
} satisfies ExportedHandler<CenterWorkerEnv>;

async function rpcResult<T>(
  operation: () => Promise<T>,
): Promise<WorkspaceRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
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
}
