import { describe, expect, it } from "vitest";

import { D1CenterStorage } from "../src/storage/d1";
import {
  R2ContentStore,
  rewriteViteAssetReferences,
} from "../src/storage/r2";

import type {
  ContentRevisionRecord,
  LaneRevisionRecord,
} from "../src/storage/types";

describe("center-worker storage contract", () => {
  it("keeps current content pointer on the newest mutation sequence", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.saveContentRevision(
      contentRevision("revision-new", 2, "2026-06-10T10:00:02.000Z"),
    );
    await storage.saveContentRevision(
      contentRevision("revision-old", 1, "2026-06-10T10:00:01.000Z"),
    );

    await expect(storage.getCurrentContent("workspace.local")).resolves.toEqual(
      expect.objectContaining({ revision: "revision-new" }),
    );
    expect(
      db.pointerValue("workspace.local", "current_content_revision"),
    ).toBe("revision-new");
  });

  it("keeps current lane pointer on the newest mutation sequence", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.saveLaneRevision(
      laneRevision("lane-revision-new", 2, "2026-06-10T10:00:02.000Z"),
    );
    await storage.saveLaneRevision(
      laneRevision("lane-revision-old", 1, "2026-06-10T10:00:01.000Z"),
    );

    expect(db.pointerValue("workspace.local", "lane_revision:lane.local")).toBe(
      "lane-revision-new",
    );
  });

  it("rewrites root Vite asset URLs in HTML and CSS text", () => {
    expect(
      rewriteViteAssetReferences(
        [
          '<link rel="stylesheet" href="/assets/index.css">',
          "@font-face { src: url(/assets/font.woff2); }",
          ".logo { background-image: url('/assets/logo.svg'); }",
          '.hero { background-image: url("/assets/hero.png"); }',
        ].join("\n"),
        "revision-1",
      ),
    ).toContain("/content/revision-1/assets/font.woff2");
  });

  it("rewrites CSS asset responses before serving them", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putObject(
      "content/revision-1/assets/index.css",
      "@font-face { src: url(/assets/font.woff2); }",
      "text/css; charset=utf-8",
    );

    const response = await new R2ContentStore(
      bucket as unknown as R2Bucket,
    ).readContentAsset("revision-1", "assets/index.css");

    expect(response).not.toBeNull();
    await expect(response?.text()).resolves.toBe(
      "@font-face { src: url(/content/revision-1/assets/font.woff2); }",
    );
  });
});

function contentRevision(
  revision: string,
  mutationSequence: number,
  createdAt: string,
): ContentRevisionRecord {
  return {
    workspaceId: "workspace.local",
    mutationId: `mutation-${mutationSequence}`,
    mutationSequence,
    revision,
    sourcePath: "src/dashboard.tsx",
    contentPath: "index.html",
    sourceKey: `content-source/workspace.local/${revision}/src/dashboard.tsx`,
    assetKey: `content/${revision}/index.html`,
    createdAt,
    metadata: {},
  } as ContentRevisionRecord;
}

function laneRevision(
  revision: string,
  mutationSequence: number,
  createdAt: string,
): LaneRevisionRecord {
  return {
    workspaceId: "workspace.local",
    mutationId: `mutation-${mutationSequence}`,
    mutationSequence,
    laneId: "lane.local",
    revision,
    settings: { laneId: "lane.local" },
    createdAt,
  } as LaneRevisionRecord;
}

interface PointerRow {
  pointerValue: string;
  pointerSequence: number;
  updatedAt: string;
}

interface ContentRevisionRow {
  workspace_id: string;
  mutation_id: string;
  mutation_sequence: number;
  revision: string;
  source_path: string;
  content_path: string;
  source_key: string;
  asset_key: string;
  created_at: string;
  metadata_json: string;
}

class FakeD1Database {
  readonly contentRevisions = new Map<string, ContentRevisionRow>();
  private readonly pointers = new Map<string, PointerRow>();

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, sql);
  }

  async batch(statements: FakeD1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }

  pointerValue(workspaceId: string, key: string): string | null {
    return this.pointers.get(pointerKey(workspaceId, key))?.pointerValue ?? null;
  }

  run(sql: string, bindings: unknown[]): D1Result {
    if (sql.includes("INSERT INTO content_revisions")) {
      const hasMutationSequence = sql.includes("mutation_sequence");
      const [workspaceId, mutationId] = bindings as string[];
      const mutationSequence = hasMutationSequence ? Number(bindings[2]) : 0;
      const revision = String(bindings[hasMutationSequence ? 3 : 2]);
      const sourcePath = String(bindings[hasMutationSequence ? 4 : 3]);
      const contentPath = String(bindings[hasMutationSequence ? 5 : 4]);
      const sourceKey = String(bindings[hasMutationSequence ? 6 : 5]);
      const assetKey = String(bindings[hasMutationSequence ? 7 : 6]);
      const createdAt = String(bindings[hasMutationSequence ? 8 : 7]);
      const metadataJson = String(bindings[hasMutationSequence ? 9 : 8]);
      this.contentRevisions.set(contentKey(workspaceId, revision), {
        workspace_id: workspaceId,
        mutation_id: mutationId,
        mutation_sequence: mutationSequence,
        revision,
        source_path: sourcePath,
        content_path: contentPath,
        source_key: sourceKey,
        asset_key: assetKey,
        created_at: createdAt,
        metadata_json: metadataJson,
      });
    }

    if (sql.includes("INSERT INTO workspace_pointers")) {
      this.upsertPointer(sql, bindings);
    }

    return { success: true, meta: {} } as D1Result;
  }

  first<T>(sql: string, bindings: unknown[], column?: string): T | null {
    if (sql.includes("FROM workspace_pointers")) {
      const [workspaceId, key] = bindings as string[];
      const row = this.pointers.get(pointerKey(workspaceId, key));
      if (row === undefined) {
        return null;
      }
      return (
        column === "pointer_value"
          ? row.pointerValue
          : {
              pointer_value: row.pointerValue,
              pointer_sequence: row.pointerSequence,
              updated_at: row.updatedAt,
            }
      ) as T;
    }

    if (sql.includes("FROM content_revisions")) {
      const [workspaceId, revision] = bindings as string[];
      return (
        this.contentRevisions.get(contentKey(workspaceId, revision)) ?? null
      ) as T | null;
    }

    return null;
  }

  private upsertPointer(sql: string, bindings: unknown[]): void {
    const hasSequence = sql.includes("pointer_sequence");
    const [workspaceId, key, value] = bindings as string[];
    const mutationSequence = hasSequence ? Number(bindings[3]) : 0;
    const updatedAt = hasSequence ? String(bindings[4]) : String(bindings[3]);
    const mapKey = pointerKey(workspaceId, key);
    const current = this.pointers.get(mapKey);
    const hasSequenceGuard = sql.includes(
      "WHERE workspace_pointers.pointer_sequence <= excluded.pointer_sequence",
    );

    if (
      current === undefined ||
      !hasSequenceGuard ||
      current.pointerSequence <= mutationSequence
    ) {
      this.pointers.set(mapKey, {
        pointerValue: value,
        pointerSequence: mutationSequence,
        updatedAt,
      });
    }
  }
}

class FakeD1PreparedStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): FakeD1PreparedStatement {
    this.bindings = bindings;
    return this;
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.sql, this.bindings);
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    return this.db.first<T>(this.sql, this.bindings, column);
  }
}

class FakeR2Bucket {
  private readonly objects = new Map<
    string,
    { body: string; contentType: string }
  >();

  putObject(key: string, body: string, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return null;
    }

    return {
      body: object.body,
      httpMetadata: { contentType: object.contentType },
      text: async () => object.body,
    } as unknown as R2ObjectBody;
  }
}

function pointerKey(workspaceId: string, key: string): string {
  return `${workspaceId}:${key}`;
}

function contentKey(workspaceId: string, revision: string): string {
  return `${workspaceId}:${revision}`;
}
