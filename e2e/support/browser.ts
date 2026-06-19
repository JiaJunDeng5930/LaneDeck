import { expect, type Page } from "@playwright/test";

type WindowWithLaneDeckE2E = Window & {
  __lanedeckE2eIframeReloadCount?: number;
};

export interface IframeReloadObserver {
  waitForNextReload(): Promise<void>;
}

export async function waitForShellReady(page: Page): Promise<void> {
  await expect(page.locator(".shell-toolbar p")).toHaveText("Ready");
}

export async function observeFirstIframeReload(
  page: Page,
): Promise<IframeReloadObserver> {
  const iframe = page.locator("iframe").first();
  await iframe.waitFor({ state: "attached" });

  const iframeHandle = await iframe.elementHandle();
  if (iframeHandle === null) {
    throw new Error("LaneDeck shell e2e requires a content iframe");
  }

  const currentFrame = await iframeHandle.contentFrame();
  if (currentFrame === null) {
    throw new Error("LaneDeck shell e2e requires a loaded content iframe");
  }
  await currentFrame.waitForLoadState("load");

  const initialReloadCount = await page.evaluate(() => {
    const e2eWindow = window as WindowWithLaneDeckE2E;
    e2eWindow.__lanedeckE2eIframeReloadCount ??= 0;

    const iframe = document.querySelector("iframe");
    if (iframe === null) {
      throw new Error("LaneDeck shell e2e requires a content iframe");
    }

    iframe.addEventListener("load", () => {
      e2eWindow.__lanedeckE2eIframeReloadCount =
        (e2eWindow.__lanedeckE2eIframeReloadCount ?? 0) + 1;
    });

    return e2eWindow.__lanedeckE2eIframeReloadCount;
  });

  return {
    async waitForNextReload(): Promise<void> {
      await page.waitForFunction(
        (expectedMinimum) =>
          ((window as WindowWithLaneDeckE2E).__lanedeckE2eIframeReloadCount ??
            0) > expectedMinimum,
        initialReloadCount,
      );
    },
  };
}
