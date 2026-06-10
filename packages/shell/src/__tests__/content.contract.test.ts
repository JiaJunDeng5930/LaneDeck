import { describe, expect, it } from "vitest";

import {
  contentUriFor,
  createIframeContentLoader,
  type ContentFrameHost,
  type ShellToContentMessage,
} from "../content";

describe("content iframe loading", () => {
  it("loads content through the lanedeck custom protocol", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);

    const session = await loader.loadCurrent({
      workspaceId: "workspace.local",
      revision: "rev-1",
      path: "dashboards/home.html",
    });

    expect(session).toMatchObject({
      status: "ready",
      revision: "rev-1",
      reloadCount: 1,
    });
    expect(host.sources).toEqual([
      "lanedeck://content/workspace.local/rev-1/dashboards/home.html",
    ]);
  });

  it("forwards picker mode and height changes to the active frame", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    await loader.loadCurrent({
      workspaceId: "workspace.local",
      revision: "rev-1",
      path: "index.html",
    });

    loader.setPickerMode(true);
    loader.setHeight(240.2);

    expect(host.messages).toEqual([
      { type: "picker_mode", payload: { enabled: true } },
    ]);
    expect(host.heights).toEqual([240.2]);
  });

  it("uses explicit content uris when center provides one", () => {
    expect(
      contentUriFor({
        workspaceId: "workspace.local",
        revision: "rev-1",
        path: "index.html",
        uri: "lanedeck://content/current",
      }),
    ).toBe("lanedeck://content/current");
  });
});

class FakeFrameHost implements ContentFrameHost {
  readonly sources: string[] = [];
  readonly messages: ShellToContentMessage[] = [];
  readonly heights: number[] = [];

  setSource(uri: string): void {
    this.sources.push(uri);
  }

  postMessage(message: ShellToContentMessage): void {
    this.messages.push(message);
  }

  setHeight(height: number): void {
    this.heights.push(height);
  }

  close(): void {}
}
