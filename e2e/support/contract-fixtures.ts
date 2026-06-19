import {
  parseContentBuildCompleteRequest,
  parseFrame,
  parseIngestBatch,
  parseMutationRequest,
  type ContentBuildCompleteRequest,
  type Frame,
  type IngestBatch,
  type MutationRequest,
} from "@lanedeck/protocol";

export const e2eMachineId = "machine-e2e";
export const e2eLaneId = "lane-e2e";
export const e2eEventText = "LaneDeck e2e count-triggered event";
export const e2eQuietSignalText = "LaneDeck e2e quiet-signal event";
export const e2ePatchedContentText = "LaneDeck e2e patched content";
export const e2ePickId = "content.home.title";
export const e2eContentId = "content.home";
export const e2eContentSourcePath = "src/views.tsx";
export const e2eContentPath = "index.html";
export const e2eContentBuildCwd = "/workspace/lanedeck-content";
export const e2eContentBuildCommand =
  "corepack pnpm --filter @lanedeck/content build";

const observedAt = "2026-01-01T00:00:00Z";

export interface AgentSourceInput {
  workspaceId: string;
  machineId: string;
  laneId: string;
  triggerKind: "count" | "time";
  records: unknown[];
  expectedEventText: string;
}

export function makeCountTriggeredAgentInput(
  workspaceId: string,
): AgentSourceInput {
  const expectedFrame = makeCountTriggeredFrame();

  return {
    workspaceId,
    machineId: e2eMachineId,
    laneId: e2eLaneId,
    triggerKind: expectedFrame.triggerKind,
    records: expectedFrame.records,
    expectedEventText: e2eEventText,
  };
}

export function makeTimeTriggeredQuietSignalAgentInput(
  workspaceId: string,
): AgentSourceInput {
  const expectedFrame = makeTimeTriggeredQuietSignalFrame();

  return {
    workspaceId,
    machineId: e2eMachineId,
    laneId: e2eLaneId,
    triggerKind: expectedFrame.triggerKind,
    records: [],
    expectedEventText: e2eQuietSignalText,
  };
}

export function makeCountTriggeredBatch(workspaceId: string): IngestBatch {
  return validatedIngestBatch({
    workspaceId,
    machineId: e2eMachineId,
    batchId: "batch-e2e-count",
    frames: [makeCountTriggeredFrame()],
  });
}

export function makeTimeTriggeredQuietSignalBatch(
  workspaceId: string,
): IngestBatch {
  return validatedIngestBatch({
    workspaceId,
    machineId: e2eMachineId,
    batchId: "batch-e2e-time",
    frames: [makeTimeTriggeredQuietSignalFrame()],
  });
}

export function makePatchContentMutation(workspaceId: string): MutationRequest {
  const request: MutationRequest = {
    workspaceId,
    mutation: "patch_content",
    payload: {
      path: e2eContentSourcePath,
      contentPath: e2eContentPath,
      source: `<main data-pick-id="${e2ePickId}">${e2ePatchedContentText}</main>`,
      metadata: {
        pickId: e2ePickId,
        scenario: "content-mutation-flow",
      },
    },
  };

  return parseMutationRequest(request);
}

export function makeRequestLocalBuildMutation(
  workspaceId: string,
  contentRevision: string,
): MutationRequest {
  const request: MutationRequest = {
    workspaceId,
    mutation: "request_local_build",
    payload: {
      machineId: e2eMachineId,
      contentId: e2eContentId,
      contentRevision,
      cwd: e2eContentBuildCwd,
      command: e2eContentBuildCommand,
    },
  };

  return parseMutationRequest(request);
}

export function makeContentBuildCompleteRequest(
  workspaceId: string,
  buildRequestId: string,
  contentRevision: string,
): ContentBuildCompleteRequest {
  return parseContentBuildCompleteRequest({
    workspaceId,
    machineId: e2eMachineId,
    buildRequestId,
    contentId: e2eContentId,
    contentRevision,
    entrypoint: e2eContentPath,
    artifacts: [
      {
        path: e2eContentPath,
        bodyBase64: Buffer.from(e2eDashboardArtifactHtml(), "utf8").toString(
          "base64",
        ),
        contentType: "text/html; charset=utf-8",
      },
    ],
  });
}

function validatedIngestBatch(batch: IngestBatch): IngestBatch {
  return parseIngestBatch(batch);
}

function makeCountTriggeredFrame(): Frame {
  return parseFrame({
    laneId: e2eLaneId,
    stage: "event",
    frameNo: 1,
    openedAt: observedAt,
    closedAt: observedAt,
    triggerKind: "count",
    recordCount: 1,
    records: [
      {
        id: "event-e2e-count",
        observedAt,
        body: {
          text: e2eEventText,
          severity: "info",
        },
      },
    ],
    summary: {
      text: e2eEventText,
    },
  });
}

function makeTimeTriggeredQuietSignalFrame(): Frame {
  return parseFrame({
    laneId: e2eLaneId,
    stage: "event",
    frameNo: 2,
    openedAt: observedAt,
    closedAt: observedAt,
    triggerKind: "time",
    recordCount: 0,
    records: [],
    summary: {
      text: e2eQuietSignalText,
      quietSignal: true,
    },
  });
}

function e2eDashboardArtifactHtml(): string {
  return `<!doctype html>
<html>
  <body>
    <main id="root">${e2ePatchedContentText}</main>
    <script>
      (() => {
        const patchedText = ${JSON.stringify(e2ePatchedContentText)};
        const root = document.getElementById("root");
        let hostState = {};

        function post(message) {
          window.parent.postMessage(message, "*");
        }

        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[char]);
        }

        function mergeHostState(next) {
          hostState = { ...hostState, ...next };
        }

        function routeFromHostState() {
          if (hostState.route !== undefined) {
            return hostState.route;
          }
          if (typeof hostState.workspaceId === "string") {
            return { view: "dashboard", workspaceId: hostState.workspaceId };
          }
          return undefined;
        }

        function queryFor(route) {
          return route.view === "custom" ? route.query : "current_state";
        }

        function paramsFor(route) {
          if (route.view === "custom") {
            return route.params ?? {};
          }
          return route.laneId === undefined ? {} : { laneId: route.laneId };
        }

        async function render() {
          if (root === null) {
            return;
          }
          const parts = [
            '<section data-pick-id="${e2ePickId}">' +
              escapeHtml(patchedText) +
              "</section>",
          ];
          const route = routeFromHostState();
          if (
            typeof hostState.centerQueryUrl === "string" &&
            typeof route?.workspaceId === "string"
          ) {
            try {
              const headers = { "content-type": "application/json" };
              if (typeof hostState.centerReadToken === "string") {
                headers.authorization = "Bearer " + hostState.centerReadToken;
              }
              const response = await fetch(hostState.centerQueryUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  workspaceId: route.workspaceId,
                  query: queryFor(route),
                  params: paramsFor(route),
                }),
              });
              const body = await response.json();
              const frames = body?.rows?.[0]?.frames ?? [];
              for (const frame of frames) {
                parts.push(
                  "<article>" +
                    escapeHtml(JSON.stringify(frame.summary ?? frame)) +
                    "</article>",
                );
              }
            } catch (error) {
              parts.push("<pre>" + escapeHtml(error?.message ?? error) + "</pre>");
            }
          }
          root.innerHTML = parts.join("");
        }

        window.addEventListener("message", (event) => {
          const message = event.data;
          if (message === null || typeof message !== "object") {
            return;
          }
          if (message.type === "init") {
            mergeHostState(message.payload?.hostState ?? {});
            if (message.payload?.route !== undefined) {
              hostState.route = message.payload.route;
            }
            post({ type: "ready", payload: {} });
            void render();
          }
          if (message.type === "host_state") {
            mergeHostState(message.payload?.hostState ?? {});
            void render();
          }
        });
      })();
    </script>
  </body>
</html>`;
}
