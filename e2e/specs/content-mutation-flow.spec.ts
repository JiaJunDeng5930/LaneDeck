import { expect, test } from "@playwright/test";

import {
  observeFirstIframeReload,
  waitForShellReady,
} from "../support/browser";
import { e2ePatchedContentText } from "../support/contract-fixtures";
import { promoteE2EDashboardContent } from "../support/content-seed";
import { readHarnessReadiness } from "../support/harness";

const readiness = readHarnessReadiness([
  "workspaceId",
  "centerHttpUrl",
  "shellHttpUrl",
  "shellContentBaseUrl",
  "shellContentArtifactWriteUrl",
  "aiMutationToken",
  "agentToken",
]);

test.describe("AI content mutation to shell reload", () => {
  test.skip(readiness.skip, readiness.reason);

  test("patches picked content and reloads the shell iframe", async ({
    page,
    request,
  }) => {
    const { workspaceId } = readiness.harness;
    const {
      centerHttpUrl,
      shellHttpUrl,
      shellContentArtifactWriteUrl,
      aiMutationToken,
      agentToken,
    } = readiness.harness;

    await page.goto(shellHttpUrl!);
    await waitForShellReady(page);
    const reloadObserver = await observeFirstIframeReload(page);

    await promoteE2EDashboardContent({
      request,
      workspaceId: workspaceId!,
      centerHttpUrl: centerHttpUrl!,
      shellContentArtifactWriteUrl: shellContentArtifactWriteUrl!,
      aiMutationToken: aiMutationToken!,
      agentToken: agentToken!,
    });

    await reloadObserver.waitForNextReload();
    await expect(
      page.frameLocator("iframe").first().getByText(e2ePatchedContentText),
    ).toBeVisible();
  });
});
