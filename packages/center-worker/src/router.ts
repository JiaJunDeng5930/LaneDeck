import {
  ProtocolError,
  parseContentBuildCompleteRequest,
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
  validateIngestIdentity,
  validateMutationRequestPayload,
  validateQueryRequestName,
} from "./workspace";

import type { CenterWorkerEnv, WorkspaceRpcResult } from "./runtime-types";

export async function handleRequest(
  request: Request,
  env: CenterWorkerEnv,
): Promise<Response> {
  if (request.method === "OPTIONS" && isCorsRoute(request)) {
    return corsPreflightResponse(request);
  }

  try {
    return withCorsHeaders(request, await routeRequest(request, env));
  } catch (error) {
    if (error instanceof ProtocolError) {
      return withCorsHeaders(
        request,
        errorResponse(
          new ApiError(400, "protocol_validation_failed", error.diagnostics),
        ),
      );
    }

    return withCorsHeaders(request, errorResponse(error));
  }
}

function isCorsRoute(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.startsWith("/api/") || pathname.startsWith("/content/");
}

function corsPreflightResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function withCorsHeaders(request: Request, response: Response): Response {
  if (!isCorsRoute(request)) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request: Request): Headers {
  const requestedHeaders =
    request.headers.get("access-control-request-headers") ??
    "authorization, content-type";
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": requestedHeaders,
    "access-control-max-age": "600",
    vary: "Origin, Access-Control-Request-Headers",
  });
}

async function routeRequest(
  request: Request,
  env: CenterWorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/ingest") {
    await requireBearerToken(request, env.LANEDECK_AGENT_TOKEN);
    const batch = parseIngestBatch(await readJson(request));
    validateIngestIdentity(batch);
    return jsonResponse(await workspace(env, batch.workspaceId).ingest(batch));
  }

  if (request.method === "POST" && url.pathname === "/api/query") {
    await requireBearerToken(request, env.LANEDECK_READ_TOKEN);
    const query = parseQueryRequest(await readJson(request));
    validateQueryRequestName(query);
    return jsonResponse(await workspace(env, query.workspaceId).query(query));
  }

  if (request.method === "POST" && url.pathname === "/api/ai/mutation") {
    await requireBearerToken(request, env.LANEDECK_AI_MUTATION_TOKEN);
    const mutation = parseMutationRequest(await readJson(request));
    validateMutationRequestPayload(mutation);
    return jsonResponse(
      unwrapWorkspaceRpcResult(
        await workspace(env, mutation.workspaceId).mutate(mutation),
      ),
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/content/build-complete"
  ) {
    await requireBearerToken(request, env.LANEDECK_AGENT_TOKEN);
    const completion = parseContentBuildCompleteRequest(
      await readJson(request),
    );
    validateContentBuildCompleteRequest(completion);
    return jsonResponse(
      unwrapWorkspaceRpcResult(
        await workspace(env, completion.workspaceId).buildComplete(completion),
      ),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/content/current") {
    await requireBearerToken(request, env.LANEDECK_READ_TOKEN);
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
    await requireBearerToken(request, env.LANEDECK_AGENT_TOKEN);
    requiredMachineId(url);
    return await workspace(env, requiredWorkspaceId(url)).fetch(request);
  }

  if (request.method === "GET" && url.pathname === "/ws/browser") {
    ensureWebSocketUpgrade(request);
    await requireBrowserReadToken(request, url, env.LANEDECK_READ_TOKEN);
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
    return await readShellAsset(request, env);
  }

  return errorResponse(
    new ApiError(405, "method_not_allowed", [
      { path: "method", message: "expected supported LaneDeck route method" },
    ]),
  );
}

async function readShellAsset(
  request: Request,
  env: CenterWorkerEnv,
): Promise<Response> {
  if (env.ASSETS === undefined) {
    return errorResponse(
      new ApiError(500, "shell_assets_not_configured", [
        { path: "ASSETS", message: "expected Worker static assets binding" },
      ]),
    );
  }

  return await env.ASSETS.fetch(request);
}

async function readContentAsset(
  url: URL,
  env: CenterWorkerEnv,
): Promise<Response> {
  const { revision, assetPath } = parseContentAssetPath(url.pathname);

  const response = await new R2ContentStore(
    env.LANEDECK_BUCKET,
  ).readContentAsset(revision, assetPath);

  if (response === null) {
    return errorResponse(
      new ApiError(404, "content_not_found", [
        { path: "path", message: "content asset was not found" },
      ]),
    );
  }

  return response;
}

function parseContentAssetPath(pathname: string): {
  revision: string;
  assetPath: string;
} {
  const [, contentSegment, revisionSegment, ...assetSegments] =
    pathname.split("/");
  if (
    contentSegment !== "content" ||
    revisionSegment === undefined ||
    revisionSegment.length === 0 ||
    assetSegments.length === 0 ||
    assetSegments.some((segment) => segment.length === 0)
  ) {
    throw badRequest(
      "invalid_content_path",
      "path",
      "expected content revision and asset path",
    );
  }

  return {
    revision: decodeContentPathSegment(revisionSegment),
    assetPath: assetSegments.map(decodeContentPathSegment).join("/"),
  };
}

function decodeContentPathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw badRequest(
      "invalid_content_path",
      "path",
      "expected valid URL-encoded content path",
    );
  }

  if (decoded.includes("/") || decoded.includes("\\")) {
    throw badRequest(
      "invalid_content_path",
      "path",
      "expected URL path segments without encoded separators",
    );
  }

  return decoded;
}

function workspace(env: CenterWorkerEnv, workspaceId: string) {
  return env.WORKSPACE_COORDINATOR.get(
    env.WORKSPACE_COORDINATOR.idFromName(workspaceId),
  );
}

function unwrapWorkspaceRpcResult<T>(result: WorkspaceRpcResult<T>): T {
  if (result.ok) {
    return result.value;
  }

  throw new ApiError(
    result.error.status,
    result.error.code,
    result.error.diagnostics,
  );
}

function validateContentBuildCompleteRequest(
  completion: ReturnType<typeof parseContentBuildCompleteRequest>,
): void {
  requireNonEmptyContentBuildField(completion.machineId, "machineId");
  requireNonEmptyContentBuildField(completion.buildRequestId, "buildRequestId");
  requireNonEmptyContentBuildField(completion.contentId, "contentId");
  requireNonEmptyContentBuildField(
    completion.contentRevision,
    "contentRevision",
  );
}

function requireNonEmptyContentBuildField(value: string, path: string): void {
  if (value.trim().length > 0) {
    return;
  }

  throw badRequest(
    "invalid_content_build_completion",
    path,
    "expected non-empty string",
  );
}

async function requireBearerToken(
  request: Request,
  expectedToken: string | undefined,
): Promise<void> {
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new ApiError(500, "authentication_not_configured", [
      {
        path: "authorization",
        message: "expected configured bearer token",
      },
    ]);
  }

  if (
    await secretEquals(
      request.headers.get("authorization"),
      `Bearer ${expectedToken}`,
    )
  ) {
    return;
  }

  throw authenticationFailed();
}

async function requireBrowserReadToken(
  request: Request,
  url: URL,
  expectedToken: string | undefined,
): Promise<void> {
  if (expectedToken === undefined || expectedToken.length === 0) {
    throw new ApiError(500, "authentication_not_configured", [
      {
        path: "authorization",
        message: "expected configured bearer token",
      },
    ]);
  }

  const [bearerMatches, queryMatches] = await Promise.all([
    secretEquals(
      request.headers.get("authorization"),
      `Bearer ${expectedToken}`,
    ),
    secretEquals(url.searchParams.get("readToken"), expectedToken),
  ]);

  if (bearerMatches || queryMatches) {
    return;
  }

  throw authenticationFailed();
}

async function secretEquals(
  candidate: string | null,
  expected: string,
): Promise<boolean> {
  const [candidateDigest, expectedDigest] = await Promise.all([
    digestSecret(candidate ?? ""),
    digestSecret(expected),
  ]);
  return timingSafeEqual(candidateDigest, expectedDigest);
}

async function digestSecret(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: Uint8Array, right: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(left, right);
  }

  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function authenticationFailed(): ApiError {
  return new ApiError(401, "authentication_failed", [
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

function requiredMachineId(url: URL): string {
  const machineId = url.searchParams.get("machineId");
  if (machineId !== null && machineId.length > 0) {
    return machineId;
  }

  throw badRequest(
    "missing_machine_id",
    "machineId",
    "expected machineId query parameter",
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
