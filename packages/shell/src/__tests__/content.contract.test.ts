import { describe, expect, it, vi } from "vitest";

import {
  contentUriFor,
  createIframeHost,
  createIframeContentLoader,
  type ContentFrameHost,
  type ContentHostState,
  type ContentLoader,
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

  it.each([
    [
      "init",
      {
        type: "init",
        payload: { hostState: bootstrapHostState(false) },
      } satisfies ShellToContentMessage,
    ],
    [
      "host_state",
      {
        type: "host_state",
        payload: { hostState: bootstrapHostState(false) },
      } satisfies ShellToContentMessage,
    ],
  ])(
    "posts token-free lanedeck %s messages to wildcard for opaque content origins",
    (_type, message) => {
      const postMessage = vi.fn();
      const iframe = testIframe(postMessage);
      const host = createIframeHost(iframe);

      host.setSource("lanedeck://content/workspace.local/rev-1/index.html");
      host.postMessage(message);

      expect(postMessage).toHaveBeenCalledWith(message, "*");
    },
  );

  it.each([
    [
      "init",
      {
        type: "init",
        payload: { hostState: hostState(false) },
      } satisfies ShellToContentMessage,
    ],
    [
      "host_state",
      {
        type: "host_state",
        payload: { hostState: hostState(false) },
      } satisfies ShellToContentMessage,
    ],
  ])(
    "downgrades wildcard copies of token-bearing lanedeck %s messages to picker-only host state",
    (_type, message) => {
      const postMessage = vi.fn();
      const iframe = testIframe(postMessage);
      const host = createIframeHost(iframe);

      host.setSource("lanedeck://content/workspace.local/rev-1/index.html");
      host.postMessage(message);

      const calls = postMessage.mock.calls;
      expect(calls).toEqual(
        expect.arrayContaining([
          [message, "lanedeck://content"],
          [message, "http://lanedeck.localhost"],
          [message, "https://lanedeck.localhost"],
          [message, "lanedeck://localhost"],
        ]),
      );
      const wildcardCalls = calls.filter((call) => call[1] === "*");
      for (const [wildcardMessage] of wildcardCalls) {
        expect(wildcardMessage).toEqual({
          type: message.type,
          payload: { hostState: bootstrapHostState(false) },
        });
        for (const field of [
          "centerReadToken",
          "centerQueryUrl",
          "route",
          "workspaceId",
          "contentRevision",
        ]) {
          const wildcardHostState = (
            wildcardMessage as {
              payload: { hostState: Record<string, unknown> };
            }
          ).payload.hostState;
          expect(wildcardHostState).not.toHaveProperty(field);
        }
      }
    },
  );

  it("continues strict-origin delivery after one generated origin rejects postMessage", () => {
    const delivered: Array<[ShellToContentMessage, string]> = [];
    const postMessage = vi.fn(
      (sentMessage: ShellToContentMessage, targetOrigin: string) => {
        if (targetOrigin === "http://lanedeck.localhost") {
          throw new SyntaxError("invalid target origin");
        }
        delivered.push([sentMessage, targetOrigin]);
      },
    );
    const iframe = testIframe(postMessage);
    const host = createIframeHost(iframe);
    const message: ShellToContentMessage = {
      type: "host_state",
      payload: { hostState: hostState(false) },
    };
    const wildcardMessage: ShellToContentMessage = {
      type: "host_state",
      payload: { hostState: bootstrapHostState(false) },
    };

    host.setSource("lanedeck://content/workspace.local/rev-1/index.html");

    expect(() => host.postMessage(message)).not.toThrow();
    expect(postMessage).toHaveBeenCalledWith(
      message,
      "http://lanedeck.localhost",
    );
    expect(delivered).toEqual(
      expect.arrayContaining([
        [wildcardMessage, "*"],
        [message, "lanedeck://content"],
        [message, "https://lanedeck.localhost"],
        [message, "lanedeck://localhost"],
      ]),
    );
  });

  it.each([
    [
      "https",
      "https://content.example.test/workspace.local/rev-1/index.html",
      "https://content.example.test",
    ],
    [
      "http",
      "http://localhost:4173/workspace.local/rev-1/index.html",
      "http://localhost:4173",
    ],
  ])("posts %s iframe messages to URL.origin", (_scheme, uri, origin) => {
    const postMessage = vi.fn();
    const iframe = testIframe(postMessage);
    const host = createIframeHost(iframe);
    const message: ShellToContentMessage = {
      type: "host_state",
      payload: { hostState: bootstrapHostState(true) },
    };

    host.setSource(uri);
    host.postMessage(message);

    expect(postMessage).toHaveBeenCalledWith(message, origin);
    expect(postMessage.mock.calls[0]?.[1]).not.toBe("*");
  });

  it("sends bootstrap init before load and full host state after load", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    const descriptor = descriptorWithHostState();

    const session = loader.loadCurrent(descriptor);
    await Promise.resolve();

    expect(host.messages).toContainEqual({
      type: "init",
      payload: { hostState: bootstrapHostState(false) },
    });

    host.completeLoad();

    await expect(session).resolves.toMatchObject({
      status: "ready",
      revision: "rev-1",
      reloadCount: 1,
    });
    expect(host.messages.at(-1)).toEqual({
      type: "host_state",
      payload: { hostState: hostState(false) },
    });
  });

  it("sends full init before full host state when iframe load completes immediately", async () => {
    const host = new ImmediateLoadFrameHost();
    const loader = createIframeContentLoader(host);

    await expect(
      loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-1",
          path: "index.html",
        },
        hostState(false),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      revision: "rev-1",
      reloadCount: 1,
    });

    expect(host.messages).toEqual([
      {
        type: "init",
        payload: { hostState: bootstrapHostState(false) },
      },
      {
        type: "init",
        payload: { hostState: hostState(false) },
      },
      {
        type: "host_state",
        payload: { hostState: hostState(false) },
      },
    ]);
  });

  it("retries bootstrap init with latest picker state before full host state", async () => {
    vi.useFakeTimers();
    try {
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

      expect(host.messages.at(-1)).toEqual({
        type: "init",
        payload: { hostState: bootstrapHostState(false) },
      });

      loader.setPickerMode(true);
      await vi.advanceTimersByTimeAsync(250);

      expect(host.messages.at(-1)).toEqual({
        type: "init",
        payload: { hostState: bootstrapHostState(true) },
      });

      host.completeLoad();

      await expect(session).resolves.toMatchObject({
        status: "ready",
        revision: "rev-1",
        reloadCount: 1,
      });
      expect(host.messages.at(-1)).toEqual({
        type: "host_state",
        payload: { hostState: hostState(true) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps bootstrap init token-free when switching from external to generated content", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);

    const external = loader.loadCurrent(
      {
        workspaceId: "workspace.local",
        revision: "rev-external",
        path: "index.html",
        uri: "https://evil.example/app.html",
      },
      hostState(false, "rev-external"),
    );
    await Promise.resolve();
    expect(host.messages).toEqual([
      {
        type: "init",
        payload: { hostState: bootstrapHostState(false) },
      },
    ]);
    host.completeLoad();
    await expect(external).resolves.toMatchObject({ status: "ready" });
    host.messages.length = 0;

    const generated = loader.loadCurrent(
      {
        workspaceId: "workspace.local",
        revision: "rev-1",
        path: "index.html",
      },
      hostState(false, "rev-1"),
    );
    await Promise.resolve();

    expect(host.messages).toEqual([
      {
        type: "init",
        payload: { hostState: bootstrapHostState(false) },
      },
    ]);

    host.completeLoad();
    await expect(generated).resolves.toMatchObject({ status: "ready" });
    expect(host.messages.at(-1)).toEqual({
      type: "host_state",
      payload: { hostState: hostState(false, "rev-1") },
    });
  });

  it("forwards picker mode as picker-only host state and height changes to the active frame", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    await loadReady(loader.loadCurrent(descriptorWithHostState()), host);

    loader.setPickerMode(true);
    loader.setHeight(240.2);

    expect(host.messages).toContainEqual({
      type: "init",
      payload: { hostState: bootstrapHostState(false) },
    });
    expect(host.messages.at(-1)).toEqual({
      type: "host_state",
      payload: { hostState: bootstrapHostState(true) },
    });
    expect(host.heights).toEqual([240.2]);
  });

  it("keeps the previous ready session active when replacement setSource fails", async () => {
    const host = new FakeFrameHost();
    const loader = createIframeContentLoader(host);
    await loadReady(
      loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-1",
          path: "index.html",
        },
        hostState(false, "rev-1"),
      ),
      host,
    );
    host.messages.length = 0;
    host.heights.length = 0;

    host.throwOnNextSetSource(new Error("replacement source failed"));
    const replacement = loader.loadCurrent(
      {
        workspaceId: "workspace.local",
        revision: "rev-2",
        path: "index.html",
      },
      hostState(false, "rev-2"),
    );
    await Promise.resolve();
    host.completeLoad();

    await expect(replacement).resolves.toMatchObject({ status: "error" });

    loader.setPickerMode(true);
    loader.setHeight(360);

    expect(host.messages).toContainEqual({
      type: "init",
      payload: { hostState: bootstrapHostState(false) },
    });
    expect(host.messages).toContainEqual({
      type: "init",
      payload: { hostState: hostState(false, "rev-1") },
    });
    expect(host.messages.at(-1)).toEqual({
      type: "host_state",
      payload: { hostState: bootstrapHostState(true) },
    });
    expect(host.heights).toEqual([360]);
  });

  it("returns a load failure after a bounded iframe load timeout", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeFrameHost();
      const loader = createTimedIframeContentLoader(host, { loadTimeoutMs: 5 });
      await loadReady(
        loader.loadCurrent(
          {
            workspaceId: "workspace.local",
            revision: "rev-1",
            path: "index.html",
          },
          hostState(false, "rev-1"),
        ),
        host,
      );
      host.messages.length = 0;
      host.heights.length = 0;

      const replacement = loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-2",
          path: "index.html",
        },
        hostState(false, "rev-2"),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6);
      await drainAsyncWork();
      host.completeLoad();
      await drainAsyncWork();

      const result = await Promise.race([
        replacement,
        Promise.resolve("still-pending" as const),
      ]);
      expect(result).toMatchObject({ status: "error" });
      expect(host.currentSource).toBe(
        "lanedeck://content/workspace.local/rev-1/index.html",
      );

      loader.setPickerMode(true);
      loader.setHeight(420);

      expect(host.messages).toContainEqual({
        type: "host_state",
        payload: { hostState: bootstrapHostState(true) },
      });
      expect(host.heights).toEqual([420]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reinitializes the previous session after replacement load timeout restores its uri", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeFrameHost();
      const loader = createTimedIframeContentLoader(host, { loadTimeoutMs: 5 });
      await loadReady(
        loader.loadCurrent(
          {
            workspaceId: "workspace.local",
            revision: "rev-1",
            path: "index.html",
          },
          hostState(true, "rev-1"),
        ),
        host,
      );
      host.messages.length = 0;

      const replacement = loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-2",
          path: "index.html",
        },
        hostState(false, "rev-2"),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6);
      await drainAsyncWork();
      host.completeLoad();
      await drainAsyncWork();

      await expect(replacement).resolves.toMatchObject({ status: "error" });
      expect(host.currentSource).toBe(
        "lanedeck://content/workspace.local/rev-1/index.html",
      );
      expect(host.messages).toContainEqual({
        type: "init",
        payload: { hostState: bootstrapHostState(true) },
      });
      expect(host.messages).toContainEqual({
        type: "init",
        payload: { hostState: hostState(true, "rev-1") },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps superseding load cleanup scoped to the load that failed", async () => {
    vi.useFakeTimers();
    try {
      const host = new ListenerFrameHost();
      const loader = createTimedIframeContentLoader(host, {
        loadTimeoutMs: 1000,
      });

      const first = loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-1",
          path: "index.html",
        },
        hostState(false, "rev-1"),
      );
      await Promise.resolve();
      expect(host.activeLoadListenerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      const second = loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-2",
          path: "index.html",
        },
        hostState(true, "rev-2"),
      );
      await Promise.resolve();
      expect(host.activeLoadListenerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(2);
      await drainAsyncWork();

      await expect(first).resolves.toMatchObject({ status: "error" });
      expect(host.activeLoadListenerCount()).toBe(1);

      const messageCountAfterFirstFailure = host.messages.length;
      await vi.advanceTimersByTimeAsync(250);
      expect(host.messages.slice(messageCountAfterFirstFailure)).toContainEqual(
        {
          type: "init",
          payload: { hostState: bootstrapHostState(true) },
        },
      );

      host.completeLoad();
      await drainAsyncWork();

      await expect(second).resolves.toMatchObject({
        status: "ready",
        revision: "rev-2",
      });
      expect(host.messages).toContainEqual({
        type: "init",
        payload: { hostState: hostState(true, "rev-2") },
      });
      expect(host.messages).toContainEqual({
        type: "host_state",
        payload: { hostState: hostState(true, "rev-2") },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the frame when initial iframe load times out", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeFrameHost();
      const loader = createTimedIframeContentLoader(host, { loadTimeoutMs: 5 });

      const session = loader.loadCurrent(
        {
          workspaceId: "workspace.local",
          revision: "rev-1",
          path: "index.html",
        },
        hostState(false, "rev-1"),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6);

      const result = await Promise.race([
        session,
        Promise.resolve("still-pending" as const),
      ]);

      expect(result).toMatchObject({ status: "error" });
      expect(host.currentSource).toBeUndefined();
      expect(host.closeCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

function hostState(
  pickerEnabled: boolean,
  contentRevision = "rev-1",
): ContentHostState {
  return {
    pickerEnabled,
    workspaceId: "workspace.local",
    contentRevision,
    centerQueryUrl: "https://center.example.test/api/query",
    centerReadToken: "read-token",
    route: {
      view: "dashboard",
      workspaceId: "workspace.local",
      laneId: "lane.build",
    },
  };
}

function bootstrapHostState(pickerEnabled: boolean): ContentHostState {
  return { pickerEnabled };
}

async function loadReady(
  session: Promise<ContentSession>,
  host: FakeFrameHost,
): Promise<void> {
  host.completeLoad();
  await expect(session).resolves.toMatchObject({ status: "ready" });
}

async function drainAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createTimedIframeContentLoader(
  host: ContentFrameHost,
  options: { loadTimeoutMs: number },
): ContentLoader {
  return (
    createIframeContentLoader as unknown as (
      host: ContentFrameHost,
      options: { loadTimeoutMs: number },
    ) => ContentLoader
  )(host, options);
}

function testIframe(postMessage: ReturnType<typeof vi.fn>): HTMLIFrameElement {
  return {
    src: "",
    contentWindow: { postMessage },
    style: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    removeAttribute: vi.fn(),
  } as unknown as HTMLIFrameElement;
}

class FakeFrameHost implements ContentFrameHost {
  readonly sources: string[] = [];
  readonly messages: unknown[] = [];
  readonly heights: number[] = [];
  currentSource: string | undefined;
  closeCount = 0;
  private loadResolver: (() => void) | undefined;
  private nextSetSourceError: Error | undefined;

  setSource(uri: string): void {
    if (this.nextSetSourceError !== undefined) {
      const error = this.nextSetSourceError;
      this.nextSetSourceError = undefined;
      throw error;
    }
    this.sources.push(uri);
    this.currentSource = uri;
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

  throwOnNextSetSource(error: Error): void {
    this.nextSetSourceError = error;
  }

  setHeight(height: number): void {
    this.heights.push(height);
  }

  close(): void {
    this.closeCount += 1;
    this.currentSource = undefined;
  }
}

class ListenerFrameHost implements ContentFrameHost {
  readonly sources: string[] = [];
  readonly messages: unknown[] = [];
  readonly heights: number[] = [];
  currentSource: string | undefined;
  closeCount = 0;
  private readonly loadListeners: Array<{
    active: boolean;
    listener: () => void;
  }> = [];

  setSource(uri: string): void {
    this.sources.push(uri);
    this.currentSource = uri;
  }

  postMessage(message: ShellToContentMessage): void {
    this.messages.push(message);
  }

  onLoad(listener: () => void): () => void {
    const entry = { active: true, listener };
    this.loadListeners.push(entry);
    return () => {
      entry.active = false;
    };
  }

  completeLoad(): void {
    for (const entry of [...this.loadListeners]) {
      if (entry.active) {
        entry.listener();
      }
    }
  }

  activeLoadListenerCount(): number {
    return this.loadListeners.filter((entry) => entry.active).length;
  }

  setHeight(height: number): void {
    this.heights.push(height);
  }

  close(): void {
    this.closeCount += 1;
    this.currentSource = undefined;
  }
}

class ImmediateLoadFrameHost extends FakeFrameHost {
  override waitForLoad(): Promise<void> {
    return Promise.resolve();
  }
}
