import { expect, type APIRequestContext } from "@playwright/test";

import {
  makeContentBuildCompleteRequest,
  makePatchContentMutation,
  makeRequestLocalBuildMutation,
} from "./contract-fixtures";
import { apiUrl, bearerHeaders } from "./harness";

export interface PromoteE2EDashboardContentOptions {
  request: APIRequestContext;
  workspaceId: string;
  centerHttpUrl: string;
  shellContentArtifactWriteUrl: string;
  aiMutationToken: string;
  agentToken: string;
}

export interface PromoteE2EDashboardContentResult {
  contentRevision: string;
  buildRequestId: string;
}

export async function promoteE2EDashboardContent(
  options: PromoteE2EDashboardContentOptions,
): Promise<PromoteE2EDashboardContentResult> {
  const mutationResponse = await options.request.post(
    apiUrl(options.centerHttpUrl, "/api/ai/mutation"),
    {
      data: makePatchContentMutation(options.workspaceId),
      headers: bearerHeaders(options.aiMutationToken),
    },
  );
  expect(mutationResponse.ok()).toBe(true);

  const patchResult = (await mutationResponse.json()) as {
    mutation?: string;
    contentRevision?: string;
  };
  expect(patchResult.mutation).toBe("patch_content");
  expect(typeof patchResult.contentRevision).toBe("string");
  expect(patchResult.contentRevision?.length).toBeGreaterThan(0);

  const buildRequestResponse = await options.request.post(
    apiUrl(options.centerHttpUrl, "/api/ai/mutation"),
    {
      data: makeRequestLocalBuildMutation(
        options.workspaceId,
        patchResult.contentRevision!,
      ),
      headers: bearerHeaders(options.aiMutationToken),
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
    options.workspaceId,
    buildRequestResult.buildRequestId!,
    patchResult.contentRevision!,
  );
  const shellArtifactResponse = await options.request.post(
    options.shellContentArtifactWriteUrl,
    { data: buildComplete },
  );
  expect(shellArtifactResponse.ok()).toBe(true);

  const buildCompleteResponse = await options.request.post(
    apiUrl(options.centerHttpUrl, "/api/content/build-complete"),
    {
      data: buildComplete,
      headers: bearerHeaders(options.agentToken),
    },
  );
  expect(buildCompleteResponse.ok()).toBe(true);
  await expect(buildCompleteResponse.json()).resolves.toMatchObject({
    mutation: "patch_content",
    contentRevision: patchResult.contentRevision,
  });

  return {
    contentRevision: patchResult.contentRevision!,
    buildRequestId: buildRequestResult.buildRequestId!,
  };
}
