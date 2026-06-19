import { renderToStaticMarkup } from "react-dom/server";
import type { JsonObject, JsonValue, QueryResponse } from "@lanedeck/protocol";

import type { ContentRoute } from "./query";

export interface RenderedDashboard {
  html: string;
  pickIds: string[];
}

interface DashboardRow {
  pickId: string;
  title: string;
  laneId?: string;
  stage?: string;
  triggerKind?: string;
  observedAt?: string;
  recordCount?: string;
  batchId?: string;
}

export function renderDashboardMarkup(
  route: ContentRoute,
  response: QueryResponse,
): RenderedDashboard {
  const rows = dashboardRows(response);
  const title =
    route.view === "dashboard" ? "Dashboard" : (route.title ?? route.query);
  const pickIds = [
    "packages/content/src/views.tsx#dashboard.root",
    ...rows.map((row) => row.pickId),
  ];
  const html = renderToStaticMarkup(
    <main
      className="ld-content"
      data-pick-id="packages/content/src/views.tsx#dashboard.root"
    >
      <header className="ld-content__header">
        <p className="ld-content__eyebrow">{route.workspaceId}</p>
        <h1>{title}</h1>
      </header>
      <section className="ld-content__events" aria-label="Lane events">
        {rows.length === 0 ? (
          <p className="ld-content__empty">No lane events yet.</p>
        ) : (
          rows.map((row) => (
            <article
              className="ld-content__event"
              data-pick-id={row.pickId}
              key={row.pickId}
            >
              <h2>{row.title}</h2>
              <dl>
                {row.laneId === undefined ? null : (
                  <>
                    <dt>Lane</dt>
                    <dd>{row.laneId}</dd>
                  </>
                )}
                {row.stage === undefined ? null : (
                  <>
                    <dt>Stage</dt>
                    <dd>{row.stage}</dd>
                  </>
                )}
                {row.triggerKind === undefined ? null : (
                  <>
                    <dt>Trigger</dt>
                    <dd>{row.triggerKind}</dd>
                  </>
                )}
                {row.recordCount === undefined ? null : (
                  <>
                    <dt>Records</dt>
                    <dd>{row.recordCount}</dd>
                  </>
                )}
                {row.batchId === undefined ? null : (
                  <>
                    <dt>Batch</dt>
                    <dd>{row.batchId}</dd>
                  </>
                )}
                {row.observedAt === undefined ? null : (
                  <>
                    <dt>Observed</dt>
                    <dd>{row.observedAt}</dd>
                  </>
                )}
              </dl>
            </article>
          ))
        )}
      </section>
    </main>,
  );

  return { html, pickIds };
}

export function renderErrorMarkup(message: string, detail?: string): string {
  return renderToStaticMarkup(
    <main className="ld-content ld-content--error">
      <h1>{message}</h1>
      {detail === undefined ? null : <pre>{detail}</pre>}
    </main>,
  );
}

function dashboardRows(response: QueryResponse): DashboardRow[] {
  const rows: DashboardRow[] = [];
  for (const [rowIndex, row] of response.rows.entries()) {
    const frames = jsonArray(row.frames);
    if (frames === undefined) {
      rows.push(toDashboardRow(row, rowIndex));
      continue;
    }

    for (const [frameIndex, frame] of frames.entries()) {
      if (isJsonObject(frame)) {
        rows.push(toFrameDashboardRow(frame, rowIndex, frameIndex));
      }
    }
  }
  return rows.slice(0, 100);
}

function toDashboardRow(row: JsonObject, index: number): DashboardRow {
  return {
    pickId:
      scalarString(row.pickId) ??
      scalarString(row.sourceId) ??
      `packages/content/src/views.tsx#dashboard.row.${index}`,
    title:
      scalarString(row.eventText) ??
      scalarString(row.text) ??
      scalarString(row.message) ??
      JSON.stringify(row),
    laneId: scalarString(row.laneId),
    triggerKind: scalarString(row.triggerKind),
    observedAt: scalarString(row.observedAt) ?? scalarString(row.closedAt),
  };
}

function toFrameDashboardRow(
  frame: JsonObject,
  rowIndex: number,
  frameIndex: number,
): DashboardRow {
  const summary = isJsonObject(frame.summary) ? frame.summary : {};
  const laneId = scalarString(frame.laneId);
  const stage = scalarString(frame.stage);
  const frameNo = scalarString(frame.frameNo);
  return {
    pickId:
      scalarString(frame.pickId) ??
      scalarString(frame.sourceId) ??
      framePickId(frame, rowIndex, frameIndex),
    title: frameTitle(frame, summary, laneId, stage, frameNo),
    laneId,
    stage,
    triggerKind: scalarString(frame.triggerKind),
    observedAt: scalarString(frame.closedAt) ?? scalarString(frame.observedAt),
    recordCount: scalarString(frame.recordCount),
    batchId: scalarString(frame.batchId),
  };
}

function frameTitle(
  frame: JsonObject,
  summary: JsonObject,
  laneId: string | undefined,
  stage: string | undefined,
  frameNo: string | undefined,
): string {
  const summaryTitle =
    scalarString(summary.eventText) ??
    scalarString(summary.text) ??
    scalarString(summary.message);
  if (summaryTitle !== undefined) {
    return summaryTitle;
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

function framePickId(
  frame: JsonObject,
  rowIndex: number,
  frameIndex: number,
): string {
  return [
    "packages/content/src/views.tsx#dashboard.frame",
    scalarString(frame.laneId) ?? `row-${rowIndex}`,
    scalarString(frame.stage) ?? "stage",
    scalarString(frame.frameNo) ?? String(frameIndex),
  ].join(":");
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
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
