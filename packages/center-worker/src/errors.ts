import type { Diagnostic } from "@lanedeck/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly diagnostics: Diagnostic[],
  ) {
    super(code);
  }
}

export function badRequest(
  code: string,
  path: string,
  message: string,
): ApiError {
  return new ApiError(400, code, [{ path, message }]);
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      { error: error.code, diagnostics: error.diagnostics },
      { status: error.status },
    );
  }

  return jsonResponse(
    {
      error: "internal_error",
      diagnostics: [{ path: "$", message: "request failed" }],
    },
    { status: 500 },
  );
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest("invalid_json", "$", "expected JSON request body");
  }
}
