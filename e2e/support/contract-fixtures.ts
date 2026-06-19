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
        bodyBase64: Buffer.from(
          `<!doctype html><main>${e2ePatchedContentText}</main>`,
          "utf8",
        ).toString("base64"),
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
