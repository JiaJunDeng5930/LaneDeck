import type {
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
  assetKey: string;
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

export interface ContentObjectWrite {
  workspaceId: string;
  revision: string;
  sourcePath: string;
  contentPath: string;
  source: string;
}

export interface ContentObjectKeys {
  sourceKey: string;
  assetKey: string;
}

export interface ContentObjectStore {
  writeContentSource(write: ContentObjectWrite): Promise<ContentObjectKeys>;
}

export interface CenterStorage {
  initialize(): Promise<void>;
  saveIngestBatch(batch: IngestBatch, ingestedAt: string): Promise<void>;
  getCurrentState(workspaceId: string): Promise<JsonObject>;
  saveContentRevision(record: ContentRevisionRecord): Promise<boolean>;
  getCurrentContent(workspaceId: string): Promise<ContentRevisionRecord | null>;
  saveLaneRevision(record: LaneRevisionRecord): Promise<boolean>;
  listCurrentLaneRevisions(workspaceId: string): Promise<LaneRevisionRecord[]>;
  saveMutation(request: MutationRequest, mutationId: string): Promise<number>;
}
