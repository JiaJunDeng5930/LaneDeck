import { DurableObject } from "cloudflare:workers";
import type {
  IngestAck,
  IngestBatch,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

import { ApiError, errorResponse } from "./errors";
import { LiveHub, restoreLiveSockets } from "./live";
import { handleRequest } from "./router";
import { D1CenterStorage } from "./storage/d1";
import { R2ContentStore } from "./storage/r2";
import { WorkspaceService } from "./workspace";

export class WorkspaceCoordinator extends DurableObject<Env> {
  private readonly live = new LiveHub();
  private readonly service: WorkspaceService;

  constructor(ctx: DurableObjectState, env: Env) {
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

  async mutate(request: MutationRequest): Promise<MutationResult> {
    return await this.service.mutate(request);
  }

  async connectAgent(request: Request): Promise<Response> {
    return this.openLiveSocket(request, "agent");
  }

  async connectBrowser(request: Request): Promise<Response> {
    return this.openLiveSocket(request, "browser");
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

  private openLiveSocket(
    request: Request,
    kind: "agent" | "browser",
  ): Response {
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
    this.ctx.acceptWebSocket(server, [kind]);

    if (kind === "agent") {
      this.live.addAgent(server);
    } else {
      this.live.addBrowser(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return await handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
