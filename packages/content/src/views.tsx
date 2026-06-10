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
  triggerKind?: string;
  observedAt?: string;
}

export function renderDashboardMarkup(
  route: ContentRoute,
  response: QueryResponse,
): RenderedDashboard {
  const rows = response.rows.map((row, index) => toDashboardRow(row, index));
  const title =
    route.view === "dashboard" ? "Dashboard" : (route.title ?? route.query);
  const pickIds = ["content.dashboard", ...rows.map((row) => row.pickId)];
  const html = renderToStaticMarkup(
    <main className="ld-content" data-pick-id="content.dashboard">
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
                {row.triggerKind === undefined ? null : (
                  <>
                    <dt>Trigger</dt>
                    <dd>{row.triggerKind}</dd>
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

function toDashboardRow(row: JsonObject, index: number): DashboardRow {
  return {
    pickId:
      scalarString(row.pickId) ??
      scalarString(row.sourceId) ??
      `content.dashboard.rows.${index}`,
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
