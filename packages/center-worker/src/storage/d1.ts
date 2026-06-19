import type {
  Frame,
  FrameRecord,
  IngestBatch,
  JsonObject,
  JsonValue,
  MutationRequest,
} from "@lanedeck/protocol";

import type {
  CenterStorage,
  ContentBuildRequestRecord,
  ContentRevisionRecord,
  ContentRevisionPromotion,
  ContentRevisionPromotionResult,
  LaneRevisionRecord,
} from "./types";

interface FrameRow {
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

interface ContentBuildRequestRow {
  workspace_id: string;
  build_request_id: string;
  mutation_id: string;
  machine_id: string;
  content_id: string;
  content_revision: string;
  cwd: string;
  command: string;
  created_at: string;
  status: string;
  completed_at: string | null;
}

const schemaStatements = [
  "CREATE TABLE IF NOT EXISTS ingest_batches (workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL, batch_id TEXT NOT NULL, frame_count INTEGER NOT NULL, ingested_at TEXT NOT NULL, PRIMARY KEY (workspace_id, machine_id, batch_id))",
  "CREATE TABLE IF NOT EXISTS frames (workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL, batch_id TEXT NOT NULL, lane_id TEXT NOT NULL, stage TEXT NOT NULL, frame_no INTEGER NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT NOT NULL, closed_at_epoch_ms INTEGER NOT NULL, trigger_kind TEXT NOT NULL, record_count INTEGER NOT NULL, summary_json TEXT NOT NULL, PRIMARY KEY (workspace_id, machine_id, batch_id, lane_id, stage, frame_no))",
  "CREATE INDEX IF NOT EXISTS frames_current_state_idx ON frames (workspace_id, closed_at_epoch_ms DESC, batch_id DESC, lane_id ASC, machine_id ASC, stage ASC, frame_no ASC)",
  "CREATE TABLE IF NOT EXISTS frame_records (workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL, batch_id TEXT NOT NULL, lane_id TEXT NOT NULL, stage TEXT NOT NULL, frame_no INTEGER NOT NULL, record_id TEXT NOT NULL, observed_at TEXT NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY (workspace_id, machine_id, batch_id, lane_id, stage, frame_no, record_id))",
  "CREATE TABLE IF NOT EXISTS mutation_log (mutation_sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, mutation_id TEXT NOT NULL, mutation TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (workspace_id, mutation_id))",
  "CREATE TABLE IF NOT EXISTS content_revisions (workspace_id TEXT NOT NULL, mutation_id TEXT NOT NULL, mutation_sequence INTEGER NOT NULL, revision TEXT NOT NULL, source_path TEXT NOT NULL, content_path TEXT NOT NULL, source_key TEXT NOT NULL, asset_key TEXT NOT NULL, created_at TEXT NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY (workspace_id, revision))",
  "CREATE TABLE IF NOT EXISTS content_build_requests (workspace_id TEXT NOT NULL, build_request_id TEXT NOT NULL, mutation_id TEXT NOT NULL, machine_id TEXT NOT NULL, content_id TEXT NOT NULL, content_revision TEXT NOT NULL, cwd TEXT NOT NULL, command TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, PRIMARY KEY (workspace_id, build_request_id))",
  "CREATE TABLE IF NOT EXISTS lane_revisions (workspace_id TEXT NOT NULL, mutation_id TEXT NOT NULL, mutation_sequence INTEGER NOT NULL, lane_id TEXT NOT NULL, revision TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, lane_id, revision))",
  "CREATE TABLE IF NOT EXISTS workspace_pointers (workspace_id TEXT NOT NULL, pointer_key TEXT NOT NULL, pointer_value TEXT NOT NULL, pointer_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, pointer_key))",
];

export class D1CenterStorage implements CenterStorage {
  constructor(private readonly db: D1Database) {}

  async initialize(): Promise<void> {
    for (const statement of schemaStatements) {
      await this.db.prepare(statement).run();
    }
  }

  async saveIngestBatch(batch: IngestBatch, ingestedAt: string): Promise<void> {
    const statements = [
      this.deleteBatchFrameRecords(batch),
      this.deleteBatchFrames(batch),
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ingest_batches (
            workspace_id,
            machine_id,
            batch_id,
            frame_count,
            ingested_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          batch.workspaceId,
          batch.machineId,
          batch.batchId,
          batch.frames.length,
          ingestedAt,
        ),
    ];

    for (const frame of batch.frames) {
      statements.push(this.insertFrame(batch, frame));
      for (const record of frame.records) {
        statements.push(this.insertFrameRecord(batch, frame, record));
      }
    }

    await this.db.batch(statements);
  }

  async getCurrentState(workspaceId: string): Promise<JsonObject> {
    const frames = await this.db
      .prepare(
        `SELECT
          machine_id,
          batch_id,
          lane_id,
          stage,
          frame_no,
          opened_at,
          closed_at,
          closed_at_epoch_ms,
          trigger_kind,
          record_count,
          summary_json
        FROM frames
        WHERE workspace_id = ?
        ORDER BY closed_at_epoch_ms DESC, batch_id DESC, lane_id ASC, machine_id ASC, stage ASC, frame_no ASC
        LIMIT 100`,
      )
      .bind(workspaceId)
      .all<FrameRow>();

    const currentContent = await this.getCurrentContent(workspaceId);

    return {
      workspaceId,
      frames: frames.results.map((frame) => ({
        batchId: frame.batch_id,
        machineId: frame.machine_id,
        laneId: frame.lane_id,
        stage: frame.stage,
        frameNo: frame.frame_no,
        openedAt: frame.opened_at,
        closedAt: frame.closed_at,
        triggerKind: frame.trigger_kind,
        recordCount: frame.record_count,
        summary: parseJsonObject(frame.summary_json),
      })),
      currentContent:
        currentContent === null ? null : contentRevisionToJson(currentContent),
    };
  }

  async saveContentSourceRevision(
    record: ContentRevisionRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO content_revisions (
            workspace_id,
            mutation_id,
            mutation_sequence,
            revision,
            source_path,
            content_path,
            source_key,
            asset_key,
            created_at,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.workspaceId,
        record.mutationId,
        record.mutationSequence,
        record.revision,
        record.sourcePath,
        record.contentPath,
        record.sourceKey,
        record.assetKey ?? "",
        record.createdAt,
        JSON.stringify(record.metadata),
      )
      .run();
  }

  async promoteContentRevision(
    promotion: ContentRevisionPromotion,
  ): Promise<ContentRevisionPromotionResult> {
    const existing = await this.getContentRevision(
      promotion.workspaceId,
      promotion.revision,
    );
    if (existing === null) {
      throw new Error("content revision was not found");
    }

    const promotedRecord: ContentRevisionRecord = {
      ...existing,
      contentPath: promotion.contentPath,
      assetKey: promotion.assetKey,
    };
    const latestContentSequence = await this.latestContentRevisionSequence(
      promotion.workspaceId,
    );
    const promotesCurrent = existing.mutationSequence >= latestContentSequence;

    const statements = [
      this.db
        .prepare(
          `UPDATE content_revisions
          SET content_path = ?, asset_key = ?
          WHERE workspace_id = ? AND revision = ?`,
        )
        .bind(
          promotion.contentPath,
          promotion.assetKey,
          promotion.workspaceId,
          promotion.revision,
        ),
    ];
    if (promotesCurrent) {
      statements.push(
        this.upsertPointer(
          promotion.workspaceId,
          "current_content_revision",
          promotion.revision,
          existing.mutationSequence,
          promotion.promotedAt,
        ),
      );
    }
    if (promotion.buildRequestId !== undefined) {
      statements.push(
        this.db
          .prepare(
            `UPDATE content_build_requests
            SET status = ?, completed_at = ?
            WHERE workspace_id = ? AND build_request_id = ? AND status = ?`,
          )
          .bind(
            "completed",
            promotion.promotedAt,
            promotion.workspaceId,
            promotion.buildRequestId,
            "claimed",
          ),
      );
    }

    await this.db.batch(statements);
    const isCurrent =
      promotesCurrent &&
      (await this.pointerMatches(
        promotion.workspaceId,
        "current_content_revision",
        promotion.revision,
      ));
    return { record: promotedRecord, isCurrent };
  }

  async getCurrentContent(
    workspaceId: string,
  ): Promise<ContentRevisionRecord | null> {
    const revision = await this.db
      .prepare(
        `SELECT pointer_value
        FROM workspace_pointers
        WHERE workspace_id = ? AND pointer_key = ?`,
      )
      .bind(workspaceId, "current_content_revision")
      .first<string>("pointer_value");

    if (revision === null) {
      return null;
    }

    return await this.getContentRevision(workspaceId, revision);
  }

  async saveContentBuildRequest(
    record: ContentBuildRequestRecord,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO content_build_requests (
          workspace_id,
          build_request_id,
          mutation_id,
          machine_id,
          content_id,
          content_revision,
          cwd,
          command,
          created_at,
          status,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.workspaceId,
        record.buildRequestId,
        record.mutationId,
        record.machineId,
        record.contentId,
        record.contentRevision,
        record.cwd,
        record.command,
        record.createdAt,
        record.status,
        record.completedAt,
      )
      .run();
  }

  async getContentBuildRequest(
    workspaceId: string,
    buildRequestId: string,
  ): Promise<ContentBuildRequestRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT
          workspace_id,
          build_request_id,
          mutation_id,
          machine_id,
          content_id,
          content_revision,
          cwd,
          command,
          created_at,
          status,
          completed_at
        FROM content_build_requests
        WHERE workspace_id = ? AND build_request_id = ?`,
      )
      .bind(workspaceId, buildRequestId)
      .first<ContentBuildRequestRow>();

    return row === null ? null : contentBuildRequestFromRow(row);
  }

  async claimContentBuildRequest(
    workspaceId: string,
    buildRequestId: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE content_build_requests
        SET status = ?
        WHERE workspace_id = ? AND build_request_id = ? AND status = ?`,
      )
      .bind("claimed", workspaceId, buildRequestId, "pending")
      .run();

    return changedRows(result) === 1;
  }

  async releaseContentBuildRequestClaim(
    workspaceId: string,
    buildRequestId: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE content_build_requests
        SET status = ?
        WHERE workspace_id = ? AND build_request_id = ? AND status = ?`,
      )
      .bind("pending", workspaceId, buildRequestId, "claimed")
      .run();
  }

  async getContentRevision(
    workspaceId: string,
    revision: string,
  ): Promise<ContentRevisionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT
          workspace_id,
          mutation_id,
          mutation_sequence,
          revision,
          source_path,
          content_path,
          source_key,
          asset_key,
          created_at,
          metadata_json
        FROM content_revisions
        WHERE workspace_id = ? AND revision = ?`,
      )
      .bind(workspaceId, revision)
      .first<ContentRevisionRow>();

    return row === null ? null : contentRevisionFromRow(row);
  }

  private async latestContentRevisionSequence(
    workspaceId: string,
  ): Promise<number> {
    const latest = await this.db
      .prepare(
        `SELECT MAX(mutation_sequence) AS latest_sequence
        FROM content_revisions
        WHERE workspace_id = ?`,
      )
      .bind(workspaceId)
      .first<number>("latest_sequence");
    return latest ?? 0;
  }

  async saveLaneRevision(record: LaneRevisionRecord): Promise<boolean> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO lane_revisions (
            workspace_id,
            mutation_id,
            mutation_sequence,
            lane_id,
            revision,
            settings_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.workspaceId,
          record.mutationId,
          record.mutationSequence,
          record.laneId,
          record.revision,
          JSON.stringify(record.settings),
          record.createdAt,
        ),
      this.upsertPointer(
        record.workspaceId,
        `lane_revision:${record.laneId}`,
        record.revision,
        record.mutationSequence,
        record.createdAt,
      ),
    ]);
    return await this.pointerMatches(
      record.workspaceId,
      `lane_revision:${record.laneId}`,
      record.revision,
    );
  }

  async listCurrentLaneRevisions(
    workspaceId: string,
  ): Promise<LaneRevisionRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT
          lane_revisions.workspace_id,
          lane_revisions.mutation_id,
          lane_revisions.mutation_sequence,
          lane_revisions.lane_id,
          lane_revisions.revision,
          lane_revisions.settings_json,
          lane_revisions.created_at
        FROM workspace_pointers
        JOIN lane_revisions
          ON lane_revisions.workspace_id = workspace_pointers.workspace_id
          AND workspace_pointers.pointer_key = 'lane_revision:' || lane_revisions.lane_id
          AND workspace_pointers.pointer_value = lane_revisions.revision
        WHERE workspace_pointers.workspace_id = ?
          AND workspace_pointers.pointer_key LIKE 'lane_revision:%'
        ORDER BY lane_revisions.lane_id ASC`,
      )
      .bind(workspaceId)
      .all<LaneRevisionRow>();

    return rows.results.map(laneRevisionFromRow);
  }

  async saveMutation(
    request: MutationRequest,
    mutationId: string,
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO mutation_log (
          workspace_id,
          mutation_id,
          mutation,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
        RETURNING mutation_sequence`,
      )
      .bind(
        request.workspaceId,
        mutationId,
        request.mutation,
        JSON.stringify(request.payload),
        new Date().toISOString(),
      )
      .first<{ mutation_sequence: number }>();

    if (row === null) {
      throw new Error("mutation log insert did not return a sequence");
    }

    return row.mutation_sequence;
  }

  private insertFrame(batch: IngestBatch, frame: Frame): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR REPLACE INTO frames (
          workspace_id,
          machine_id,
          batch_id,
          lane_id,
          stage,
          frame_no,
          opened_at,
          closed_at,
          closed_at_epoch_ms,
          trigger_kind,
          record_count,
          summary_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        batch.workspaceId,
        batch.machineId,
        batch.batchId,
        frame.laneId,
        frame.stage,
        frame.frameNo,
        frame.openedAt,
        frame.closedAt,
        epochMilliseconds(frame.closedAt),
        frame.triggerKind,
        frame.recordCount,
        JSON.stringify(frame.summary),
      );
  }

  private deleteBatchFrames(batch: IngestBatch): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM frames
        WHERE workspace_id = ? AND machine_id = ? AND batch_id = ?`,
      )
      .bind(batch.workspaceId, batch.machineId, batch.batchId);
  }

  private deleteBatchFrameRecords(batch: IngestBatch): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM frame_records
        WHERE workspace_id = ? AND machine_id = ? AND batch_id = ?`,
      )
      .bind(batch.workspaceId, batch.machineId, batch.batchId);
  }

  private insertFrameRecord(
    batch: IngestBatch,
    frame: Frame,
    record: FrameRecord,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR REPLACE INTO frame_records (
          workspace_id,
          machine_id,
          batch_id,
          lane_id,
          stage,
          frame_no,
          record_id,
          observed_at,
          body_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        batch.workspaceId,
        batch.machineId,
        batch.batchId,
        frame.laneId,
        frame.stage,
        frame.frameNo,
        record.id,
        record.observedAt,
        JSON.stringify(record.body),
      );
  }

  private upsertPointer(
    workspaceId: string,
    key: string,
    value: string,
    mutationSequence: number,
    updatedAt: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO workspace_pointers (
          workspace_id,
          pointer_key,
          pointer_value,
          pointer_sequence,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, pointer_key)
        DO UPDATE SET
          pointer_value = excluded.pointer_value,
          pointer_sequence = excluded.pointer_sequence,
          updated_at = excluded.updated_at
        WHERE workspace_pointers.pointer_sequence <= excluded.pointer_sequence`,
      )
      .bind(workspaceId, key, value, mutationSequence, updatedAt);
  }

  private async pointerMatches(
    workspaceId: string,
    key: string,
    value: string,
  ): Promise<boolean> {
    const current = await this.db
      .prepare(
        `SELECT pointer_value
        FROM workspace_pointers
        WHERE workspace_id = ? AND pointer_key = ?`,
      )
      .bind(workspaceId, key)
      .first<string>("pointer_value");
    return current === value;
  }
}

function contentRevisionFromRow(
  row: ContentRevisionRow,
): ContentRevisionRecord {
  return {
    workspaceId: row.workspace_id,
    mutationId: row.mutation_id,
    mutationSequence: row.mutation_sequence,
    revision: row.revision,
    sourcePath: row.source_path,
    contentPath: row.content_path,
    sourceKey: row.source_key,
    assetKey: row.asset_key.length === 0 ? null : row.asset_key,
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function laneRevisionFromRow(row: LaneRevisionRow): LaneRevisionRecord {
  return {
    workspaceId: row.workspace_id,
    mutationId: row.mutation_id,
    mutationSequence: row.mutation_sequence,
    laneId: row.lane_id,
    revision: row.revision,
    settings: parseJsonObject(row.settings_json),
    createdAt: row.created_at,
  };
}

function contentBuildRequestFromRow(
  row: ContentBuildRequestRow,
): ContentBuildRequestRecord {
  const status = ["pending", "claimed", "completed"].includes(row.status)
    ? row.status
    : "pending";
  return {
    workspaceId: row.workspace_id,
    buildRequestId: row.build_request_id,
    mutationId: row.mutation_id,
    machineId: row.machine_id,
    contentId: row.content_id,
    contentRevision: row.content_revision,
    cwd: row.cwd,
    command: row.command,
    createdAt: row.created_at,
    status: status as ContentBuildRequestRecord["status"],
    completedAt: row.completed_at,
  };
}

function changedRows(result: D1Result): number {
  return (result.meta as { changes?: number }).changes ?? 0;
}

export function contentRevisionToJson(
  record: ContentRevisionRecord,
): JsonObject {
  return {
    workspaceId: record.workspaceId,
    mutationId: record.mutationId,
    revision: record.revision,
    sourcePath: record.sourcePath,
    contentPath: record.contentPath,
    sourceKey: record.sourceKey,
    assetKey: record.assetKey,
    createdAt: record.createdAt,
    metadata: record.metadata,
  };
}

function parseJsonObject(value: string): JsonObject {
  const parsed = JSON.parse(value) as JsonValue;
  if (isJsonObject(parsed)) {
    return parsed;
  }

  return {};
}

function epochMilliseconds(timestamp: string): number {
  const value = Date.parse(timestamp);
  if (Number.isFinite(value)) {
    return value;
  }

  throw new Error("expected valid RFC 3339 timestamp");
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
