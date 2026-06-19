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

export type MutationResult =
  | {
      mutation: "patch_content";
      mutationId: string;
      contentRevision: string;
      diagnostics: Diagnostic[];
    }
  | {
      mutation: "patch_lane_config";
      mutationId: string;
      laneRevision: string;
      diagnostics: Diagnostic[];
    }
  | {
      mutation: "request_local_build";
      mutationId: string;
      buildRequestId: string;
      diagnostics: Diagnostic[];
    };

export interface ContentBuildArtifact {
  path: string;
  bodyBase64: string;
  contentType?: string;
}

export interface ContentBuildCompleteRequest {
  workspaceId: string;
  machineId: string;
  buildRequestId: string;
  contentId: string;
  contentRevision: string;
  entrypoint: string;
  artifacts: ContentBuildArtifact[];
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

export type ShellHostContentRoute =
  | {
      view: "dashboard";
      workspaceId: string;
      laneId?: string;
      params?: JsonObject;
    }
  | {
      view: "custom";
      workspaceId: string;
      query: string;
      title?: string;
      params?: JsonObject;
    };

export interface ShellHostState {
  pickerEnabled: boolean;
  workspaceId?: string;
  centerQueryUrl?: string;
  centerReadToken?: string;
  contentRevision?: string;
  route?: ShellHostContentRoute;
}

export type ShellHostMessage =
  | {
      type: "init";
      payload: {
        hostState: ShellHostState;
        route?: ShellHostContentRoute;
      };
    }
  | {
      type: "host_state";
      payload: {
        hostState: ShellHostState;
      };
    };

export type AgentControlMessage =
  | {
      type: "reload_lane_config";
      messageId: string;
      config: LaneConfig;
    }
  | {
      type: "build_content";
      messageId: string;
      machineId: string;
      contentId: string;
      contentRevision: string;
      cwd: string;
      command: string;
      sourcePath: string;
      source: string;
    }
  | {
      type: "apply_local_change";
      messageId: string;
      path: string;
      body: JsonValue;
    }
  | {
      type: "heartbeat";
      messageId: string;
    };

export class ProtocolError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super("protocol validation failed");
  }
}

export function parseLaneConfig(input: unknown): LaneConfig {
  const validator = new Validator();
  const lane = parseLaneConfigWithValidator(input, "$", validator);
  validator.finish();
  return lane;
}

export function parseFrame(input: unknown): Frame {
  const validator = new Validator();
  const frame = parseFrameWithValidator(input, "$", validator);
  validator.finish();
  return frame;
}

export function parseIngestBatch(input: unknown): IngestBatch {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const frames = validator
    .array(object.frames, "frames")
    .map((frame, index) =>
      parseFrameWithValidator(frame, `frames.${index}`, validator),
    );
  const batch: IngestBatch = {
    workspaceId: validator.string(object.workspaceId, "workspaceId"),
    machineId: validator.string(object.machineId, "machineId"),
    batchId: validator.string(object.batchId, "batchId"),
    frames,
  };
  validator.finish();
  return batch;
}

export function parseQueryRequest(input: unknown): QueryRequest {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const request: QueryRequest = {
    workspaceId: validator.string(object.workspaceId, "workspaceId"),
    query: validator.string(object.query, "query"),
    params: validator.jsonObject(object.params, "params"),
  };
  validator.finish();
  return request;
}

export function parseMutationRequest(input: unknown): MutationRequest {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const mutation = validator.oneOf(object.mutation, "mutation", [
    "patch_content",
    "patch_lane_config",
    "request_local_build",
  ] as const);
  const request: MutationRequest = {
    workspaceId: validator.string(object.workspaceId, "workspaceId"),
    mutation,
    payload: validator.jsonObject(object.payload, "payload"),
  };
  validator.finish();
  return request;
}

export function parseContentBuildCompleteRequest(
  input: unknown,
): ContentBuildCompleteRequest {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const artifacts = validator
    .array(object.artifacts, "artifacts")
    .map((artifact, index) =>
      parseContentBuildArtifact(artifact, `artifacts.${index}`, validator),
    );
  const request: ContentBuildCompleteRequest = {
    workspaceId: validator.string(object.workspaceId, "workspaceId"),
    machineId: validator.string(object.machineId, "machineId"),
    buildRequestId: validator.string(object.buildRequestId, "buildRequestId"),
    contentId: validator.string(object.contentId, "contentId"),
    contentRevision: validator.string(
      object.contentRevision,
      "contentRevision",
    ),
    entrypoint: validator.string(object.entrypoint, "entrypoint"),
    artifacts,
  };
  validator.finish();
  return request;
}

export function parseShellContentMessage(input: unknown): ShellContentMessage {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const type = validator.string(object.type, "type");
  const payload = validator.object(object.payload, "payload");

  if (type === "ready") {
    const message: ShellContentMessage = {
      type,
      payload: validator.jsonObject(payload, "payload"),
    };
    validator.finish();
    return message;
  }

  if (type === "pick_result") {
    const message: ShellContentMessage = {
      type,
      payload: { pickId: validator.string(payload.pickId, "payload.pickId") },
    };
    validator.finish();
    return message;
  }

  if (type === "error_report") {
    const message: ShellContentMessage = {
      type,
      payload: {
        message: validator.string(payload.message, "payload.message"),
        ...(payload.detail === undefined
          ? {}
          : { detail: validator.string(payload.detail, "payload.detail") }),
      },
    };
    validator.finish();
    return message;
  }

  if (type === "height_changed") {
    const message: ShellContentMessage = {
      type,
      payload: { height: validator.number(payload.height, "payload.height") },
    };
    validator.finish();
    return message;
  }

  validator.add(
    "type",
    "expected ready, pick_result, error_report, or height_changed",
  );
  validator.finish();
  throw new Error("unreachable");
}

export function parseShellHostMessage(input: unknown): ShellHostMessage {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const type = validator.string(object.type, "type");
  const payload = validator.object(object.payload, "payload");

  if (type === "init") {
    const message: ShellHostMessage = {
      type,
      payload: {
        hostState: parseShellHostStateWithValidator(
          payload.hostState,
          "payload.hostState",
          validator,
        ),
        ...(payload.route === undefined
          ? {}
          : {
              route: parseShellHostContentRouteWithValidator(
                payload.route,
                "payload.route",
                validator,
              ),
            }),
      },
    };
    validator.finish();
    return message;
  }

  if (type === "host_state") {
    const message: ShellHostMessage = {
      type,
      payload: {
        hostState: parseShellHostStateWithValidator(
          payload.hostState,
          "payload.hostState",
          validator,
        ),
      },
    };
    validator.finish();
    return message;
  }

  validator.add("type", "expected init or host_state");
  validator.finish();
  throw new Error("unreachable");
}

export function parseShellHostState(input: unknown): ShellHostState {
  const validator = new Validator();
  const state = parseShellHostStateWithValidator(input, "$", validator);
  validator.finish();
  return state;
}

export function parseShellHostContentRoute(
  input: unknown,
): ShellHostContentRoute {
  const validator = new Validator();
  const route = parseShellHostContentRouteWithValidator(input, "$", validator);
  validator.finish();
  return route;
}

export function parseAgentControlMessage(input: unknown): AgentControlMessage {
  const validator = new Validator();
  const object = validator.object(input, "$");
  const type = validator.string(object.type, "type");
  const messageId = validator.string(object.messageId, "messageId");

  if (type === "reload_lane_config") {
    const message: AgentControlMessage = {
      type,
      messageId,
      config: parseLaneConfigWithValidator(object.config, "config", validator),
    };
    validator.finish();
    return message;
  }

  if (type === "build_content") {
    const message: AgentControlMessage = {
      type,
      messageId,
      machineId: validator.string(object.machineId, "machineId"),
      contentId: validator.string(object.contentId, "contentId"),
      contentRevision: validator.string(
        object.contentRevision,
        "contentRevision",
      ),
      cwd: validator.string(object.cwd, "cwd"),
      command: validator.string(object.command, "command"),
      sourcePath: validator.string(object.sourcePath, "sourcePath"),
      source: validator.string(object.source, "source"),
    };
    validator.finish();
    return message;
  }

  if (type === "apply_local_change") {
    const message: AgentControlMessage = {
      type,
      messageId,
      path: validator.string(object.path, "path"),
      body: validator.jsonValue(object.body, "body"),
    };
    validator.finish();
    return message;
  }

  if (type === "heartbeat") {
    const message: AgentControlMessage = {
      type,
      messageId,
    };
    validator.finish();
    return message;
  }

  validator.add(
    "type",
    "expected reload_lane_config, build_content, apply_local_change, or heartbeat",
  );
  validator.finish();
  throw new Error("unreachable");
}

function parseContentBuildArtifact(
  input: unknown,
  path: string,
  validator: Validator,
): ContentBuildArtifact {
  const object = validator.object(input, path);
  return {
    path: validator.string(object.path, joinPath(path, "path")),
    bodyBase64: validator.string(
      object.bodyBase64,
      joinPath(path, "bodyBase64"),
    ),
    ...(object.contentType === undefined
      ? {}
      : {
          contentType: validator.string(
            object.contentType,
            joinPath(path, "contentType"),
          ),
        }),
  };
}

function parseShellHostStateWithValidator(
  input: unknown,
  path: string,
  validator: Validator,
): ShellHostState {
  const object = validator.object(input, path);
  return {
    pickerEnabled: booleanWithValidator(
      object.pickerEnabled,
      joinPath(path, "pickerEnabled"),
      validator,
    ),
    ...(object.workspaceId === undefined
      ? {}
      : {
          workspaceId: validator.string(
            object.workspaceId,
            joinPath(path, "workspaceId"),
          ),
        }),
    ...(object.centerQueryUrl === undefined
      ? {}
      : {
          centerQueryUrl: validator.string(
            object.centerQueryUrl,
            joinPath(path, "centerQueryUrl"),
          ),
        }),
    ...(object.centerReadToken === undefined
      ? {}
      : {
          centerReadToken: validator.string(
            object.centerReadToken,
            joinPath(path, "centerReadToken"),
          ),
        }),
    ...(object.contentRevision === undefined
      ? {}
      : {
          contentRevision: validator.string(
            object.contentRevision,
            joinPath(path, "contentRevision"),
          ),
        }),
    ...(object.route === undefined
      ? {}
      : {
          route: parseShellHostContentRouteWithValidator(
            object.route,
            joinPath(path, "route"),
            validator,
          ),
        }),
  };
}

function parseShellHostContentRouteWithValidator(
  input: unknown,
  path: string,
  validator: Validator,
): ShellHostContentRoute {
  const object = validator.object(input, path);
  const view = validator.string(object.view, joinPath(path, "view"));

  if (view === "dashboard") {
    return {
      view,
      workspaceId: validator.string(
        object.workspaceId,
        joinPath(path, "workspaceId"),
      ),
      ...(object.laneId === undefined
        ? {}
        : {
            laneId: validator.string(object.laneId, joinPath(path, "laneId")),
          }),
      ...(object.params === undefined
        ? {}
        : {
            params: validator.jsonObject(
              object.params,
              joinPath(path, "params"),
            ),
          }),
    };
  }

  if (view === "custom") {
    return {
      view,
      workspaceId: validator.string(
        object.workspaceId,
        joinPath(path, "workspaceId"),
      ),
      query: validator.string(object.query, joinPath(path, "query")),
      ...(object.title === undefined
        ? {}
        : {
            title: validator.string(object.title, joinPath(path, "title")),
          }),
      ...(object.params === undefined
        ? {}
        : {
            params: validator.jsonObject(
              object.params,
              joinPath(path, "params"),
            ),
          }),
    };
  }

  validator.add(joinPath(path, "view"), "expected dashboard or custom");
  return {
    view: "dashboard",
    workspaceId: "",
  };
}

function booleanWithValidator(
  input: unknown,
  path: string,
  validator: Validator,
): boolean {
  if (typeof input === "boolean") {
    return input;
  }
  validator.add(path, "expected boolean");
  return false;
}

function parseLaneConfigWithValidator(
  input: unknown,
  path: string,
  validator: Validator,
): LaneConfig {
  const object = validator.object(input, path);
  return {
    laneId: validator.string(object.laneId, joinPath(path, "laneId")),
    displayName: validator.string(
      object.displayName,
      joinPath(path, "displayName"),
    ),
    rawStage: parseStageConfig(
      object.rawStage,
      joinPath(path, "rawStage"),
      validator,
    ),
    metricStage: parseStageConfig(
      object.metricStage,
      joinPath(path, "metricStage"),
      validator,
    ),
    eventStage: parseStageConfig(
      object.eventStage,
      joinPath(path, "eventStage"),
      validator,
    ),
  };
}

function parseStageConfig(
  input: unknown,
  path: string,
  validator: Validator,
): StageConfig {
  const object = validator.object(input, path);
  return {
    mode: validator.oneOf(object.mode, `${path}.mode`, [
      "script",
      "passthrough",
      "empty",
      "builtin",
    ] as const),
    settings: validator.jsonObject(object.settings, `${path}.settings`),
  };
}

function parseFrameWithValidator(
  input: unknown,
  path: string,
  validator: Validator,
): Frame {
  const object = validator.object(input, path);
  const records = validator
    .array(object.records, joinPath(path, "records"))
    .map((record, index) =>
      parseFrameRecord(record, joinPath(path, `records.${index}`), validator),
    );
  const recordCount = validator.unsigned32(
    object.recordCount,
    joinPath(path, "recordCount"),
  );
  if (recordCount !== records.length) {
    validator.add(joinPath(path, "recordCount"), "expected records length");
  }

  return {
    laneId: validator.string(object.laneId, joinPath(path, "laneId")),
    stage: validator.oneOf(object.stage, joinPath(path, "stage"), [
      "raw",
      "metric",
      "event",
    ] as const),
    frameNo: validator.unsignedInteger(
      object.frameNo,
      joinPath(path, "frameNo"),
    ),
    openedAt: validator.timestamp(object.openedAt, joinPath(path, "openedAt")),
    closedAt: validator.timestamp(object.closedAt, joinPath(path, "closedAt")),
    triggerKind: validator.oneOf(
      object.triggerKind,
      joinPath(path, "triggerKind"),
      ["count", "time"] as const,
    ),
    recordCount,
    records,
    summary: validator.jsonObject(object.summary, joinPath(path, "summary")),
  };
}

function parseFrameRecord(
  input: unknown,
  path: string,
  validator: Validator,
): FrameRecord {
  const object = validator.object(input, path);
  return {
    id: validator.string(object.id, joinPath(path, "id")),
    observedAt: validator.timestamp(
      object.observedAt,
      joinPath(path, "observedAt"),
    ),
    body: validator.jsonValue(object.body, joinPath(path, "body")),
  };
}

function joinPath(parent: string, child: string): string {
  return parent === "$" ? child : `${parent}.${child}`;
}

class Validator {
  readonly diagnostics: Diagnostic[] = [];
  readonly activeJsonContainers = new WeakSet<object>();

  object(input: unknown, path: string): Record<string, unknown> {
    if (isPlainJsonObject(input)) {
      return input as Record<string, unknown>;
    }
    this.add(path, "expected object");
    return {};
  }

  jsonObject(input: unknown, path: string): JsonObject {
    const object = this.object(input, path);
    if (this.activeJsonContainers.has(object)) {
      this.add(path, "expected acyclic JSON object");
      return {};
    }
    this.activeJsonContainers.add(object);
    for (const [key, value] of Object.entries(object)) {
      this.jsonValue(value, joinPath(path, key));
    }
    this.activeJsonContainers.delete(object);
    return object as JsonObject;
  }

  jsonValue(input: unknown, path: string): JsonValue {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "number") {
      if (Number.isFinite(input)) {
        return input;
      }
      this.add(path, "expected finite JSON number");
      return null;
    }
    if (Array.isArray(input)) {
      if (this.activeJsonContainers.has(input)) {
        this.add(path, "expected acyclic JSON array");
        return [];
      }
      this.activeJsonContainers.add(input);
      const denseInput = this.array(input, path);
      const values = denseInput.map((item, index) =>
        this.jsonValue(item, `${path}.${index}`),
      );
      this.activeJsonContainers.delete(input);
      return values;
    }
    if (typeof input === "object") {
      return this.jsonObject(input, path);
    }
    this.add(path, "expected JSON value");
    return null;
  }

  string(input: unknown, path: string): string {
    if (typeof input === "string") {
      return input;
    }
    this.add(path, "expected string");
    return "";
  }

  number(input: unknown, path: string): number {
    if (typeof input === "number" && Number.isFinite(input)) {
      return input;
    }
    this.add(path, "expected number");
    return 0;
  }

  unsignedInteger(input: unknown, path: string): number {
    if (Number.isSafeInteger(input) && (input as number) >= 0) {
      return input as number;
    }
    this.add(path, "expected unsigned integer");
    return 0;
  }

  unsigned32(input: unknown, path: string): number {
    if (
      Number.isSafeInteger(input) &&
      (input as number) >= 0 &&
      (input as number) <= 0xffffffff
    ) {
      return input as number;
    }
    this.add(path, "expected unsigned 32-bit integer");
    return 0;
  }

  timestamp(input: unknown, path: string): string {
    const value = this.string(input, path);
    if (value !== "" && !isStrictRfc3339DateTime(value)) {
      this.add(path, "expected RFC 3339 timestamp");
    }
    return value;
  }

  array(input: unknown, path: string): unknown[] {
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index += 1) {
        if (!(index in input)) {
          this.add(`${path}.${index}`, "expected array element");
        }
      }
      return Array.from(input);
    }
    this.add(path, "expected array");
    return [];
  }

  oneOf<T extends string>(
    input: unknown,
    path: string,
    allowed: readonly T[],
  ): T {
    if (typeof input === "string" && allowed.includes(input as T)) {
      return input as T;
    }
    this.add(path, `expected one of ${allowed.join(", ")}`);
    return allowed[0];
  }

  add(path: string, message: string): void {
    this.diagnostics.push({ path, message });
  }

  finish(): void {
    if (this.diagnostics.length > 0) {
      throw new ProtocolError(this.diagnostics);
    }
  }
}

function isPlainJsonObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function isStrictRfc3339DateTime(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (match === null) {
    return false;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  if (offsetHourText !== undefined && offsetMinuteText !== undefined) {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
