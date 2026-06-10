import { expect, test } from "@playwright/test";

import { observeFirstIframeReload } from "../support/browser";
import {
  e2ePatchedContentText,
  makePatchContentMutation,
} from "../support/contract-fixtures";
import { apiUrl, readHarnessReadiness } from "../support/harness";

const readiness = readHarnessReadiness(["centerHttpUrl", "shellHttpUrl"]);

test.describe("AI content mutation to shell reload", () => {
  test.skip(readiness.skip, readiness.reason);

  test("patches picked content and reloads the shell iframe", async ({
    page,
    request,
  }) => {
    const mutation = makePatchContentMutation();
    const { centerHttpUrl, shellHttpUrl } = readiness.harness;

    await page.goto(shellHttpUrl!);
    const reloadObserver = await observeFirstIframeReload(page);

    const mutationResponse = await request.post(
      apiUrl(centerHttpUrl!, "/api/ai/mutation"),
      { data: mutation },
    );
    expect(mutationResponse.ok()).toBe(true);

    const result = (await mutationResponse.json()) as {
      mutation?: string;
      contentRevision?: string;
    };
    expect(result.mutation).toBe("patch_content");
    expect(typeof result.contentRevision).toBe("string");
    expect(result.contentRevision?.length).toBeGreaterThan(0);

    await reloadObserver.waitForNextReload();
    await expect(
      page.frameLocator("iframe").first().getByText(e2ePatchedContentText),
    ).toBeVisible();
  });
});
