export const protocolPackage = "@lanedeck/protocol";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type StageKind = "raw" | "metric" | "event";
export type TriggerKind = "count" | "time";
export type StageMode = "script" | "passthrough" | "empty" | "builtin";

export interface FrameRecord {
  id: string;
  observedAt: string;
  body: JsonValue;
}

export interface Frame {
  laneId: string;
  stage: StageKind;
  frameNo: number;
  openedAt: string;
  closedAt: string;
  triggerKind: TriggerKind;
  recordCount: number;
  records: FrameRecord[];
  summary: JsonObject;
}

export interface Diagnostic {
  path: string;
  message: string;
}

export interface LaneConfig {
  laneId: string;
  displayName: string;
  rawStage: StageConfig;
  metricStage: StageConfig;
  eventStage: StageConfig;
}

export interface StageConfig {
  mode: StageMode;
  settings: JsonObject;
}

export interface StageHistory {
  upstreamFrames: Frame[];
  metricFrames: Frame[];
  eventFrames: Frame[];
}

export interface StageInvocation {
  currentFrame: Frame;
  history: StageHistory;
  lane: LaneConfig;
  now: string;
}

export interface StageResult {
  records: FrameRecord[];
  diagnostics: Diagnostic[];
}

export interface IngestBatch {
  workspaceId: string;
  machineId: string;
  batchId: string;
  frames: Frame[];
}

export interface IngestAck {
  batchId: string;
  acceptedFrameCount: number;
  diagnostics: Diagnostic[];
}

export interface QueryRequest {
  workspaceId: string;
  query: string;
  params: JsonObject;
}

export interface QueryResponse {
  rows: JsonObject[];
  diagnostics: Diagnostic[];
}

export interface MutationRequest {
  workspaceId: string;
  mutation: "patch_content" | "patch_lane_config" | "request_local_build";
  payload: JsonObject;
}

export interface MutationResult {
  mutationId: string;
  diagnostics: Diagnostic[];
}

export type ShellContentMessage =
  | {
      type: "ready";
      payload: JsonObject;
    }
  | {
      type: "pick_result";
      payload: { pickId: string };
    }
  | {
      type: "error_report";
      payload: { message: string; detail?: string };
    }
  | {
      type: "height_changed";
      payload: { height: number };
    };

export class ProtocolError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super("protocol validation failed");
  }
}

export function parseLaneConfig(_input: unknown): LaneConfig {
  throw unimplementedProtocolParser();
}

export function parseFrame(_input: unknown): Frame {
  throw unimplementedProtocolParser();
}

export function parseIngestBatch(_input: unknown): IngestBatch {
  throw unimplementedProtocolParser();
}

export function parseQueryRequest(_input: unknown): QueryRequest {
  throw unimplementedProtocolParser();
}

export function parseMutationRequest(_input: unknown): MutationRequest {
  throw unimplementedProtocolParser();
}

export function parseShellContentMessage(_input: unknown): ShellContentMessage {
  throw unimplementedProtocolParser();
}

function unimplementedProtocolParser(): ProtocolError {
  return new ProtocolError([
    {
      path: "$",
      message: "protocol parser is not implemented",
    },
  ]);
}
