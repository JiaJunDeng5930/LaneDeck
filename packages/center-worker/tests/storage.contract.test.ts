import { describe, expect, it } from "vitest";

import { D1CenterStorage } from "../src/storage/d1";
import { R2ContentStore, rewriteViteAssetReferences } from "../src/storage/r2";

import type { IngestBatch } from "@lanedeck/protocol";
import type {
  ContentRevisionRecord,
  LaneRevisionRecord,
} from "../src/storage/types";

describe("center-worker storage contract", () => {
  it("initializes an index for current state frame reads", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.initialize();

    const indexSql = db.executedSql.find((sql) =>
      sql.includes("frames_current_state_idx"),
    );
    expect(indexSql).toContain(
      "(workspace_id, closed_at_epoch_ms DESC, batch_id DESC, lane_id ASC, machine_id ASC, stage ASC, frame_no ASC)",
    );
  });

  it("keeps current content pointer on the newest mutation sequence", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.saveContentSourceRevision(
      contentRevision("revision-new", 2, "2026-06-10T10:00:02.000Z"),
    );
    await storage.saveContentSourceRevision(
      contentRevision("revision-old", 1, "2026-06-10T10:00:01.000Z"),
    );
    await storage.promoteContentRevision({
      workspaceId: "workspace.local",
      revision: "revision-new",
      contentPath: "index.html",
      assetKey: "content/revision-new/index.html",
      promotedAt: "2026-06-10T10:00:03.000Z",
    });
    await storage.promoteContentRevision({
      workspaceId: "workspace.local",
      revision: "revision-old",
      contentPath: "index.html",
      assetKey: "content/revision-old/index.html",
      promotedAt: "2026-06-10T10:00:04.000Z",
    });

    await expect(storage.getCurrentContent("workspace.local")).resolves.toEqual(
      expect.objectContaining({ revision: "revision-new" }),
    );
    expect(db.pointerValue("workspace.local", "current_content_revision")).toBe(
      "revision-new",
    );
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

  it("lists current lane revisions for agent catch-up", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.saveLaneRevision(
      laneRevision("lane-z-revision", 2, "2026-06-10T10:00:02.000Z", "lane.z"),
    );
    await storage.saveLaneRevision(
      laneRevision("lane-a-revision", 3, "2026-06-10T10:00:03.000Z", "lane.a"),
    );
    await storage.saveLaneRevision(
      laneRevision(
        "lane-z-old-revision",
        1,
        "2026-06-10T10:00:01.000Z",
        "lane.z",
      ),
    );

    await expect(
      storage.listCurrentLaneRevisions("workspace.local"),
    ).resolves.toEqual([
      expect.objectContaining({
        laneId: "lane.a",
        revision: "lane-a-revision",
      }),
      expect.objectContaining({
        laneId: "lane.z",
        revision: "lane-z-revision",
      }),
    ]);
  });

  it("replaces repeated ingest batch scope atomically", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.saveIngestBatch(
      ingestBatch([frame(1), frame(2)]),
      "2026-06-10T10:00:10.000Z",
    );
    await storage.saveIngestBatch(
      ingestBatch([frame(1)]),
      "2026-06-10T10:00:20.000Z",
    );

    const state = await storage.getCurrentState("workspace.local");

    expect(state.frames).toEqual([
      expect.objectContaining({ batchId: "batch-1", frameNo: 1 }),
    ]);
    expect(
      db.recordCountForBatch("workspace.local", "machine.local", "batch-1"),
    ).toBe(1);
  });

  it("orders current state frames by normalized instants", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);

    await storage.saveIngestBatch(
      ingestBatch([
        {
          ...frame(1),
          closedAt: "2026-06-10T10:00:00Z",
        },
        {
          ...frame(2),
          closedAt: "2026-06-10T10:00:00.001Z",
        },
      ]),
      "2026-06-10T10:00:20.000Z",
    );

    const state = await storage.getCurrentState("workspace.local");

    expect(state.frames).toEqual([
      expect.objectContaining({ frameNo: 2 }),
      expect.objectContaining({ frameNo: 1 }),
    ]);
  });

  it("orders current state frames with deterministic tie breakers", async () => {
    const db = new FakeD1Database();
    const storage = new D1CenterStorage(db as unknown as D1Database);
    const closedAt = "2026-06-10T10:00:00.000Z";

    await storage.saveIngestBatch(
      {
        ...ingestBatch([{ ...frame(2), closedAt }]),
        machineId: "machine.z",
      },
      "2026-06-10T10:00:20.000Z",
    );
    await storage.saveIngestBatch(
      {
        ...ingestBatch([
          { ...frame(2), stage: "metric", closedAt },
          { ...frame(2), closedAt },
          { ...frame(1), closedAt },
        ]),
        machineId: "machine.a",
      },
      "2026-06-10T10:00:21.000Z",
    );

    const state = await storage.getCurrentState("workspace.local");

    expect(
      (
        state.frames as { machineId: string; stage: string; frameNo: number }[]
      ).map((frame) => [frame.machineId, frame.stage, frame.frameNo]),
    ).toEqual([
      ["machine.a", "event", 1],
      ["machine.a", "event", 2],
      ["machine.a", "metric", 2],
      ["machine.z", "event", 2],
    ]);
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

  it("stores content source separately from served build artifacts", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ContentStore(bucket as unknown as R2Bucket);

    await expect(
      store.writeContentSource({
        workspaceId: "workspace.local",
        revision: "revision-1",
        sourcePath: "src/main.tsx",
        source: "<App />",
      }),
    ).resolves.toEqual({
      sourceKey: "content-source/workspace.local/revision-1/src/main.tsx",
    });
    expect(bucket.objectBody("content/revision-1/src/main.tsx")).toBeNull();

    await expect(
      store.writeContentBuildArtifacts({
        revision: "revision-1",
        entrypoint: "index.html",
        artifacts: [
          {
            path: "index.html",
            bodyBase64: "PGRpdiBpZD0icm9vdCI+PC9kaXY+",
            contentType: "text/html; charset=utf-8",
          },
          {
            path: "assets/index.js",
            bodyBase64: "Y29uc29sZS5sb2coJ29rJyk=",
          },
        ],
      }),
    ).resolves.toEqual({
      entrypointKey: "content/revision-1/index.html",
      assetKeys: [
        "content/revision-1/index.html",
        "content/revision-1/assets/index.js",
      ],
    });
    expect(bucket.objectBody("content/revision-1/index.html")).toBe(
      '<div id="root"></div>',
    );
    expect(bucket.objectBody("content/revision-1/assets/index.js")).toBe(
      "console.log('ok')",
    );
  });

  it("rejects empty content source bodies at the R2 boundary", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ContentStore(bucket as unknown as R2Bucket);

    await expect(
      store.writeContentSource({
        workspaceId: "workspace.local",
        revision: "revision-empty",
        sourcePath: "src/main.tsx",
        source: " ",
      }),
    ).rejects.toMatchObject({
      code: "invalid_content_source",
      diagnostics: [expect.objectContaining({ path: "payload.source" })],
    });

    bucket.putObject(
      "content-source/workspace.local/revision-empty/src/main.tsx",
      "",
      "text/plain; charset=utf-8",
    );

    await expect(
      store.readContentSource(
        "content-source/workspace.local/revision-empty/src/main.tsx",
      ),
    ).rejects.toMatchObject({
      code: "invalid_content_source",
      diagnostics: [expect.objectContaining({ path: "sourceKey" })],
    });
  });

  it("writes build artifact bodies as decoded bytes", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ContentStore(bucket as unknown as R2Bucket);

    await store.writeContentBuildArtifacts({
      revision: "revision-binary",
      entrypoint: "assets/font.woff2",
      artifacts: [{ path: "assets/font.woff2", bodyBase64: "AP8B" }],
    });

    expect(
      bucket.objectBytes("content/revision-binary/assets/font.woff2"),
    ).toEqual([0, 255, 1]);
  });

  it("validates every build artifact before writing any R2 object", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2ContentStore(bucket as unknown as R2Bucket);

    await expect(
      store.writeContentBuildArtifacts({
        revision: "revision-1",
        entrypoint: "index.html",
        artifacts: [
          { path: "index.html", bodyBase64: "PG1haW4+dmFsaWQ8L21haW4+" },
          { path: "assets\\bad.js", bodyBase64: "Y29uc29sZS5sb2coJ2JhZCcp" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "artifacts.1.path" })],
    });
    expect(bucket.objectBody("content/revision-1/index.html")).toBeNull();

    await expect(
      store.writeContentBuildArtifacts({
        revision: "revision-2",
        entrypoint: "index.html",
        artifacts: [
          { path: "assets/index.js", bodyBase64: "Y29uc29sZS5sb2coJ29rJyk=" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_content_build_payload",
      diagnostics: [expect.objectContaining({ path: "entrypoint" })],
    });
    expect(bucket.objectBody("content/revision-2/assets/index.js")).toBeNull();

    await expect(
      store.writeContentBuildArtifacts({
        revision: "revision-3",
        entrypoint: "index.html",
        artifacts: [
          { path: "index.html", bodyBase64: "PG1haW4+Zmlyc3Q8L21haW4+" },
          {
            path: "index.html",
            bodyBase64: "PG1haW4+c2Vjb25kPC9tYWluPg==",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_content_build_payload",
      diagnostics: [expect.objectContaining({ path: "artifacts.1.path" })],
    });
    expect(bucket.objectBody("content/revision-3/index.html")).toBeNull();
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

  it("rewrites JavaScript asset responses before serving them", async () => {
    const bucket = new FakeR2Bucket();
    bucket.putObject(
      "content/revision-1/assets/index.js",
      'const logo = "/assets/logo.svg";',
      "text/javascript; charset=utf-8",
    );

    const response = await new R2ContentStore(
      bucket as unknown as R2Bucket,
    ).readContentAsset("revision-1", "assets/index.js");

    expect(response).not.toBeNull();
    await expect(response?.text()).resolves.toBe(
      'const logo = "/content/revision-1/assets/logo.svg";',
    );
  });

  it("rejects backslash separators in normalized R2 object paths", async () => {
    const store = new R2ContentStore({} as R2Bucket);
    const write = {
      workspaceId: "workspace.local",
      revision: "revision-1",
      sourcePath: "src/dashboard.tsx",
      source: "<h1>patched</h1>",
    };

    await expect(
      store.writeContentSource({
        ...write,
        sourcePath: "src\\dashboard.tsx",
      }),
    ).rejects.toMatchObject({
      code: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "payload.path" })],
    });
    await expect(
      store.writeContentBuildArtifacts({
        revision: "revision-1",
        entrypoint: "index.html",
        artifacts: [
          { path: "assets\\logo.svg", bodyBase64: "PHN2Zz48L3N2Zz4=" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "artifacts.0.path" })],
    });
    await expect(
      store.readContentAsset("revision\\1", "index.html"),
    ).rejects.toMatchObject({
      code: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "revision" })],
    });
    await expect(
      store.readContentAsset("revision-1", "assets\\logo.svg"),
    ).rejects.toMatchObject({
      code: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "assetPath" })],
    });

    let rewriteError: unknown;
    try {
      rewriteViteAssetReferences(
        'const logo = "/assets/logo.svg";',
        "bad\\rev",
      );
    } catch (error) {
      rewriteError = error;
    }
    expect(rewriteError).toMatchObject({
      code: "invalid_object_path",
      diagnostics: [expect.objectContaining({ path: "revision" })],
    });
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
  laneId = "lane.local",
): LaneRevisionRecord {
  return {
    workspaceId: "workspace.local",
    mutationId: `mutation-${mutationSequence}`,
    mutationSequence,
    laneId,
    revision,
    settings: { laneId },
    createdAt,
  } as LaneRevisionRecord;
}

function ingestBatch(frames: IngestBatch["frames"]): IngestBatch {
  return {
    workspaceId: "workspace.local",
    machineId: "machine.local",
    batchId: "batch-1",
    frames,
  };
}

function frame(frameNo: number): IngestBatch["frames"][number] {
  return {
    laneId: "lane.local",
    stage: "event",
    frameNo,
    openedAt: `2026-06-10T10:00:0${frameNo}.000Z`,
    closedAt: `2026-06-10T10:00:1${frameNo}.000Z`,
    triggerKind: "count",
    recordCount: 1,
    records: [
      {
        id: `record-${frameNo}`,
        observedAt: `2026-06-10T10:00:0${frameNo}.500Z`,
        body: { frameNo },
      },
    ],
    summary: { frameNo },
  };
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

interface LaneRevisionRow {
  workspace_id: string;
  mutation_id: string;
  mutation_sequence: number;
  lane_id: string;
  revision: string;
  settings_json: string;
  created_at: string;
}

interface FrameRow {
  workspace_id: string;
  machine_id: string;
  batch_id: string;
  lane_id: string;
  stage: string;
  frame_no: number;
  opened_at: string;
  closed_at: string;
  closed_at_epoch_ms: number;
  trigger_kind: string;
  record_count: number;
  summary_json: string;
}

class FakeD1Database {
  readonly executedSql: string[] = [];
  readonly contentRevisions = new Map<string, ContentRevisionRow>();
  readonly laneRevisions = new Map<string, LaneRevisionRow>();
  private readonly frames = new Map<string, FrameRow>();
  private readonly frameRecords = new Set<string>();
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
    return (
      this.pointers.get(pointerKey(workspaceId, key))?.pointerValue ?? null
    );
  }

  recordCountForBatch(
    workspaceId: string,
    machineId: string,
    batchId: string,
  ): number {
    const prefix = `${workspaceId}:${machineId}:${batchId}:`;
    return [...this.frameRecords].filter((key) => key.startsWith(prefix))
      .length;
  }

  run(sql: string, bindings: unknown[]): D1Result {
    this.executedSql.push(sql);

    if (sql.includes("DELETE FROM frame_records")) {
      this.deleteBatchFrameRecords(bindings as string[]);
    }

    if (sql.includes("DELETE FROM frames")) {
      this.deleteBatchFrames(bindings as string[]);
    }

    if (sql.includes("INSERT OR REPLACE INTO frames")) {
      const hasClosedAtEpoch = sql.includes("closed_at_epoch_ms");
      const [
        workspaceId,
        machineId,
        batchId,
        laneId,
        stage,
        frameNo,
        openedAt,
        closedAt,
      ] = bindings as string[];
      const closedAtEpochMs = hasClosedAtEpoch ? Number(bindings[8]) : 0;
      const triggerKind = String(bindings[hasClosedAtEpoch ? 9 : 8]);
      const recordCount = Number(bindings[hasClosedAtEpoch ? 10 : 9]);
      const summaryJson = String(bindings[hasClosedAtEpoch ? 11 : 10]);
      this.frames.set(
        frameKey(workspaceId, machineId, batchId, laneId, stage, frameNo),
        {
          workspace_id: workspaceId,
          machine_id: machineId,
          batch_id: batchId,
          lane_id: laneId,
          stage,
          frame_no: Number(frameNo),
          opened_at: openedAt,
          closed_at: closedAt,
          closed_at_epoch_ms: Number(closedAtEpochMs),
          trigger_kind: triggerKind,
          record_count: Number(recordCount),
          summary_json: summaryJson,
        },
      );
    }

    if (sql.includes("INSERT OR REPLACE INTO frame_records")) {
      const [
        workspaceId,
        machineId,
        batchId,
        laneId,
        stage,
        frameNo,
        recordId,
      ] = bindings as string[];
      this.frameRecords.add(
        frameRecordKey(
          workspaceId,
          machineId,
          batchId,
          laneId,
          stage,
          frameNo,
          recordId,
        ),
      );
    }

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

    if (sql.includes("UPDATE content_revisions")) {
      const [contentPath, assetKey, workspaceId, revision] =
        bindings as string[];
      const row = this.contentRevisions.get(contentKey(workspaceId, revision));
      if (row !== undefined) {
        row.content_path = contentPath;
        row.asset_key = assetKey;
      }
    }

    if (sql.includes("INSERT INTO lane_revisions")) {
      const [
        workspaceId,
        mutationId,
        mutationSequence,
        laneId,
        revision,
        settingsJson,
        createdAt,
      ] = bindings as string[];
      this.laneRevisions.set(laneKey(workspaceId, laneId, revision), {
        workspace_id: workspaceId,
        mutation_id: mutationId,
        mutation_sequence: Number(mutationSequence),
        lane_id: laneId,
        revision,
        settings_json: settingsJson,
        created_at: createdAt,
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
      return (this.contentRevisions.get(contentKey(workspaceId, revision)) ??
        null) as T | null;
    }

    return null;
  }

  all<T>(sql: string, bindings: unknown[]): { results: T[] } {
    if (sql.includes("FROM frames")) {
      const [workspaceId] = bindings as string[];
      const results = [...this.frames.values()]
        .filter((row) => row.workspace_id === workspaceId)
        .sort((left, right) => {
          const closedAtOrder = sql.includes("closed_at_epoch_ms")
            ? right.closed_at_epoch_ms - left.closed_at_epoch_ms
            : right.closed_at.localeCompare(left.closed_at);
          return (
            closedAtOrder ||
            right.batch_id.localeCompare(left.batch_id) ||
            left.lane_id.localeCompare(right.lane_id) ||
            left.machine_id.localeCompare(right.machine_id) ||
            left.stage.localeCompare(right.stage) ||
            left.frame_no - right.frame_no
          );
        });
      return { results: results as T[] };
    }

    if (
      sql.includes("FROM workspace_pointers") &&
      sql.includes("JOIN lane_revisions")
    ) {
      const [workspaceId] = bindings as string[];
      const rows = [...this.pointers.entries()]
        .filter(([key]) => key.startsWith(`${workspaceId}:lane_revision:`))
        .map(([key, pointer]) => {
          const laneId = key.slice(`${workspaceId}:lane_revision:`.length);
          return this.laneRevisions.get(
            laneKey(workspaceId, laneId, pointer.pointerValue),
          );
        })
        .filter((row): row is LaneRevisionRow => row !== undefined)
        .sort((left, right) => left.lane_id.localeCompare(right.lane_id));
      return { results: rows as T[] };
    }

    return { results: [] };
  }

  private deleteBatchFrames(bindings: string[]): void {
    const [workspaceId, machineId, batchId] = bindings;
    const prefix = `${workspaceId}:${machineId}:${batchId}:`;
    for (const key of this.frames.keys()) {
      if (key.startsWith(prefix)) {
        this.frames.delete(key);
      }
    }
  }

  private deleteBatchFrameRecords(bindings: string[]): void {
    const [workspaceId, machineId, batchId] = bindings;
    const prefix = `${workspaceId}:${machineId}:${batchId}:`;
    for (const key of this.frameRecords) {
      if (key.startsWith(prefix)) {
        this.frameRecords.delete(key);
      }
    }
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

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return this.db.all<T>(this.sql, this.bindings);
  }
}

class FakeR2Bucket {
  private readonly objects = new Map<
    string,
    { body: Uint8Array; contentType: string }
  >();

  putObject(key: string, body: string, contentType: string): void {
    this.objects.set(key, {
      body: new TextEncoder().encode(body),
      contentType,
    });
  }

  async put(
    key: string,
    body: string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    this.objects.set(key, {
      body:
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(body),
      contentType:
        options?.httpMetadata?.contentType ?? "application/octet-stream",
    });
  }

  objectBody(key: string): string | null {
    const body = this.objects.get(key)?.body;
    return body === undefined ? null : new TextDecoder().decode(body);
  }

  objectBytes(key: string): number[] | null {
    const body = this.objects.get(key)?.body;
    return body === undefined ? null : [...body];
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return null;
    }

    return {
      body: object.body,
      httpMetadata: { contentType: object.contentType },
      text: async () => new TextDecoder().decode(object.body),
    } as unknown as R2ObjectBody;
  }
}

function pointerKey(workspaceId: string, key: string): string {
  return `${workspaceId}:${key}`;
}

function contentKey(workspaceId: string, revision: string): string {
  return `${workspaceId}:${revision}`;
}

function laneKey(
  workspaceId: string,
  laneId: string,
  revision: string,
): string {
  return `${workspaceId}:${laneId}:${revision}`;
}

function frameKey(
  workspaceId: string,
  machineId: string,
  batchId: string,
  laneId: string,
  stage: string,
  frameNo: string,
): string {
  return `${workspaceId}:${machineId}:${batchId}:${laneId}:${stage}:${frameNo}`;
}

function frameRecordKey(
  workspaceId: string,
  machineId: string,
  batchId: string,
  laneId: string,
  stage: string,
  frameNo: string,
  recordId: string,
): string {
  return `${frameKey(
    workspaceId,
    machineId,
    batchId,
    laneId,
    stage,
    frameNo,
  )}:${recordId}`;
}
