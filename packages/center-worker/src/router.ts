import {
  ProtocolError,
  parseIngestBatch,
  parseMutationRequest,
  parseQueryRequest,
} from "@lanedeck/protocol";

import {
  ApiError,
  badRequest,
  errorResponse,
  jsonResponse,
  readJson,
} from "./errors";
import { R2ContentStore } from "./storage/r2";
import {
  validateMutationRequestPayload,
  validateQueryRequestName,
} from "./workspace";

import type { CenterWorkerEnv } from "./runtime-types";

export async function handleRequest(
  request: Request,
  env: CenterWorkerEnv,
): Promise<Response> {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    if (error instanceof ProtocolError) {
      return errorResponse(
        new ApiError(400, "protocol_validation_failed", error.diagnostics),
      );
    }

    return errorResponse(error);
  }
}

async function routeRequest(
  request: Request,
  env: CenterWorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/ingest") {
    requireBearerToken(request, env.LANEDECK_AGENT_TOKEN);
    const batch = parseIngestBatch(await readJson(request));
    return jsonResponse(await workspace(env, batch.workspaceId).ingest(batch));
  }

  if (request.method === "POST" && url.pathname === "/api/query") {
    requireBearerToken(request, env.LANEDECK_READ_TOKEN);
    const query = parseQueryRequest(await readJson(request));
    validateQueryRequestName(query);
    return jsonResponse(await workspace(env, query.workspaceId).query(query));
  }

  if (request.method === "POST" && url.pathname === "/api/ai/mutation") {
    requireBearerToken(request, env.LANEDECK_AI_MUTATION_TOKEN);
    const mutation = parseMutationRequest(await readJson(request));
    validateMutationRequestPayload(mutation);
    return jsonResponse(
      await workspace(env, mutation.workspaceId).mutate(mutation),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/content/current") {
    requireBearerToken(request, env.LANEDECK_READ_TOKEN);
    const workspaceId = requiredWorkspaceId(url);
    return jsonResponse(
      await workspace(env, workspaceId).query({
        workspaceId,
        query: "current_content",
        params: {},
      }),
    );
  }

  if (request.method === "GET" && url.pathname.startsWith("/content/")) {
    return await readContentAsset(url, env);
  }

  if (request.method === "GET" && url.pathname === "/ws/agent") {
    ensureWebSocketUpgrade(request);
    requireBearerToken(request, env.LANEDECK_AGENT_TOKEN);
    return await workspace(env, requiredWorkspaceId(url)).fetch(request);
  }

  if (request.method === "GET" && url.pathname === "/ws/browser") {
    ensureWebSocketUpgrade(request);
    requireBrowserReadToken(request, url, env.LANEDECK_READ_TOKEN);
    return await workspace(env, requiredWorkspaceId(url)).fetch(request);
  }

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
    return errorResponse(
      new ApiError(404, "route_not_found", [
        { path: "path", message: "expected supported API or WebSocket route" },
      ]),
    );
  }

  if (request.method === "GET") {
    return new Response("<!doctype html><title>LaneDeck</title>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return errorResponse(
    new ApiError(405, "method_not_allowed", [
      { path: "method", message: "expected supported LaneDeck route method" },
    ]),
  );
}

async function readContentAsset(
  url: URL,
  env: CenterWorkerEnv,
): Promise<Response> {
  const [, , revision, ...assetParts] = url.pathname.split("/");
  if (revision === undefined || assetParts.length === 0) {
    throw badRequest(
      "invalid_content_path",
      "path",
      "expected content revision and asset path",
    );
  }

  const response = await new R2ContentStore(
    env.LANEDECK_BUCKET,
  ).readContentAsset(revision, assetParts.join("/"));

  if (response === null) {
    return errorResponse(
      new ApiError(404, "content_not_found", [
        { path: "path", message: "content asset was not found" },
      ]),
    );
  }

  return response;
}

function workspace(env: CenterWorkerEnv, workspaceId: string) {
  return env.WORKSPACE_COORDINATOR.getByName(workspaceId);
}

function requireBearerToken(
  request: Request,
  expectedToken: string | undefined,
): void {
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new ApiError(500, "authentication_not_configured", [
      {
        path: "authorization",
        message: "expected configured bearer token",
      },
    ]);
  }

  if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    throw new ApiError(401, "authentication_failed", [
      {
        path: "authorization",
        message: "expected valid bearer token",
      },
    ]);
  }
}

function requireBrowserReadToken(
  request: Request,
  url: URL,
  expectedToken: string | undefined,
): void {
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new ApiError(500, "authentication_not_configured", [
      {
        path: "authorization",
        message: "expected configured bearer token",
      },
    ]);
  }

  if (
    request.headers.get("authorization") === `Bearer ${expectedToken}` ||
    url.searchParams.get("readToken") === expectedToken
  ) {
    return;
  }

  throw new ApiError(401, "authentication_failed", [
    {
      path: "authorization",
      message: "expected valid bearer token",
    },
  ]);
}

function requiredWorkspaceId(url: URL): string {
  const workspaceId = url.searchParams.get("workspaceId");
  if (workspaceId !== null && workspaceId.length > 0) {
    return workspaceId;
  }

  throw badRequest(
    "missing_workspace_id",
    "workspaceId",
    "expected workspaceId query parameter",
  );
}

function ensureWebSocketUpgrade(request: Request): void {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return;
  }

  throw new ApiError(426, "upgrade_required", [
    { path: "headers.upgrade", message: "expected websocket upgrade" },
  ]);
}
