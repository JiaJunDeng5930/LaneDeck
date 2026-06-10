import { describe, expect, it } from "vitest";

import {
  ProtocolError,
  parseFrame,
  parseIngestBatch,
  parseLaneConfig,
  parseShellContentMessage,
} from "./index";

const validCountFrame = {
  laneId: "lane.test-runtime",
  stage: "raw",
  frameNo: 1,
  openedAt: "2026-06-10T10:00:00.000Z",
  closedAt: "2026-06-10T10:00:05.000Z",
  triggerKind: "count",
  recordCount: 1,
  records: [
    {
      id: "record-1",
      observedAt: "2026-06-10T10:00:01.000Z",
      body: { line: "ok" },
    },
  ],
  summary: {},
};

describe("protocol frame contract", () => {
  it("accepts a minimal count-triggered frame", () => {
    expect(parseFrame(validCountFrame)).toMatchObject({
      laneId: "lane.test-runtime",
      triggerKind: "count",
      recordCount: 1,
    });
  });

  it("accepts a time-triggered empty frame", () => {
    expect(
      parseFrame({
        ...validCountFrame,
        frameNo: 2,
        triggerKind: "time",
        recordCount: 0,
        records: [],
      }),
    ).toMatchObject({
      triggerKind: "time",
      recordCount: 0,
      records: [],
    });
  });

  it("rejects invalid trigger kind with a field diagnostic", () => {
    expect(() =>
      parseFrame({
        ...validCountFrame,
        triggerKind: "timer",
      }),
    ).toThrow(ProtocolError);

    try {
      parseFrame({ ...validCountFrame, triggerKind: "timer" });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).diagnostics).toContainEqual(
        expect.objectContaining({ path: "triggerKind" }),
      );
    }
  });

  it("rejects negative frame counters", () => {
    expect(() =>
      parseFrame({
        ...validCountFrame,
        frameNo: -1,
      }),
    ).toThrow(ProtocolError);

    expect(() =>
      parseFrame({
        ...validCountFrame,
        recordCount: -1,
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects recordCount beyond the Rust u32 range", () => {
    expect(() =>
      parseFrame({
        ...validCountFrame,
        recordCount: 4_294_967_296,
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects timestamps outside strict RFC 3339 date-time shape", () => {
    expect(() =>
      parseFrame({
        ...validCountFrame,
        openedAt: "2026-06-10",
      }),
    ).toThrow(ProtocolError);

    expect(() =>
      parseFrame({
        ...validCountFrame,
        openedAt: "2026-02-31T00:00:00Z",
      }),
    ).toThrow(ProtocolError);

    expect(() =>
      parseFrame({
        ...validCountFrame,
        openedAt: "2026-06-10T10:00:00+99:99",
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects non-finite JSON numbers", () => {
    expect(() =>
      parseFrame({
        ...validCountFrame,
        records: [
          {
            id: "record-1",
            observedAt: "2026-06-10T10:00:01.000Z",
            body: { durationSeconds: Number.POSITIVE_INFINITY },
          },
        ],
      }),
    ).toThrow(ProtocolError);

    expect(() =>
      parseFrame({
        ...validCountFrame,
        summary: { maxDurationSeconds: Number.NaN },
      }),
    ).toThrow(ProtocolError);
  });
});

describe("protocol wire contract", () => {
  it("accepts a minimal lane config", () => {
    expect(
      parseLaneConfig({
        laneId: "lane.test-runtime",
        displayName: "Test Runtime",
        rawStage: { mode: "builtin", settings: {} },
        metricStage: { mode: "passthrough", settings: {} },
        eventStage: { mode: "empty", settings: {} },
      }),
    ).toMatchObject({
      laneId: "lane.test-runtime",
      metricStage: { mode: "passthrough" },
    });
  });

  it("accepts an ingest batch carrying count and time frames", () => {
    expect(
      parseIngestBatch({
        workspaceId: "workspace.local",
        machineId: "machine.devbox",
        batchId: "batch-1",
        frames: [
          validCountFrame,
          {
            ...validCountFrame,
            frameNo: 2,
            triggerKind: "time",
            recordCount: 0,
            records: [],
          },
        ],
      }),
    ).toMatchObject({
      batchId: "batch-1",
      frames: [{ triggerKind: "count" }, { triggerKind: "time" }],
    });
  });

  it("rejects invalid ingest batch shape", () => {
    expect(() =>
      parseIngestBatch({
        workspaceId: "workspace.local",
        machineId: "machine.devbox",
        batchId: "batch-1",
      }),
    ).toThrow(ProtocolError);
  });

  it.each([
    { type: "ready", payload: {} },
    { type: "pick_result", payload: { pickId: "content.home" } },
    { type: "error_report", payload: { message: "render failed" } },
  ])("accepts shell-content message $type", (message) => {
    expect(parseShellContentMessage(message)).toMatchObject(message);
  });

  it("rejects structured-clone objects outside JSON object shape", () => {
    expect(() =>
      parseShellContentMessage({
        type: "ready",
        payload: new Map([["pickId", "content.home"]]),
      }),
    ).toThrow(ProtocolError);
  });
});
