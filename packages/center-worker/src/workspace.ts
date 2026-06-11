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
import { normalizeObjectPath } from "./storage/r2";

import type { CenterStorage, ContentObjectStore } from "./storage/types";

export interface WorkspaceServiceOptions {
  storage: CenterStorage;
  contentStore: ContentObjectStore;
  live: LiveHub;
  clock?: () => string;
  idGenerator?: () => string;
}

interface PatchContentPayload {
  sourcePath: string;
  contentPath: string;
  source: string;
  metadata: JsonObject;
}

interface PatchLaneConfigPayload {
  laneId: string;
  settings: JsonObject;
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

    if (request.mutation === "patch_content") {
      const payload = readPatchContentPayload(request.payload);
      await this.options.storage.saveMutation(request, mutationId);
      return await this.patchContent(request, mutationId, payload);
    }

    if (request.mutation === "patch_lane_config") {
      const payload = readPatchLaneConfigPayload(request.payload);
      await this.options.storage.saveMutation(request, mutationId);
      return await this.patchLaneConfig(request, mutationId, payload);
    }

    await this.options.storage.saveMutation(request, mutationId);
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
    payload: PatchContentPayload,
  ): Promise<MutationResult> {
    const contentRevision = this.idGenerator();
    const createdAt = this.clock();
    const objectKeys = await this.options.contentStore.writeContentSource({
      workspaceId: request.workspaceId,
      revision: contentRevision,
      sourcePath: payload.sourcePath,
      contentPath: payload.contentPath,
      source: payload.source,
    });

    await this.options.storage.saveContentRevision({
      workspaceId: request.workspaceId,
      mutationId,
      revision: contentRevision,
      sourcePath: payload.sourcePath,
      contentPath: payload.contentPath,
      sourceKey: objectKeys.sourceKey,
      assetKey: objectKeys.assetKey,
      createdAt,
      metadata: payload.metadata,
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
    payload: PatchLaneConfigPayload,
  ): Promise<MutationResult> {
    const laneRevision = this.idGenerator();
    await this.options.storage.saveLaneRevision({
      workspaceId: request.workspaceId,
      mutationId,
      laneId: payload.laneId,
      revision: laneRevision,
      settings: payload.settings,
      createdAt: this.clock(),
    });
    this.options.live.broadcastToBrowsers({
      type: "lane_settings_changed",
      workspaceId: request.workspaceId,
      mutationId,
      laneId: payload.laneId,
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

export function validateQueryRequestName(request: QueryRequest): void {
  if (
    request.query === "current_state" ||
    request.query === "current_content"
  ) {
    return;
  }

  throw badRequest("unknown_query", "query", "expected supported query name");
}

export function validateMutationRequestPayload(request: MutationRequest): void {
  if (request.mutation === "patch_content") {
    readPatchContentPayload(request.payload);
    return;
  }

  if (request.mutation === "patch_lane_config") {
    readPatchLaneConfigPayload(request.payload);
  }
}

function readPatchContentPayload(payload: JsonObject): PatchContentPayload {
  const sourcePath = normalizeObjectPath(
    requiredString(payload, "path"),
    "payload.path",
  );
  const contentPath = normalizeObjectPath(
    optionalString(payload, "contentPath") ?? sourcePath,
    "payload.contentPath",
  );
  return {
    sourcePath,
    contentPath,
    source: requiredString(payload, "source"),
    metadata: optionalJsonObject(payload, "metadata") ?? {},
  };
}

function readPatchLaneConfigPayload(
  payload: JsonObject,
): PatchLaneConfigPayload {
  return {
    laneId: requiredString(payload, "laneId"),
    settings: requiredJsonObject(payload, "settings"),
  };
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
