import { renderToStaticMarkup } from "react-dom/server";
import type { JsonObject, JsonValue, QueryResponse } from "@lanedeck/protocol";

import type { ContentRoute } from "./query";

const SOURCE_PATH = "packages/content/src/views.tsx";
const ROOT_PICK_ID = `${SOURCE_PATH}#dashboard.root`;
const OVERVIEW_PICK_ID = `${SOURCE_PATH}#dashboard.overview`;
const EMPTY_PICK_ID = `${SOURCE_PATH}#dashboard.empty`;
const RECENT_EVENT_LIMIT = 100;

const STAGES = [
  { key: "raw", label: "Raw" },
  { key: "metric", label: "Metric" },
  { key: "event", label: "Event" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

export interface RenderedDashboard {
  html: string;
  pickIds: string[];
}

export interface DashboardRenderContext {
  contentRevision?: string;
}

interface DashboardRow {
  pickId: string;
  title: string;
  laneId?: string;
  stage?: StageKey;
  triggerKind?: string;
  observedAt?: string;
  recordCount?: string;
  batchId?: string;
  machineId?: string;
  frameNo?: string;
}

interface LaneSummary {
  laneId: string;
  pickId: string;
  stages: Record<StageKey, DashboardRow | undefined>;
  frameCount: number;
  quietSignalCount: number;
  countActivity: number;
  latestFrame?: DashboardRow;
}

interface DashboardMetric {
  label: string;
  value: string;
  detail: string;
}

interface DashboardModel {
  rows: DashboardRow[];
  lanes: LaneSummary[];
  metrics: DashboardMetric[];
  routeLabel: string;
  revisionLabel: string;
  latestObservedAt?: string;
}

export function renderDashboardMarkup(
  route: ContentRoute,
  response: QueryResponse,
  context: DashboardRenderContext = {},
): RenderedDashboard {
  const model = dashboardModel(route, response, context);
  const empty = model.rows.length === 0;
  const html = renderToStaticMarkup(
    <main className="ld-content" data-pick-id={ROOT_PICK_ID}>
      <header className="ld-status-band">
        <div className="ld-status-band__copy">
          <h1>
            {route.view === "dashboard"
              ? "Lane pipeline operations"
              : (route.title ?? route.query)}
          </h1>
          <p>{route.workspaceId}</p>
        </div>
        <dl className="ld-status-band__meta" aria-label="Dashboard status">
          <div>
            <dt>Route</dt>
            <dd>{model.routeLabel}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>{model.revisionLabel}</dd>
          </div>
          <div>
            <dt>Latest</dt>
            <dd>{model.latestObservedAt ?? "waiting"}</dd>
          </div>
        </dl>
      </header>

      <section
        className="ld-overview"
        data-pick-id={OVERVIEW_PICK_ID}
        aria-label="Overview metrics"
      >
        {model.metrics.map((metric) => (
          <article className="ld-metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <p>{metric.detail}</p>
          </article>
        ))}
      </section>

      {empty ? (
        <EmptyDashboard workspaceId={route.workspaceId} />
      ) : (
        <div className="ld-dashboard-grid">
          <PipelineBoard lanes={model.lanes} />
          <RecentEvents rows={model.rows} />
        </div>
      )}
    </main>,
  );

  return { html, pickIds: dashboardPickIds(model, empty) };
}

export function renderErrorMarkup(message: string, detail?: string): string {
  return renderToStaticMarkup(
    <main className="ld-content ld-content--error">
      <h1>{message}</h1>
      {detail === undefined ? null : <pre>{detail}</pre>}
    </main>,
  );
}

function EmptyDashboard({ workspaceId }: { workspaceId: string }) {
  return (
    <section className="ld-empty" data-pick-id={EMPTY_PICK_ID}>
      <div className="ld-empty__copy">
        <h2>Waiting for first frames</h2>
        <p>{workspaceId}</p>
      </div>
      <div className="ld-empty__pipeline" aria-label="Pipeline stages">
        {STAGES.map((stage) => (
          <div className="ld-empty__stage" key={stage.key}>
            <span>{stage.label}</span>
            <strong>waiting</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function PipelineBoard({ lanes }: { lanes: LaneSummary[] }) {
  return (
    <section className="ld-pipeline" aria-label="Lane pipeline board">
      <div className="ld-section-heading">
        <h2>Lane Pipeline Board</h2>
        <p>{formatCount(lanes.length, "lane")}</p>
      </div>
      <div className="ld-pipeline__header" aria-hidden="true">
        <span>Lane</span>
        {STAGES.map((stage) => (
          <span key={stage.key}>{stage.label}</span>
        ))}
      </div>
      <div className="ld-pipeline__rows">
        {lanes.map((lane) => (
          <article
            className="ld-lane-row"
            data-pick-id={lane.pickId}
            key={lane.laneId}
          >
            <header className="ld-lane-row__summary">
              <h3>{lane.laneId}</h3>
              <p>{lane.latestFrame?.title ?? "waiting"}</p>
              <dl>
                <div>
                  <dt>Frames</dt>
                  <dd>{lane.frameCount}</dd>
                </div>
                <div>
                  <dt>Quiet</dt>
                  <dd>{lane.quietSignalCount}</dd>
                </div>
              </dl>
            </header>
            <div className="ld-lane-row__stages">
              {STAGES.map((stage) => (
                <StageCell
                  frame={lane.stages[stage.key]}
                  key={stage.key}
                  laneId={lane.laneId}
                  stage={stage}
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function StageCell({
  frame,
  laneId,
  stage,
}: {
  frame: DashboardRow | undefined;
  laneId: string;
  stage: (typeof STAGES)[number];
}) {
  return (
    <div
      className={
        frame === undefined
          ? "ld-stage-cell ld-stage-cell--empty"
          : "ld-stage-cell"
      }
      data-pick-id={stagePickId(laneId, stage.key)}
    >
      <span className="ld-stage-cell__label">{stage.label}</span>
      {frame === undefined ? (
        <strong>waiting</strong>
      ) : (
        <>
          <strong>{frame.title}</strong>
          <dl>
            <div>
              <dt>Trigger</dt>
              <dd>{frame.triggerKind ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Records</dt>
              <dd>{frame.recordCount ?? "0"}</dd>
            </div>
            <div>
              <dt>Closed</dt>
              <dd>{frame.observedAt ?? "pending"}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

function RecentEvents({ rows }: { rows: DashboardRow[] }) {
  return (
    <section className="ld-stream" aria-label="Recent events stream">
      <div className="ld-section-heading">
        <h2>Recent Events Stream</h2>
        <p>{formatCount(rows.length, "frame")}</p>
      </div>
      <div className="ld-stream__list">
        {rows.slice(0, RECENT_EVENT_LIMIT).map((row) => (
          <article
            className="ld-event"
            data-pick-id={row.pickId}
            key={row.pickId}
          >
            <time>{row.observedAt ?? "pending"}</time>
            <h3>{row.title}</h3>
            <p>{eventMeta(row)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function dashboardModel(
  route: ContentRoute,
  response: QueryResponse,
  context: DashboardRenderContext,
): DashboardModel {
  const rows = dashboardRows(route, response);
  const lanes = laneSummaries(rows);
  return {
    rows,
    lanes,
    metrics: overviewMetrics(rows, lanes),
    routeLabel: routeLabel(route),
    revisionLabel: revisionLabel(context.contentRevision),
    latestObservedAt: latestObservedAt(rows),
  };
}

function overviewMetrics(
  rows: DashboardRow[],
  lanes: LaneSummary[],
): DashboardMetric[] {
  const quietSignals = rows.filter(isQuietSignal).length;
  const countActivity = rows.filter(
    (row) => row.triggerKind === "count",
  ).length;
  return [
    {
      label: "Lanes",
      value: String(lanes.length),
      detail: "current workspace",
    },
    {
      label: "Frames",
      value: String(rows.length),
      detail: "latest current state",
    },
    {
      label: "Quiet signals",
      value: String(quietSignals),
      detail: "time-triggered empty frames",
    },
    {
      label: "Count activity",
      value: String(countActivity),
      detail: "count-triggered frames",
    },
  ];
}

function laneSummaries(rows: DashboardRow[]): LaneSummary[] {
  const lanes = new Map<string, LaneSummary>();
  for (const row of rows) {
    if (row.laneId === undefined) {
      continue;
    }
    const lane =
      lanes.get(row.laneId) ??
      ({
        laneId: row.laneId,
        pickId: lanePickId(row.laneId),
        stages: { raw: undefined, metric: undefined, event: undefined },
        frameCount: 0,
        quietSignalCount: 0,
        countActivity: 0,
      } satisfies LaneSummary);
    lane.frameCount += 1;
    if (isQuietSignal(row)) {
      lane.quietSignalCount += 1;
    }
    if (row.triggerKind === "count") {
      lane.countActivity += 1;
    }
    lane.latestFrame = latestRow(lane.latestFrame, row);
    if (row.stage !== undefined) {
      lane.stages[row.stage] = latestRow(lane.stages[row.stage], row);
    }
    lanes.set(row.laneId, lane);
  }

  return Array.from(lanes.values());
}

function dashboardRows(
  route: ContentRoute,
  response: QueryResponse,
): DashboardRow[] {
  const rows: DashboardRow[] = [];
  const laneFilter = route.view === "dashboard" ? route.laneId : undefined;
  for (const [rowIndex, row] of response.rows.entries()) {
    const frames = jsonArray(row.frames);
    if (frames === undefined) {
      if (!matchesLaneFilter(row, laneFilter)) {
        continue;
      }
      rows.push(toDashboardRow(row, rowIndex, 0, "row"));
      continue;
    }

    for (const [frameIndex, frame] of frames.entries()) {
      if (isJsonObject(frame) && matchesLaneFilter(frame, laneFilter)) {
        rows.push(toDashboardRow(frame, rowIndex, frameIndex, "frame"));
      }
    }
  }
  return rows.slice(0, RECENT_EVENT_LIMIT);
}

function matchesLaneFilter(
  row: JsonObject,
  laneFilter: string | undefined,
): boolean {
  return laneFilter === undefined || scalarString(row.laneId) === laneFilter;
}

function toDashboardRow(
  row: JsonObject,
  rowIndex: number,
  frameIndex: number,
  source: "frame" | "row",
): DashboardRow {
  const summary = isJsonObject(row.summary) ? row.summary : {};
  const laneId = scalarString(row.laneId);
  const stage = stageKey(row.stage);
  const frameNo = scalarString(row.frameNo);
  const batchId = scalarString(row.batchId);
  const machineId = scalarString(row.machineId);
  return {
    pickId:
      scalarString(row.pickId) ??
      scalarString(row.sourceId) ??
      eventPickId({
        laneId,
        stage,
        frameNo,
        batchId,
        machineId,
        rowIndex,
        frameIndex,
      }),
    title: frameTitle(row, summary, laneId, stage, frameNo),
    laneId,
    stage,
    triggerKind: scalarString(row.triggerKind),
    observedAt:
      source === "row"
        ? (scalarString(row.observedAt) ?? scalarString(row.closedAt))
        : (scalarString(row.closedAt) ?? scalarString(row.observedAt)),
    recordCount: scalarString(row.recordCount),
    batchId,
    machineId,
    frameNo,
  };
}

function frameTitle(
  frame: JsonObject,
  summary: JsonObject,
  laneId: string | undefined,
  stage: StageKey | undefined,
  frameNo: string | undefined,
): string {
  const summaryTitle =
    scalarString(summary.eventText) ??
    scalarString(summary.text) ??
    scalarString(summary.message);
  if (summaryTitle !== undefined) {
    return summaryTitle;
  }
  const rowTitle =
    scalarString(frame.eventText) ??
    scalarString(frame.text) ??
    scalarString(frame.message);
  if (rowTitle !== undefined) {
    return rowTitle;
  }
  const identityTitle = [
    laneId,
    stage,
    frameNo === undefined ? undefined : `#${frameNo}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return identityTitle.length === 0 ? JSON.stringify(frame) : identityTitle;
}

function routeLabel(route: ContentRoute): string {
  if (route.view === "custom") {
    return `custom / ${route.query}`;
  }
  return route.laneId === undefined
    ? "dashboard / all lanes"
    : `dashboard / ${route.laneId}`;
}

function revisionLabel(contentRevision: string | undefined): string {
  if (contentRevision === undefined || contentRevision.trim().length === 0) {
    return "pending";
  }
  const trimmed = contentRevision.trim();
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function latestObservedAt(rows: DashboardRow[]): string | undefined {
  return rows.reduce<string | undefined>((latest, row) => {
    if (row.observedAt === undefined) {
      return latest;
    }
    if (latest === undefined) {
      return row.observedAt;
    }
    return timestampMs(row.observedAt) >= timestampMs(latest)
      ? row.observedAt
      : latest;
  }, undefined);
}

function latestRow(
  current: DashboardRow | undefined,
  next: DashboardRow,
): DashboardRow {
  if (current === undefined) {
    return next;
  }
  return compareRowsByTime(next, current) >= 0 ? next : current;
}

function compareRowsByTime(
  left: DashboardRow | undefined,
  right: DashboardRow | undefined,
): number {
  const time = timestampMs(left?.observedAt) - timestampMs(right?.observedAt);
  if (time !== 0) {
    return time;
  }
  return stageRank(left?.stage) - stageRank(right?.stage);
}

function stageRank(stage: StageKey | undefined): number {
  if (stage === "event") {
    return 2;
  }
  if (stage === "metric") {
    return 1;
  }
  if (stage === "raw") {
    return 0;
  }
  return -1;
}

function timestampMs(value: string | undefined): number {
  if (value === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function eventMeta(row: DashboardRow): string {
  return [
    row.laneId,
    row.stage,
    row.triggerKind,
    row.recordCount === undefined ? undefined : `${row.recordCount} records`,
  ]
    .filter((part) => part !== undefined)
    .join(" / ");
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function isQuietSignal(row: DashboardRow): boolean {
  return row.triggerKind === "time" && row.recordCount === "0";
}

function stageKey(value: JsonValue | undefined): StageKey | undefined {
  return value === "raw" || value === "metric" || value === "event"
    ? value
    : undefined;
}

function scalarString(value: JsonValue | undefined): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return undefined;
}

function jsonArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dashboardPickIds(model: DashboardModel, empty: boolean): string[] {
  const pickIds = [ROOT_PICK_ID, OVERVIEW_PICK_ID];
  if (empty) {
    pickIds.push(EMPTY_PICK_ID);
  }
  for (const lane of model.lanes) {
    pickIds.push(lane.pickId);
    for (const stage of STAGES) {
      pickIds.push(stagePickId(lane.laneId, stage.key));
    }
  }
  for (const row of model.rows) {
    pickIds.push(row.pickId);
  }
  return Array.from(new Set(pickIds));
}

function lanePickId(laneId: string): string {
  return pickId(`dashboard.lane.${pickSegment(laneId)}`);
}

function stagePickId(laneId: string, stage: StageKey): string {
  return pickId(`dashboard.stage.${pickSegment(laneId)}.${stage}`);
}

function eventPickId(input: {
  laneId: string | undefined;
  stage: StageKey | undefined;
  frameNo: string | undefined;
  batchId: string | undefined;
  machineId: string | undefined;
  rowIndex: number;
  frameIndex: number;
}): string {
  const parts = [
    input.laneId ?? `row-${input.rowIndex}`,
    input.stage ?? "stage",
    input.frameNo ?? `frame-${input.frameIndex}`,
    input.batchId ?? `batch-${input.rowIndex}`,
    input.machineId ?? `machine-${input.rowIndex}`,
    `row-${input.rowIndex}`,
    `frame-${input.frameIndex}`,
  ].map(pickSegment);
  return pickId(`dashboard.event.${parts.join(":")}`);
}

function pickId(localTarget: string): string {
  return `${SOURCE_PATH}#${localTarget}`;
}

function pickSegment(value: string): string {
  return encodeURIComponent(value);
}
