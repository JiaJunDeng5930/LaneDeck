import type {
  ContentBuildArtifact,
  IngestBatch,
  JsonObject,
  MutationRequest,
} from "@lanedeck/protocol";

export interface ContentRevisionRecord {
  workspaceId: string;
  mutationId: string;
  mutationSequence: number;
  revision: string;
  sourcePath: string;
  contentPath: string;
  sourceKey: string;
  assetKey: string | null;
  createdAt: string;
  metadata: JsonObject;
}

export interface LaneRevisionRecord {
  workspaceId: string;
  mutationId: string;
  mutationSequence: number;
  laneId: string;
  revision: string;
  settings: JsonObject;
  createdAt: string;
}

export interface ContentBuildRequestRecord {
  workspaceId: string;
  buildRequestId: string;
  mutationId: string;
  machineId: string;
  contentId: string;
  contentRevision: string;
  cwd: string;
  command: string;
  createdAt: string;
  status: "pending" | "completed";
  completedAt: string | null;
}

export interface ContentObjectWrite {
  workspaceId: string;
  revision: string;
  sourcePath: string;
  source: string;
}

export interface ContentSourceObjectKeys {
  sourceKey: string;
}

export interface ContentBuildArtifactWrite {
  revision: string;
  entrypoint: string;
  artifacts: ContentBuildArtifact[];
}

export interface ContentBuildObjectKeys {
  entrypointKey: string;
  assetKeys: string[];
}

export interface ContentRevisionPromotion {
  workspaceId: string;
  revision: string;
  contentPath: string;
  assetKey: string;
  promotedAt: string;
  buildRequestId?: string;
}

export interface ContentRevisionPromotionResult {
  record: ContentRevisionRecord;
  isCurrent: boolean;
}

export interface ContentObjectStore {
  writeContentSource(
    write: ContentObjectWrite,
  ): Promise<ContentSourceObjectKeys>;
  writeContentBuildArtifacts(
    write: ContentBuildArtifactWrite,
  ): Promise<ContentBuildObjectKeys>;
}

export interface CenterStorage {
  initialize(): Promise<void>;
  saveIngestBatch(batch: IngestBatch, ingestedAt: string): Promise<void>;
  getCurrentState(workspaceId: string): Promise<JsonObject>;
  saveContentSourceRevision(record: ContentRevisionRecord): Promise<void>;
  getContentRevision(
    workspaceId: string,
    revision: string,
  ): Promise<ContentRevisionRecord | null>;
  promoteContentRevision(
    promotion: ContentRevisionPromotion,
  ): Promise<ContentRevisionPromotionResult>;
  getCurrentContent(workspaceId: string): Promise<ContentRevisionRecord | null>;
  saveContentBuildRequest(record: ContentBuildRequestRecord): Promise<void>;
  getContentBuildRequest(
    workspaceId: string,
    buildRequestId: string,
  ): Promise<ContentBuildRequestRecord | null>;
  saveLaneRevision(record: LaneRevisionRecord): Promise<boolean>;
  listCurrentLaneRevisions(workspaceId: string): Promise<LaneRevisionRecord[]>;
  saveMutation(request: MutationRequest, mutationId: string): Promise<number>;
}
