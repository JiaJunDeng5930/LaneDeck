import { badRequest } from "../errors";

import type { ContentObjectKeys, ContentObjectWrite } from "./types";

export class R2ContentStore {
  constructor(private readonly bucket: R2Bucket) {}

  async writeContentSource(
    write: ContentObjectWrite,
  ): Promise<ContentObjectKeys> {
    const sourcePath = normalizeObjectPath(write.sourcePath, "payload.path");
    const contentPath = normalizeObjectPath(
      write.contentPath,
      "payload.contentPath",
    );
    const sourceKey = [
      "content-source",
      write.workspaceId,
      write.revision,
      sourcePath,
    ].join("/");
    const assetKey = ["content", write.revision, contentPath].join("/");

    await this.bucket.put(sourceKey, write.source, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    await this.bucket.put(assetKey, write.source, {
      httpMetadata: { contentType: contentTypeFor(contentPath) },
    });

    return { sourceKey, assetKey };
  }

  async readContentAsset(
    revision: string,
    assetPath: string,
  ): Promise<Response | null> {
    const normalizedRevision = normalizeObjectPath(revision, "revision");
    const normalizedAssetPath = normalizeObjectPath(assetPath, "assetPath");
    const object = await this.bucket.get(
      ["content", normalizedRevision, normalizedAssetPath].join("/"),
    );

    if (object === null) {
      return null;
    }

    const contentType =
      object.httpMetadata?.contentType ?? contentTypeFor(normalizedAssetPath);
    if (
      normalizedAssetPath.endsWith(".html") ||
      contentType.startsWith("text/html")
    ) {
      return new Response(
        rewriteViteAssetReferences(await object.text(), normalizedRevision),
        { headers: { "content-type": contentType } },
      );
    }

    return new Response(object.body, {
      headers: { "content-type": contentType },
    });
  }
}

export function rewriteViteAssetReferences(
  html: string,
  revision: string,
): string {
  const assetBase = `/content/${normalizeObjectPath(
    revision,
    "revision",
  )}/assets/`;
  return html
    .replaceAll('"/assets/', `"${assetBase}`)
    .replaceAll("'/assets/", `'${assetBase}`);
}

export function normalizeObjectPath(value: string, path: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw badRequest(
      "invalid_object_path",
      path,
      "expected relative object path",
    );
  }

  return parts.join("/");
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (path.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (path.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (path.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}
