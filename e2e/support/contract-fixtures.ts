import {
  parseFrame,
  parseIngestBatch,
  parseMutationRequest,
  type Frame,
  type IngestBatch,
  type MutationRequest,
} from "@lanedeck/protocol";

export const e2eWorkspaceId = "workspace-e2e";
export const e2eMachineId = "machine-e2e";
export const e2eLaneId = "lane-e2e";
export const e2eEventText = "LaneDeck e2e count-triggered event";
export const e2eQuietSignalText = "LaneDeck e2e quiet-signal event";
export const e2ePatchedContentText = "LaneDeck e2e patched content";
export const e2ePickId = "content.home.title";

const observedAt = "2026-01-01T00:00:00Z";

export interface AgentSourceInput {
  workspaceId: string;
  machineId: string;
  laneId: string;
  triggerKind: "count" | "time";
  records: unknown[];
  expectedEventText: string;
}

export function makeCountTriggeredAgentInput(): AgentSourceInput {
  const expectedFrame = makeCountTriggeredFrame();

  return {
    workspaceId: e2eWorkspaceId,
    machineId: e2eMachineId,
    laneId: e2eLaneId,
    triggerKind: expectedFrame.triggerKind,
    records: expectedFrame.records,
    expectedEventText: e2eEventText,
  };
}

export function makeTimeTriggeredQuietSignalAgentInput(): AgentSourceInput {
  const expectedFrame = makeTimeTriggeredQuietSignalFrame();

  return {
    workspaceId: e2eWorkspaceId,
    machineId: e2eMachineId,
    laneId: e2eLaneId,
    triggerKind: expectedFrame.triggerKind,
    records: [],
    expectedEventText: e2eQuietSignalText,
  };
}

export function makeCountTriggeredBatch(): IngestBatch {
  return validatedIngestBatch({
    workspaceId: e2eWorkspaceId,
    machineId: e2eMachineId,
    batchId: "batch-e2e-count",
    frames: [makeCountTriggeredFrame()],
  });
}

export function makeTimeTriggeredQuietSignalBatch(): IngestBatch {
  return validatedIngestBatch({
    workspaceId: e2eWorkspaceId,
    machineId: e2eMachineId,
    batchId: "batch-e2e-time",
    frames: [makeTimeTriggeredQuietSignalFrame()],
  });
}

export function makePatchContentMutation(): MutationRequest {
  const request: MutationRequest = {
    workspaceId: e2eWorkspaceId,
    mutation: "patch_content",
    payload: {
      pickId: e2ePickId,
      replacementText: e2ePatchedContentText,
    },
  };

  return parseMutationRequest(request);
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
