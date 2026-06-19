import { describe, expect, it } from "vitest";

import {
  contentUriFor,
  createIframeContentLoader,
  type ContentFrameHost,
  type ContentHostState,
  type ContentSession,
  type ShellToContentMessage,
} from "../content";
import type { CurrentContentDescriptor } from "../center";

describe("content iframe loading", () => {
  it("loads content through the lanedeck custom protocol", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);

    const session = loader.loadCurrent({
      workspaceId: "workspace.local",
      revision: "rev-1",
      path: "dashboards/home.html",
    });

    host.completeLoad();

    await expect(session).resolves.toMatchObject({
      status: "ready",
      revision: "rev-1",
      reloadCount: 1,
    });
    expect(host.sources).toEqual([
      "lanedeck://content/workspace.local/rev-1/dashboards/home.html",
    ]);
  });

  it("sends init with host state after the iframe load event", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    const descriptor = descriptorWithHostState();

    const session = loader.loadCurrent(descriptor);
    await Promise.resolve();

    expect(host.messages).toEqual([]);

    host.completeLoad();

    await expect(session).resolves.toMatchObject({
      status: "ready",
      revision: "rev-1",
      reloadCount: 1,
    });
    expect(host.messages).toEqual([
      {
        type: "init",
        payload: {
          hostState: {
            pickerEnabled: false,
            workspaceId: "workspace.local",
            contentRevision: "rev-1",
            centerQueryUrl: "https://center.example.test/api/query",
            centerReadToken: "read-token",
            route: {
              view: "dashboard",
              workspaceId: "workspace.local",
              laneId: "lane.build",
            },
          },
        },
      },
    ]);
  });

  it("uses the latest session host state when init follows a picker update", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    const session = loader.loadCurrent(
      {
        workspaceId: "workspace.local",
        revision: "rev-1",
        path: "index.html",
      },
      hostState(false),
    );
    await Promise.resolve();

    loader.setPickerMode(true);
    host.completeLoad();

    await expect(session).resolves.toMatchObject({
      status: "ready",
      revision: "rev-1",
      reloadCount: 1,
    });
    expect(host.messages.at(-1)).toEqual({
      type: "init",
      payload: { hostState: hostState(true) },
    });
  });

  it("forwards picker mode as host state and height changes to the active frame", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    await loadReady(loader.loadCurrent(descriptorWithHostState()), host);

    loader.setPickerMode(true);
    loader.setHeight(240.2);

    expect(host.messages).toEqual([
      {
        type: "init",
        payload: {
          hostState: {
            pickerEnabled: false,
            workspaceId: "workspace.local",
            contentRevision: "rev-1",
            centerQueryUrl: "https://center.example.test/api/query",
            centerReadToken: "read-token",
            route: {
              view: "dashboard",
              workspaceId: "workspace.local",
              laneId: "lane.build",
            },
          },
        },
      },
      {
        type: "host_state",
        payload: {
          hostState: {
            pickerEnabled: true,
            workspaceId: "workspace.local",
            contentRevision: "rev-1",
            centerQueryUrl: "https://center.example.test/api/query",
            centerReadToken: "read-token",
            route: {
              view: "dashboard",
              workspaceId: "workspace.local",
              laneId: "lane.build",
            },
          },
        },
      },
    ]);
    expect(host.heights).toEqual([240.2]);
  });

  it("forwards height changes to the active frame", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    await loadReady(
      loader.loadCurrent({
        workspaceId: "workspace.local",
        revision: "rev-1",
        path: "index.html",
      }),
      host,
    );

    loader.setHeight(240.2);

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

type HostStateDescriptor = CurrentContentDescriptor & {
  centerQueryUrl: string;
  centerReadToken: string;
  route: {
    view: "dashboard";
    workspaceId: string;
    laneId: string;
  };
};

function descriptorWithHostState(): HostStateDescriptor {
  return {
    workspaceId: "workspace.local",
    revision: "rev-1",
    path: "index.html",
    centerQueryUrl: "https://center.example.test/api/query",
    centerReadToken: "read-token",
    route: {
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.build",
    },
  };
}

function hostState(pickerEnabled: boolean): ContentHostState {
  return {
    pickerEnabled,
    workspaceId: "workspace.local",
    contentRevision: "rev-1",
    centerQueryUrl: "https://center.example.test/api/query",
    centerReadToken: "read-token",
    route: {
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.build",
    },
  };
}

async function loadReady(
  session: Promise<ContentSession>,
  host: FakeFrameHost,
): Promise<void> {
  host.completeLoad();
  await expect(session).resolves.toMatchObject({ status: "ready" });
}

class FakeFrameHost implements ContentFrameHost {
  readonly sources: string[] = [];
  readonly messages: unknown[] = [];
  readonly heights: number[] = [];
  private loadResolver: (() => void) | undefined;

  setSource(uri: string): void {
    this.sources.push(uri);
  }

  postMessage(message: ShellToContentMessage): void {
    this.messages.push(message);
  }

  waitForLoad(): Promise<void> {
    return new Promise((resolve) => {
      this.loadResolver = resolve;
    });
  }

  completeLoad(): void {
    this.loadResolver?.();
  }

  setHeight(height: number): void {
    this.heights.push(height);
  }

  close(): void {}
}
