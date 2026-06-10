import type {
  JsonObject,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

import { ContentError } from "./errors";

export interface CenterQueryClient {
  query(request: QueryRequest): Promise<QueryResponse>;
  setEndpoint?(endpoint: string): void;
}

export interface HttpCenterQueryClientOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}

export function createHttpCenterQueryClient(
  options: HttpCenterQueryClientOptions = {},
): CenterQueryClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let endpoint = normalizeEndpoint(options.endpoint);

  return {
    setEndpoint(nextEndpoint) {
      endpoint = normalizeEndpoint(nextEndpoint);
    },

    async query(request) {
      if (endpoint === undefined) {
        throw new ContentError("center query endpoint is missing");
      }

      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");

      const response = await fetchImpl(`${endpoint}/api/query`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new ContentError(
          `center query failed with status ${response.status}`,
        );
      }

      return parseQueryResponse(await response.json());
    },
  };
}

function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  return endpoint?.replace(/\/+$/, "");
}

export function dashboardQueryRequest(route: ContentRoute): QueryRequest {
  return {
    workspaceId: route.workspaceId,
    query: route.view === "dashboard" ? "dashboard" : route.query,
    params:
      route.view === "dashboard"
        ? dashboardParams(route)
        : (route.params ?? {}),
  };
}

function dashboardParams(route: DashboardContentRoute): JsonObject {
  return {
    ...(route.params ?? {}),
    ...(route.laneId === undefined ? {} : { laneId: route.laneId }),
  };
}

function parseQueryResponse(input: unknown): QueryResponse {
  if (!isRecord(input)) {
    throw new ContentError("center query response must be an object");
  }

  if (!Array.isArray(input.rows)) {
    throw new ContentError("center query response rows must be an array");
  }

  if (!Array.isArray(input.diagnostics)) {
    throw new ContentError(
      "center query response diagnostics must be an array",
    );
  }

  return {
    rows: input.rows.map((row, index) => parseJsonObject(row, `rows.${index}`)),
    diagnostics: input.diagnostics.map((diagnostic, index) => {
      if (!isRecord(diagnostic)) {
        throw new ContentError(`diagnostics.${index} must be an object`);
      }

      if (
        typeof diagnostic.path !== "string" ||
        typeof diagnostic.message !== "string"
      ) {
        throw new ContentError(
          `diagnostics.${index} must carry path and message`,
        );
      }

      return {
        path: diagnostic.path,
        message: diagnostic.message,
      };
    }),
  };
}

function parseJsonObject(input: unknown, path: string): JsonObject {
  if (!isRecord(input)) {
    throw new ContentError(`${path} must be an object`);
  }

  for (const [key, value] of Object.entries(input)) {
    assertJsonValue(value, `${path}.${key}`);
  }

  return input;
}

function assertJsonValue(input: unknown, path: string): void {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return;
  }

  if (typeof input === "number" && Number.isFinite(input)) {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item, index) => assertJsonValue(item, `${path}.${index}`));
    return;
  }

  if (isRecord(input)) {
    parseJsonObject(input, path);
    return;
  }

  throw new ContentError(`${path} must be JSON`);
}

function isRecord(input: unknown): input is JsonObject {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype
  );
}

export type ContentRoute = DashboardContentRoute | CustomContentRoute;

export interface DashboardContentRoute {
  view: "dashboard";
  workspaceId: string;
  laneId?: string;
  params?: JsonObject;
}

export interface CustomContentRoute {
  view: "custom";
  workspaceId: string;
  query: string;
  title?: string;
  params?: JsonObject;
}
