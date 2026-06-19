import { expect, test } from "@playwright/test";

import {
  e2eEventText,
  e2eLaneId,
  e2eQuietSignalText,
  makeCountTriggeredAgentInput,
  makeTimeTriggeredQuietSignalAgentInput,
} from "../support/contract-fixtures";
import {
  apiUrl,
  bearerHeaders,
  readHarnessReadiness,
  urlWithQuery,
} from "../support/harness";
import {
  connectJsonMessageObserver,
  matchesBatchNotification,
} from "../support/live-ws";

const readiness = readHarnessReadiness([
  "agentSourceInputUrl",
  "centerHttpUrl",
  "shellHttpUrl",
  "liveWsUrl",
  "agentSpoolObservationUrl",
  "readToken",
]);

test.describe("agent ingest to dashboard", () => {
  test.skip(readiness.skip, readiness.reason);

  test("persists a count-triggered lane event and renders it in content", async ({
    page,
    request,
  }) => {
    const agentInput = makeCountTriggeredAgentInput();
    const {
      agentSourceInputUrl,
      centerHttpUrl,
      shellHttpUrl,
      liveWsUrl,
      agentSpoolObservationUrl,
      readToken,
    } = readiness.harness;

    const liveObserver = await connectJsonMessageObserver(
      urlWithQuery(liveWsUrl!, { readToken: readToken! }),
    );

    try {
      const agentResponse = await request.post(agentSourceInputUrl!, {
        data: agentInput,
      });
      expect(agentResponse.ok()).toBe(true);
      const agentRun = (await agentResponse.json()) as {
        batchId?: string;
      };
      expect(typeof agentRun.batchId).toBe("string");
      expect(agentRun.batchId?.length).toBeGreaterThan(0);

      await expect(
        liveObserver.waitForMessage((message) =>
          matchesBatchNotification(message, agentRun.batchId!),
        ),
      ).resolves.toBeTruthy();

      const spoolResponse = await request.get(
        urlWithQuery(agentSpoolObservationUrl!, {
          batchId: agentRun.batchId!,
        }),
      );
      expect(spoolResponse.ok()).toBe(true);
      expect(await spoolResponse.json()).toMatchObject({
        batchId: agentRun.batchId,
        status: "acked",
      });

      const queryResponse = await request.post(
        apiUrl(centerHttpUrl!, "/api/query"),
        {
          data: {
            workspaceId: agentInput.workspaceId,
            query: "current_state",
            params: { laneId: e2eLaneId },
          },
          headers: bearerHeaders(readToken!),
        },
      );
      expect(queryResponse.ok()).toBe(true);
      const frames = currentStateFrames(await queryResponse.json());
      const countFrame = frames.find(
        (frame) =>
          frame.batchId === agentRun.batchId &&
          frame.laneId === e2eLaneId &&
          frame.triggerKind === "count",
      );
      expect(countFrame).toMatchObject({
        batchId: agentRun.batchId,
        laneId: e2eLaneId,
        triggerKind: "count",
        recordCount: 1,
      });
      expect(JSON.stringify(countFrame?.summary ?? {})).toContain(e2eEventText);

      await page.goto(shellHttpUrl!);
      await expect(
        page.frameLocator("iframe").first().getByText(e2eEventText),
      ).toBeVisible();
    } finally {
      liveObserver.close();
    }
  });

  test("persists a time-triggered quiet-signal event", async ({ request }) => {
    const agentInput = makeTimeTriggeredQuietSignalAgentInput();
    const { agentSourceInputUrl, centerHttpUrl, liveWsUrl, readToken } =
      readiness.harness;

    const liveObserver = await connectJsonMessageObserver(
      urlWithQuery(liveWsUrl!, { readToken: readToken! }),
    );

    try {
      const agentResponse = await request.post(agentSourceInputUrl!, {
        data: agentInput,
      });
      expect(agentResponse.ok()).toBe(true);
      const agentRun = (await agentResponse.json()) as {
        batchId?: string;
      };
      expect(typeof agentRun.batchId).toBe("string");
      expect(agentRun.batchId?.length).toBeGreaterThan(0);

      await expect(
        liveObserver.waitForMessage((message) =>
          matchesBatchNotification(message, agentRun.batchId!),
        ),
      ).resolves.toBeTruthy();

      const queryResponse = await request.post(
        apiUrl(centerHttpUrl!, "/api/query"),
        {
          data: {
            workspaceId: agentInput.workspaceId,
            query: "current_state",
            params: { laneId: e2eLaneId, triggerKind: "time" },
          },
          headers: bearerHeaders(readToken!),
        },
      );
      expect(queryResponse.ok()).toBe(true);

      const frames = currentStateFrames(await queryResponse.json());
      const timeFrame = frames.find(
        (frame) =>
          frame.batchId === agentRun.batchId &&
          frame.laneId === e2eLaneId &&
          frame.triggerKind === "time",
      );
      expect(timeFrame).toMatchObject({
        batchId: agentRun.batchId,
        laneId: e2eLaneId,
        triggerKind: "time",
        recordCount: 0,
      });
      expect(JSON.stringify(timeFrame?.summary ?? {})).toContain(
        e2eQuietSignalText,
      );
    } finally {
      liveObserver.close();
    }
  });
});

interface CurrentStateFrame {
  batchId?: string;
  laneId?: string;
  triggerKind?: string;
  recordCount?: number;
  summary?: unknown;
}

function currentStateFrames(body: unknown): CurrentStateFrame[] {
  const rows = (body as { rows?: Array<{ frames?: CurrentStateFrame[] }> })
    .rows;
  expect(rows?.length).toBeGreaterThan(0);
  const frames = rows?.[0]?.frames ?? [];
  expect(frames.length).toBeGreaterThan(0);
  return frames;
}
