import type {
  IngestAck,
  IngestBatch,
  JsonObject,
  JsonValue,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

import { badRequest } from "./errors";
import { LiveHub } from "./live";
import { contentRevisionToJson } from "./storage/d1";

import type { CenterStorage, ContentObjectStore } from "./storage/types";

export interface WorkspaceServiceOptions {
  storage: CenterStorage;
  contentStore: ContentObjectStore;
  live: LiveHub;
  clock?: () => string;
  idGenerator?: () => string;
}

export class WorkspaceService {
  private readonly clock: () => string;
  private readonly idGenerator: () => string;

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async initialize(): Promise<void> {
    await this.options.storage.initialize();
  }

  async ingest(batch: IngestBatch): Promise<IngestAck> {
    await this.options.storage.saveIngestBatch(batch, this.clock());
    const ack: IngestAck = {
      batchId: batch.batchId,
      acceptedFrameCount: batch.frames.length,
      diagnostics: [],
    };
    this.options.live.broadcastToBrowsers({
      type: "ingest_committed",
      workspaceId: batch.workspaceId,
      batchId: batch.batchId,
      acceptedFrameCount: batch.frames.length,
    });
    return ack;
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    if (request.query === "current_state") {
      return {
        rows: [await this.options.storage.getCurrentState(request.workspaceId)],
        diagnostics: [],
      };
    }

    if (request.query === "current_content") {
      const content = await this.options.storage.getCurrentContent(
        request.workspaceId,
      );
      return {
        rows: content === null ? [] : [contentRevisionToJson(content)],
        diagnostics: [],
      };
    }

    throw badRequest("unknown_query", "query", "expected supported query name");
  }

  async mutate(request: MutationRequest): Promise<MutationResult> {
    const mutationId = this.idGenerator();
    await this.options.storage.saveMutation(request, mutationId);

    if (request.mutation === "patch_content") {
      return await this.patchContent(request, mutationId);
    }

    if (request.mutation === "patch_lane_config") {
      return await this.patchLaneConfig(request, mutationId);
    }

    return await this.requestLocalBuild(request, mutationId);
  }

  async alarm(workspaceId: string): Promise<void> {
    const state = await this.options.storage.getCurrentState(workspaceId);
    this.options.live.broadcastToBrowsers({
      type: "workspace_alarm",
      workspaceId,
      state,
    });
  }

  private async patchContent(
    request: MutationRequest,
    mutationId: string,
  ): Promise<MutationResult> {
    const sourcePath = requiredString(request.payload, "path");
    const source = requiredString(request.payload, "source");
    const contentPath =
      optionalString(request.payload, "contentPath") ?? sourcePath;
    const metadata = optionalJsonObject(request.payload, "metadata") ?? {};
    const contentRevision = this.idGenerator();
    const createdAt = this.clock();
    const objectKeys = await this.options.contentStore.writeContentSource({
      workspaceId: request.workspaceId,
      revision: contentRevision,
      sourcePath,
      contentPath,
      source,
    });

    await this.options.storage.saveContentRevision({
      workspaceId: request.workspaceId,
      mutationId,
      revision: contentRevision,
      sourcePath,
      contentPath,
      sourceKey: objectKeys.sourceKey,
      assetKey: objectKeys.assetKey,
      createdAt,
      metadata,
    });

    this.options.live.broadcastToBrowsers({
      type: "content_changed",
      workspaceId: request.workspaceId,
      mutationId,
      contentRevision,
    });

    return {
      mutation: "patch_content",
      mutationId,
      contentRevision,
      diagnostics: [],
    };
  }

  private async patchLaneConfig(
    request: MutationRequest,
    mutationId: string,
  ): Promise<MutationResult> {
    const laneId = requiredString(request.payload, "laneId");
    const settings = requiredJsonObject(request.payload, "settings");
    const laneRevision = this.idGenerator();
    await this.options.storage.saveLaneRevision({
      workspaceId: request.workspaceId,
      mutationId,
      laneId,
      revision: laneRevision,
      settings,
      createdAt: this.clock(),
    });
    this.options.live.broadcastToBrowsers({
      type: "lane_settings_changed",
      workspaceId: request.workspaceId,
      mutationId,
      laneId,
      laneRevision,
    });
    return {
      mutation: "patch_lane_config",
      mutationId,
      laneRevision,
      diagnostics: [],
    };
  }

  private async requestLocalBuild(
    request: MutationRequest,
    mutationId: string,
  ): Promise<MutationResult> {
    const buildRequestId = this.idGenerator();
    this.options.live.sendToAgents({
      type: "build_content",
      workspaceId: request.workspaceId,
      mutationId,
      buildRequestId,
      payload: request.payload,
    });
    return {
      mutation: "request_local_build",
      mutationId,
      buildRequestId,
      diagnostics: [],
    };
  }
}

function requiredString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value === "string") {
    return value;
  }

  throw badRequest(
    "invalid_mutation_payload",
    `payload.${key}`,
    "expected string",
  );
}

function optionalString(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  throw badRequest(
    "invalid_mutation_payload",
    `payload.${key}`,
    "expected string",
  );
}

function requiredJsonObject(payload: JsonObject, key: string): JsonObject {
  const value = optionalJsonObject(payload, key);
  if (value !== null) {
    return value;
  }

  throw badRequest(
    "invalid_mutation_payload",
    `payload.${key}`,
    "expected object",
  );
}

function optionalJsonObject(
  payload: JsonObject,
  key: string,
): JsonObject | null {
  const value = payload[key];
  if (value === undefined) {
    return null;
  }

  if (isJsonObject(value)) {
    return value;
  }

  throw badRequest(
    "invalid_mutation_payload",
    `payload.${key}`,
    "expected object",
  );
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
