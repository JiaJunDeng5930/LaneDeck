import type {
  JsonObject,
  QueryRequest,
  QueryResponse,
} from "@lanedeck/protocol";
import { ProtocolError, parseQueryResponse } from "@lanedeck/protocol";

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

      try {
        return parseQueryResponse(await response.json());
      } catch (error) {
        if (error instanceof ProtocolError) {
          throw new ContentError(
            "center query response is invalid",
            JSON.stringify(error.diagnostics),
          );
        }
        throw error;
      }
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
