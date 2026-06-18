import { parseLaneConfig } from "@lanedeck/protocol";
import type {
  Diagnostic,
  IngestAck,
  IngestBatch,
  JsonObject,
  JsonValue,
  LaneConfig,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

import { ApiError, badRequest } from "./errors";
import { LiveHub, type LiveSocket } from "./live";
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
  config: LaneConfig;
}

interface LocalBuildPayload {
  contentId: string;
  cwd: string;
  command: string;
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
    validateIngestIdentity(batch);
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
      const mutationSequence = await this.options.storage.saveMutation(
        request,
        mutationId,
      );
      return await this.patchContent(
        request,
        mutationId,
        mutationSequence,
        payload,
      );
    }

    if (request.mutation === "patch_lane_config") {
      const payload = readPatchLaneConfigPayload(request.payload);
      const mutationSequence = await this.options.storage.saveMutation(
        request,
        mutationId,
      );
      return await this.patchLaneConfig(
        request,
        mutationId,
        mutationSequence,
        payload,
      );
    }

    const payload = readLocalBuildPayload(request.payload);
    await this.options.storage.saveMutation(request, mutationId);
    return await this.requestLocalBuild(mutationId, payload);
  }

  async alarm(workspaceId: string): Promise<void> {
    const state = await this.options.storage.getCurrentState(workspaceId);
    this.options.live.broadcastToBrowsers({
      type: "workspace_alarm",
      workspaceId,
      state,
    });
  }

  async replayCurrentLaneConfigs(
    workspaceId: string,
    socket: LiveSocket,
  ): Promise<number> {
    const lanes =
      await this.options.storage.listCurrentLaneRevisions(workspaceId);
    let delivered = 0;

    for (const lane of lanes) {
      delivered += this.options.live.sendToAgent(socket, {
        type: "reload_lane_config",
        messageId: laneReloadControlMessageId(lane.revision),
        config: parseLaneConfig(lane.settings),
      });
    }

    return delivered;
  }

  private async patchContent(
    request: MutationRequest,
    mutationId: string,
    mutationSequence: number,
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

    const isCurrent = await this.options.storage.saveContentRevision({
      workspaceId: request.workspaceId,
      mutationId,
      mutationSequence,
      revision: contentRevision,
      sourcePath: payload.sourcePath,
      contentPath: payload.contentPath,
      sourceKey: objectKeys.sourceKey,
      assetKey: objectKeys.assetKey,
      createdAt,
      metadata: payload.metadata,
    });

    if (isCurrent) {
      this.options.live.broadcastToBrowsers({
        type: "content_changed",
        workspaceId: request.workspaceId,
        mutationId,
        contentRevision,
      });
    }

    return {
      mutation: "patch_content",
      mutationId,
      contentRevision,
      diagnostics: supersededDiagnostics(isCurrent, "currentContent"),
    };
  }

  private async patchLaneConfig(
    request: MutationRequest,
    mutationId: string,
    mutationSequence: number,
    payload: PatchLaneConfigPayload,
  ): Promise<MutationResult> {
    const laneRevision = this.idGenerator();
    const isCurrent = await this.options.storage.saveLaneRevision({
      workspaceId: request.workspaceId,
      mutationId,
      mutationSequence,
      laneId: payload.config.laneId,
      revision: laneRevision,
      settings: jsonObjectFromLaneConfig(payload.config),
      createdAt: this.clock(),
    });
    if (!isCurrent) {
      return {
        mutation: "patch_lane_config",
        mutationId,
        laneRevision,
        diagnostics: supersededDiagnostics(isCurrent, "currentLane"),
      };
    }

    this.options.live.broadcastToBrowsers({
      type: "lane_settings_changed",
      workspaceId: request.workspaceId,
      mutationId,
      laneId: payload.config.laneId,
      laneRevision,
    });
    const delivered = this.options.live.sendToAgents({
      type: "reload_lane_config",
      messageId: laneReloadControlMessageId(laneRevision),
      config: payload.config,
    });
    return {
      mutation: "patch_lane_config",
      mutationId,
      laneRevision,
      diagnostics: deliveryDiagnostics(delivered, "reload_lane_config"),
    };
  }

  private async requestLocalBuild(
    mutationId: string,
    payload: LocalBuildPayload,
  ): Promise<MutationResult> {
    const buildRequestId = this.idGenerator();
    const delivered = this.options.live.sendToOneAgent({
      type: "build_content",
      messageId: buildRequestId,
      contentId: payload.contentId,
      cwd: payload.cwd,
      command: payload.command,
    });
    return {
      mutation: "request_local_build",
      mutationId,
      buildRequestId,
      diagnostics: deliveryDiagnostics(delivered, "build_content"),
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
    return;
  }

  readLocalBuildPayload(request.payload);
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

function validateIngestIdentity(batch: IngestBatch): void {
  const diagnostics: Diagnostic[] = [];
  const frameIdentities = new Set<string>();

  batch.frames.forEach((frame, frameIndex) => {
    const frameIdentity = [
      frame.laneId,
      frame.stage,
      frame.frameNo.toString(),
    ].join("\u0000");
    if (frameIdentities.has(frameIdentity)) {
      diagnostics.push({
        path: `frames.${frameIndex}`,
        message: "expected unique laneId, stage, and frameNo within batch",
      });
    } else {
      frameIdentities.add(frameIdentity);
    }

    const recordIds = new Set<string>();
    frame.records.forEach((record, recordIndex) => {
      if (recordIds.has(record.id)) {
        diagnostics.push({
          path: `frames.${frameIndex}.records.${recordIndex}.id`,
          message: "expected unique record id within frame",
        });
      } else {
        recordIds.add(record.id);
      }
    });
  });

  if (diagnostics.length > 0) {
    throw new ApiError(400, "invalid_ingest_payload", diagnostics);
  }
}

function readPatchLaneConfigPayload(
  payload: JsonObject,
): PatchLaneConfigPayload {
  return {
    config: parseLaneConfig(requiredJsonObject(payload, "config")),
  };
}

function readLocalBuildPayload(payload: JsonObject): LocalBuildPayload {
  return {
    contentId: requiredString(payload, "contentId"),
    cwd: requiredString(payload, "cwd"),
    command: requiredString(payload, "command"),
  };
}

function deliveryDiagnostics(
  delivered: number,
  messageType: string,
): Diagnostic[] {
  if (delivered > 0) {
    return [];
  }

  return [
    {
      path: "agents",
      message: `no connected agent accepted ${messageType}`,
    },
  ];
}

function supersededDiagnostics(isCurrent: boolean, path: string): Diagnostic[] {
  if (isCurrent) {
    return [];
  }

  return [
    {
      path,
      message: "superseded by newer mutation sequence",
    },
  ];
}

function laneReloadControlMessageId(laneRevision: string): string {
  return `reload_lane_config:${laneRevision}`;
}

function jsonObjectFromLaneConfig(config: LaneConfig): JsonObject {
  return config as unknown as JsonObject;
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
