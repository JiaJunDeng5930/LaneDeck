import { expect, test } from "@playwright/test";

import {
  e2eEventText,
  e2eLaneId,
  e2eQuietSignalText,
  makeCountTriggeredAgentInput,
  makeTimeTriggeredQuietSignalAgentInput,
} from "../support/contract-fixtures";
import { apiUrl, readHarnessReadiness, urlWithQuery } from "../support/harness";
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
    } = readiness.harness;

    const liveObserver = await connectJsonMessageObserver(liveWsUrl!);

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
            query: "lane_events",
            params: { laneId: e2eLaneId },
          },
        },
      );
      expect(queryResponse.ok()).toBe(true);
      const queryBody = (await queryResponse.json()) as { rows?: unknown[] };
      expect(JSON.stringify(queryBody.rows ?? [])).toContain(e2eEventText);

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
    const { agentSourceInputUrl, centerHttpUrl, liveWsUrl } = readiness.harness;

    const liveObserver = await connectJsonMessageObserver(liveWsUrl!);

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
            query: "lane_events",
            params: { laneId: e2eLaneId, triggerKind: "time" },
          },
        },
      );
      expect(queryResponse.ok()).toBe(true);

      const rows =
        ((await queryResponse.json()) as { rows?: unknown[] }).rows ?? [];
      expect(JSON.stringify(rows)).toContain(e2eQuietSignalText);
      expect(JSON.stringify(rows)).toContain('"recordCount":0');
      expect(JSON.stringify(rows)).toContain('"triggerKind":"time"');
    } finally {
      liveObserver.close();
    }
  });
});
