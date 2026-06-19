import { expect, test } from "@playwright/test";

import {
  observeFirstIframeReload,
  waitForShellReady,
} from "../support/browser";
import {
  e2ePatchedContentText,
  makeContentBuildCompleteRequest,
  makePatchContentMutation,
  makeRequestLocalBuildMutation,
} from "../support/contract-fixtures";
import {
  apiUrl,
  bearerHeaders,
  readHarnessReadiness,
} from "../support/harness";

const readiness = readHarnessReadiness([
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
    const mutation = makePatchContentMutation();
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

    const mutationResponse = await request.post(
      apiUrl(centerHttpUrl!, "/api/ai/mutation"),
      { data: mutation, headers: bearerHeaders(aiMutationToken!) },
    );
    expect(mutationResponse.ok()).toBe(true);

    const patchResult = (await mutationResponse.json()) as {
      mutation?: string;
      contentRevision?: string;
    };
    expect(patchResult.mutation).toBe("patch_content");
    expect(typeof patchResult.contentRevision).toBe("string");
    expect(patchResult.contentRevision?.length).toBeGreaterThan(0);

    const buildRequestMutation = makeRequestLocalBuildMutation(
      patchResult.contentRevision!,
    );
    const buildRequestResponse = await request.post(
      apiUrl(centerHttpUrl!, "/api/ai/mutation"),
      {
        data: buildRequestMutation,
        headers: bearerHeaders(aiMutationToken!),
      },
    );
    expect(buildRequestResponse.ok()).toBe(true);
    const buildRequestResult = (await buildRequestResponse.json()) as {
      mutation?: string;
      buildRequestId?: string;
    };
    expect(buildRequestResult.mutation).toBe("request_local_build");
    expect(typeof buildRequestResult.buildRequestId).toBe("string");
    expect(buildRequestResult.buildRequestId?.length).toBeGreaterThan(0);

    const buildComplete = makeContentBuildCompleteRequest(
      buildRequestResult.buildRequestId!,
      patchResult.contentRevision!,
    );
    const shellArtifactResponse = await request.post(
      shellContentArtifactWriteUrl!,
      { data: buildComplete },
    );
    expect(shellArtifactResponse.ok()).toBe(true);

    const buildCompleteResponse = await request.post(
      apiUrl(centerHttpUrl!, "/api/content/build-complete"),
      {
        data: buildComplete,
        headers: bearerHeaders(agentToken!),
      },
    );
    expect(buildCompleteResponse.ok()).toBe(true);
    await expect(buildCompleteResponse.json()).resolves.toMatchObject({
      mutation: "patch_content",
      contentRevision: patchResult.contentRevision,
    });

    await reloadObserver.waitForNextReload();
    await expect(
      page.frameLocator("iframe").first().getByText(e2ePatchedContentText),
    ).toBeVisible();
  });
});
