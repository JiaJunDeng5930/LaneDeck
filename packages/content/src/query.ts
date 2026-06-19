import type {
  JsonObject,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";

import { ContentError } from "./errors";

export interface CenterQueryClient {
  query(request: QueryRequest): Promise<QueryResponse>;
  setQueryUrl?(queryUrl: string): void;
  setReadToken?(readToken: string | undefined): void;
}

export interface HttpCenterQueryClientOptions {
  queryUrl?: string;
  readToken?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}

export function createHttpCenterQueryClient(
  options: HttpCenterQueryClientOptions = {},
): CenterQueryClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let queryUrl = options.queryUrl;
  let readToken = options.readToken;

  return {
    setQueryUrl(nextQueryUrl) {
      queryUrl = nextQueryUrl;
    },

    setReadToken(nextReadToken) {
      readToken = nextReadToken;
    },

    async query(request) {
      if (queryUrl === undefined) {
        throw new ContentError("center query URL is missing");
      }

      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");
      if (readToken !== undefined && readToken.trim().length > 0) {
        headers.set("authorization", `Bearer ${readToken}`);
      }

      const response = await fetchImpl(queryUrl, {
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

export function dashboardQueryRequest(route: ContentRoute): QueryRequest {
  return {
    workspaceId: route.workspaceId,
    query: route.view === "dashboard" ? "current_state" : route.query,
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

  const rows = denseArray(input.rows, "rows");
  const diagnostics = denseArray(input.diagnostics, "diagnostics");

  return {
    rows: rows.map((row, index) =>
      parseJsonObject(row, `rows.${index}`, new WeakSet<object>()),
    ),
    diagnostics: diagnostics.map((diagnostic, index) => {
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

function denseArray(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new ContentError(`center query response ${path} must be an array`);
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!(index in input)) {
      throw new ContentError(`${path}.${index} must be JSON`);
    }
  }
  return Array.from(input);
}

function parseJsonObject(
  input: unknown,
  path: string,
  activeContainers: WeakSet<object>,
): JsonObject {
  if (!isRecord(input)) {
    throw new ContentError(`${path} must be an object`);
  }

  if (activeContainers.has(input)) {
    throw new ContentError(`${path} must be acyclic JSON`);
  }
  activeContainers.add(input);
  for (const [key, value] of Object.entries(input)) {
    assertJsonValue(value, `${path}.${key}`, activeContainers);
  }
  activeContainers.delete(input);

  return input;
}

function assertJsonValue(
  input: unknown,
  path: string,
  activeContainers: WeakSet<object>,
): void {
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
    if (activeContainers.has(input)) {
      throw new ContentError(`${path} must be acyclic JSON`);
    }
    activeContainers.add(input);
    const array = denseArray(input, path);
    array.forEach((item, index) =>
      assertJsonValue(item, `${path}.${index}`, activeContainers),
    );
    activeContainers.delete(input);
    return;
  }

  if (isRecord(input)) {
    parseJsonObject(input, path, activeContainers);
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
