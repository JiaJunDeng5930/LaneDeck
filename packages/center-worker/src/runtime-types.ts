import type {
  ContentBuildCompleteRequest,
  Diagnostic,
  IngestAck,
  IngestBatch,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

export type WorkspaceRpcResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: {
        status: number;
        code: string;
        diagnostics: Diagnostic[];
      };
    };

export interface WorkspaceCoordinatorRpc {
  ingest(batch: IngestBatch): Promise<IngestAck>;
  query(request: QueryRequest): Promise<QueryResponse>;
  mutate(request: MutationRequest): Promise<WorkspaceRpcResult<MutationResult>>;
  buildComplete(
    request: ContentBuildCompleteRequest,
  ): Promise<WorkspaceRpcResult<MutationResult>>;
  connectAgent(request: Request): Promise<Response>;
  connectBrowser(request: Request): Promise<Response>;
  fetch(request: Request): Promise<Response>;
}

export interface WorkspaceCoordinatorNamespace {
  idFromName(workspaceId: string): DurableObjectId;
  get(id: DurableObjectId): WorkspaceCoordinatorRpc;
}

export interface CenterWorkerEnv {
  WORKSPACE_COORDINATOR: WorkspaceCoordinatorNamespace;
  LANEDECK_DB: D1Database;
  LANEDECK_BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  LANEDECK_AGENT_TOKEN?: string;
  LANEDECK_AI_MUTATION_TOKEN?: string;
  LANEDECK_READ_TOKEN?: string;
}
