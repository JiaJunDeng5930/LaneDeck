import type {
  Diagnostic,
  JsonObject,
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResponse,
  ShellHostContentRoute,
} from "@lanedeck/protocol";

export interface CurrentContentDescriptor {
  workspaceId: string;
  revision: string;
  path: string;
  uri?: string;
  centerQueryUrl?: string;
  centerReadToken?: string;
  route?: ShellHostContentRoute;
}

export interface ProtocolDiagnosticRecord {
  source: "shell-content" | "live" | "content";
  diagnostics: Diagnostic[];
  receivedAt: string;
}

export interface CenterQueryAccess {
  queryUrl: string;
  readToken?: string;
}

interface CurrentContentDescriptorOptions extends CenterQueryAccess {
  contentBaseUrl?: string;
}

export interface CenterQueryClient {
  getCurrentContent(): Promise<CurrentContentDescriptor>;
  recordProtocolDiagnostic(record: ProtocolDiagnosticRecord): Promise<void>;
  getContentQueryAccess?(): CenterQueryAccess;
}

export interface CenterMutationClient {
  mutate(request: MutationRequest): Promise<MutationResult>;
  patchContent(
    workspaceId: string,
    payload: JsonObject,
  ): Promise<Extract<MutationResult, { mutation: "patch_content" }>>;
}

export interface BrowserLiveEvent {
  type: "content_changed";
  workspaceId: string;
  contentRevision: string;
  mutationId?: string;
}

export interface BrowserLiveHandlers {
  onEvent(event: BrowserLiveEvent): void;
  onDiagnostic?(diagnostics: Diagnostic[]): void;
  onError?(error: unknown): void;
}

export interface BrowserLiveConnection {
  close(): Promise<void> | void;
}

export interface BrowserLiveClient {
  connect(handlers: BrowserLiveHandlers): Promise<BrowserLiveConnection>;
}

export interface HttpCenterClientOptions {
  baseUrl: string;
  workspaceId: string;
  readToken?: string;
  contentBaseUrl?: string;
  fetch?: typeof fetch;
  reportProtocolDiagnostic?: (
    record: ProtocolDiagnosticRecord,
  ) => Promise<void> | void;
}

export interface HttpMutationClientOptions {
  baseUrl: string;
  mutationToken?: string;
  fetch?: typeof fetch;
}

export interface WebSocketLiveClientOptions {
  url: string;
  WebSocketCtor?: typeof WebSocket;
}

export interface BrowserDiagnosticReporterOptions {
  storage?: Storage;
  key?: string;
  limit?: number;
}

export class CenterClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function createHttpCenterClient(
  options: HttpCenterClientOptions,
): CenterQueryClient & {
  query(request: QueryRequest): Promise<QueryResponse>;
} {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const queryUrl = new URL("/api/query", baseUrl).toString();
  const reportProtocolDiagnostic =
    options.reportProtocolDiagnostic ?? (async () => undefined);

  async function query(request: QueryRequest): Promise<QueryResponse> {
    return postJson<QueryResponse>(
      fetcher,
      new URL(queryUrl),
      {
        workspaceId: request.workspaceId,
        query: request.query,
        params: request.params,
      },
      options.readToken,
    );
  }

  return {
    query,
    async getCurrentContent(): Promise<CurrentContentDescriptor> {
      const response = await query({
        workspaceId: options.workspaceId,
        query: "current_content",
        params: {},
      });
      const row = response.rows[0];
      if (row === undefined) {
        throw new CenterClientError("center returned no current content row");
      }
      return descriptorFromRow(options.workspaceId, row, {
        queryUrl,
        ...(options.contentBaseUrl === undefined ||
        options.contentBaseUrl.trim() === ""
          ? {}
          : { contentBaseUrl: options.contentBaseUrl }),
        ...(options.readToken === undefined || options.readToken.trim() === ""
          ? {}
          : { readToken: options.readToken }),
      });
    },
    async recordProtocolDiagnostic(
      record: ProtocolDiagnosticRecord,
    ): Promise<void> {
      await reportProtocolDiagnostic(record);
    },
    getContentQueryAccess(): CenterQueryAccess {
      return {
        queryUrl,
        ...(options.readToken === undefined || options.readToken.trim() === ""
          ? {}
          : { readToken: options.readToken }),
      };
    },
  };
}

export function createHttpMutationClient(
  options: HttpMutationClientOptions,
): CenterMutationClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return {
    async mutate(request: MutationRequest): Promise<MutationResult> {
      const result = await postJson<unknown>(
        fetcher,
        new URL("/api/ai/mutation", baseUrl),
        request,
        options.mutationToken,
      );
      return assertMutationResult(result);
    },
    async patchContent(
      workspaceId: string,
      payload: JsonObject,
    ): Promise<Extract<MutationResult, { mutation: "patch_content" }>> {
      const result = await this.mutate({
        workspaceId,
        mutation: "patch_content",
        payload,
      });
      if (result.mutation !== "patch_content") {
        throw new CenterClientError(
          "center returned a different mutation type",
        );
      }
      return result;
    },
  };
}

export function createWebSocketLiveClient(
  options: WebSocketLiveClientOptions,
): BrowserLiveClient {
  const WebSocketImpl = options.WebSocketCtor ?? globalThis.WebSocket;

  return {
    connect(handlers: BrowserLiveHandlers): Promise<BrowserLiveConnection> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocketImpl(options.url);
        let settled = false;

        socket.addEventListener(
          "open",
          () => {
            settled = true;
            resolve({
              close() {
                socket.close();
              },
            });
          },
          { once: true },
        );
        socket.addEventListener("message", (event) => {
          void decodeLiveMessage(event.data)
            .then((message) => handleLiveMessage(message, handlers))
            .catch((error: unknown) => {
              handlers.onDiagnostic?.([
                {
                  path: "$",
                  message: errorMessage(error),
                },
              ]);
            });
        });
        socket.addEventListener("error", (event) => {
          if (settled) {
            handlers.onError?.(event);
            return;
          }
          settled = true;
          reject(new CenterClientError("live connection failed"));
        });
      });
    },
  };
}

export function createBrowserDiagnosticReporter(
  options: BrowserDiagnosticReporterOptions = {},
): (record: ProtocolDiagnosticRecord) => Promise<void> {
  const storage = options.storage ?? globalThis.localStorage;
  const key = options.key ?? "lanedeck.shell.diagnostics";
  const limit = options.limit ?? 100;

  return async (record: ProtocolDiagnosticRecord): Promise<void> => {
    const current = readStoredDiagnostics(storage, key);
    current.push(record);
    storage.setItem(key, JSON.stringify(current.slice(-limit)));
  };
}

export function centerLiveUrl(
  baseUrl: string,
  workspaceId: string,
  readToken?: string,
): string {
  const url = new URL("/ws/browser", normalizeBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("workspaceId", workspaceId);
  if (readToken !== undefined && readToken.trim().length > 0) {
    url.searchParams.set("readToken", readToken);
  }
  return url.toString();
}

function descriptorFromRow(
  workspaceId: string,
  row: JsonObject,
  access?: CurrentContentDescriptorOptions,
): CurrentContentDescriptor {
  const revision = readAliasedString(row, [
    ["revision", "revision"],
    ["contentRevision", "contentRevision"],
  ]);
  const path =
    readAliasedOptionalString(row, [
      ["contentPath", "contentPath"],
      ["path", "path"],
    ]) ?? "index.html";
  const uri =
    readOptionalString(row.uri, "uri") ??
    contentUriFromBaseUrl(access?.contentBaseUrl, workspaceId, revision, path);
  return {
    workspaceId,
    revision,
    path,
    ...(uri === undefined ? {} : { uri }),
    ...(access === undefined
      ? {}
      : {
          centerQueryUrl: access.queryUrl,
          ...(access.readToken === undefined
            ? {}
            : { centerReadToken: access.readToken }),
        }),
  };
}

function contentUriFromBaseUrl(
  contentBaseUrl: string | undefined,
  workspaceId: string,
  revision: string,
  path: string,
): string | undefined {
  if (contentBaseUrl === undefined || contentBaseUrl.trim() === "") {
    return undefined;
  }
  const baseUrl = contentBaseUrl.trim();
  const contentPath = [workspaceId, revision, ...path.split("/")]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(contentPath, normalizeBaseUrl(baseUrl)).toString();
}

async function postJson<T>(
  fetcher: typeof fetch,
  url: URL,
  body: unknown,
  bearerToken?: string,
): Promise<T> {
  const response = await fetcher(url, {
    method: "POST",
    headers: jsonHeaders(bearerToken),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new CenterClientError(
      `center request failed with status ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

function jsonHeaders(bearerToken?: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearerToken !== undefined && bearerToken.trim().length > 0) {
    headers.set("authorization", `Bearer ${bearerToken}`);
  }
  return headers;
}

function normalizeBaseUrl(baseUrl: string): URL {
  return new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function readAliasedString(
  row: JsonObject,
  aliases: Array<[field: string, path: string]>,
): string {
  for (const [field, path] of aliases) {
    const value = row[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (value !== undefined) {
      throw new CenterClientError(`center row has invalid ${path}`);
    }
  }
  throw new CenterClientError(`center row is missing ${aliases[0]?.[1]}`);
}

function readOptionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input === "string" && input.length > 0) {
    return input;
  }
  throw new CenterClientError(`center row has invalid ${path}`);
}

function readAliasedOptionalString(
  row: JsonObject,
  aliases: Array<[field: string, path: string]>,
): string | undefined {
  for (const [field, path] of aliases) {
    const value = row[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    throw new CenterClientError(`center row has invalid ${path}`);
  }
  return undefined;
}

async function decodeLiveMessage(data: unknown): Promise<unknown> {
  if (typeof data === "string") {
    return JSON.parse(data) as unknown;
  }
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data)) as unknown;
  }
  if (data instanceof Blob) {
    return JSON.parse(await data.text()) as unknown;
  }
  return data;
}

function handleLiveMessage(
  message: unknown,
  handlers: BrowserLiveHandlers,
): void {
  if (!isJsonObject(message)) {
    handlers.onDiagnostic?.([
      { path: "$", message: "expected live event object" },
    ]);
    return;
  }
  if (
    message.type === "ingest_committed" ||
    message.type === "lane_settings_changed" ||
    message.type === "workspace_alarm"
  ) {
    return;
  }
  if (message.type !== "content_changed") {
    handlers.onDiagnostic?.([
      { path: "type", message: "expected content_changed" },
    ]);
    return;
  }
  if (typeof message.workspaceId !== "string") {
    handlers.onDiagnostic?.([
      { path: "workspaceId", message: "expected string" },
    ]);
    return;
  }
  if (typeof message.contentRevision !== "string") {
    handlers.onDiagnostic?.([
      { path: "contentRevision", message: "expected string" },
    ]);
    return;
  }
  if (
    message.mutationId !== undefined &&
    typeof message.mutationId !== "string"
  ) {
    handlers.onDiagnostic?.([
      { path: "mutationId", message: "expected string" },
    ]);
    return;
  }

  handlers.onEvent({
    type: "content_changed",
    workspaceId: message.workspaceId,
    contentRevision: message.contentRevision,
    ...(message.mutationId === undefined
      ? {}
      : { mutationId: message.mutationId }),
  });
}

function assertMutationResult(input: unknown): MutationResult {
  if (!isJsonObject(input)) {
    throw new CenterClientError("mutation response must be an object");
  }
  if (
    input.mutation === "patch_content" &&
    typeof input.mutationId === "string" &&
    typeof input.contentRevision === "string" &&
    Array.isArray(input.diagnostics)
  ) {
    return input as Extract<MutationResult, { mutation: "patch_content" }>;
  }
  if (
    input.mutation === "patch_lane_config" &&
    typeof input.mutationId === "string" &&
    typeof input.laneRevision === "string" &&
    Array.isArray(input.diagnostics)
  ) {
    return input as Extract<MutationResult, { mutation: "patch_lane_config" }>;
  }
  if (
    input.mutation === "request_local_build" &&
    typeof input.mutationId === "string" &&
    typeof input.buildRequestId === "string" &&
    Array.isArray(input.diagnostics)
  ) {
    return input as Extract<
      MutationResult,
      { mutation: "request_local_build" }
    >;
  }
  throw new CenterClientError("mutation response shape is invalid");
}

function readStoredDiagnostics(
  storage: Storage,
  key: string,
): ProtocolDiagnosticRecord[] {
  const stored = storage.getItem(key);
  if (stored === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? (parsed as ProtocolDiagnosticRecord[]) : [];
  } catch {
    return [];
  }
}

function isJsonObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "live message decode failed";
}
