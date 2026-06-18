import type {
  ContentBuildCompleteRequest,
  IngestAck,
  IngestBatch,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

export interface WorkspaceCoordinatorRpc {
  ingest(batch: IngestBatch): Promise<IngestAck>;
  query(request: QueryRequest): Promise<QueryResponse>;
  mutate(request: MutationRequest): Promise<MutationResult>;
  buildComplete(request: ContentBuildCompleteRequest): Promise<MutationResult>;
  connectAgent(request: Request): Promise<Response>;
  connectBrowser(request: Request): Promise<Response>;
  fetch(request: Request): Promise<Response>;
}

export interface WorkspaceCoordinatorNamespace {
  getByName(workspaceId: string): WorkspaceCoordinatorRpc;
}

export interface CenterWorkerEnv {
  WORKSPACE_COORDINATOR: WorkspaceCoordinatorNamespace;
  LANEDECK_DB: D1Database;
  LANEDECK_BUCKET: R2Bucket;
  LANEDECK_AGENT_TOKEN?: string;
  LANEDECK_AI_MUTATION_TOKEN?: string;
  LANEDECK_READ_TOKEN?: string;
}
