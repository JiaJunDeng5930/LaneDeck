import { badRequest } from "../errors";

import type {
  ContentBuildArtifactWrite,
  ContentBuildObjectKeys,
  ContentObjectWrite,
  ContentSourceObjectKeys,
} from "./types";

export class R2ContentStore {
  constructor(private readonly bucket: R2Bucket) {}

  async writeContentSource(
    write: ContentObjectWrite,
  ): Promise<ContentSourceObjectKeys> {
    const sourcePath = normalizeObjectPath(write.sourcePath, "payload.path");
    const sourceKey = [
      "content-source",
      write.workspaceId,
      write.revision,
      sourcePath,
    ].join("/");

    await this.bucket.put(sourceKey, write.source, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });

    return { sourceKey };
  }

  async writeContentBuildArtifacts(
    write: ContentBuildArtifactWrite,
  ): Promise<ContentBuildObjectKeys> {
    const revision = normalizeObjectPath(write.revision, "contentRevision");
    const entrypoint = normalizeObjectPath(write.entrypoint, "entrypoint");
    const assetKeys: string[] = [];
    let entrypointKey: string | null = null;

    for (const [index, artifact] of write.artifacts.entries()) {
      const path = normalizeObjectPath(
        artifact.path,
        `artifacts.${index}.path`,
      );
      const key = ["content", revision, path].join("/");
      await this.bucket.put(key, artifact.body, {
        httpMetadata: {
          contentType: artifact.contentType ?? contentTypeFor(path),
        },
      });
      assetKeys.push(key);
      if (path === entrypoint) {
        entrypointKey = key;
      }
    }

    if (entrypointKey === null) {
      throw badRequest(
        "invalid_content_build_payload",
        "entrypoint",
        "expected entrypoint artifact",
      );
    }

    return { entrypointKey, assetKeys };
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
      normalizedAssetPath.endsWith(".css") ||
      normalizedAssetPath.endsWith(".js") ||
      contentType.startsWith("text/html") ||
      contentType.startsWith("text/css") ||
      contentType.includes("javascript")
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
  text: string,
  revision: string,
): string {
  const assetBase = `/content/${normalizeObjectPath(
    revision,
    "revision",
  )}/assets/`;
  return text
    .replaceAll('"/assets/', `"${assetBase}`)
    .replaceAll("'/assets/", `'${assetBase}`)
    .replace(/url\((\s*)\/assets\//g, `url($1${assetBase}`);
}

export function normalizeObjectPath(value: string, path: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
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
