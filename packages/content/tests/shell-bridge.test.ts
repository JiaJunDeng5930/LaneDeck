import { describe, expect, it, vi } from "vitest";

import {
  ContentError,
  createWindowShellBridge,
  parseContentRoute,
  parseShellHostStateMessage,
  parseShellInitMessage,
} from "../src/index";

describe("window shell bridge", () => {
  it("accepts init messages only from the configured shell", async () => {
    const window = new TestWindow();
    const bridge = createWindowShellBridge({
      window: window as unknown as Window,
      shellOrigin: "https://shell.example",
    });
    const init = bridge.waitForInit();

    window.dispatch(
      {
        type: "init",
        payload: { hostState: { pickerEnabled: true } },
      },
      { postMessage: vi.fn() },
      "https://shell.example",
    );
    window.dispatch(
      {
        type: "init",
        payload: { hostState: { pickerEnabled: true } },
      },
      window.parent,
      "https://other.example",
    );
    window.dispatch(
      {
        type: "init",
        payload: {
          hostState: {
            pickerEnabled: true,
            centerQueryUrl: "https://center.example.test/api/query",
            centerReadToken: "shell-read-token",
          },
        },
      },
      window.parent,
      "https://shell.example",
    );

    await expect(init).resolves.toEqual({
      hostState: {
        pickerEnabled: true,
        centerQueryUrl: "https://center.example.test/api/query",
        centerReadToken: "shell-read-token",
      },
    });
  });

  it("subscribes to trusted host state messages after init", () => {
    const window = new TestWindow();
    const bridge = createWindowShellBridge({
      window: window as unknown as Window,
      shellOrigin: "https://shell.example",
    });
    const states: unknown[] = [];
    const subscription = bridge.subscribeHostState?.((state) => {
      states.push(state);
    });

    window.dispatch(
      {
        type: "host_state",
        payload: { hostState: { pickerEnabled: true } },
      },
      { postMessage: vi.fn() },
      "https://shell.example",
    );
    window.dispatch(
      {
        type: "host_state",
        payload: {
          hostState: {
            pickerEnabled: true,
            centerQueryUrl: "https://center.example.test/api/query",
            centerReadToken: "shell-read-token",
          },
        },
      },
      window.parent,
      "https://shell.example",
    );

    expect(states).toEqual([
      {
        pickerEnabled: true,
        centerQueryUrl: "https://center.example.test/api/query",
        centerReadToken: "shell-read-token",
      },
    ]);

    subscription?.unsubscribe();
    window.dispatch(
      {
        type: "host_state",
        payload: { hostState: { pickerEnabled: false } },
      },
      window.parent,
      "https://shell.example",
    );
    expect(states).toHaveLength(1);
  });

  it("rejects non-boolean picker state", () => {
    expect(() =>
      parseShellInitMessage({
        type: "init",
        payload: { hostState: { pickerEnabled: "true" } },
      }),
    ).toThrow(ContentError);
  });

  it("rejects non-string center read tokens", () => {
    expect(() =>
      parseShellInitMessage({
        type: "init",
        payload: { hostState: { pickerEnabled: true, centerReadToken: 42 } },
      }),
    ).toThrow(ContentError);

    expect(() =>
      parseShellHostStateMessage({
        type: "host_state",
        payload: { hostState: { pickerEnabled: true, centerReadToken: 42 } },
      }),
    ).toThrow(ContentError);
  });

  it("rejects route params outside protocol JSON", () => {
    expect(() =>
      parseContentRoute({
        view: "dashboard",
        workspaceId: "workspace.local",
        params: { threshold: Number.NaN },
      }),
    ).toThrow(ContentError);

    expect(() =>
      parseContentRoute({
        view: "custom",
        workspaceId: "workspace.local",
        query: "events",
        params: { since: new Date("2026-06-11T00:00:00.000Z") },
      }),
    ).toThrow(ContentError);
  });
});

class TestWindow {
  readonly parent = { postMessage: vi.fn() };
  private listeners = new Set<(event: MessageEvent<unknown>) => void>();

  setTimeout(_handler: TimerHandler, _timeout?: number): number {
    return 1;
  }

  clearTimeout(_handle?: number): void {
    return;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === "message") {
      this.listeners.add(listener);
    }
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === "message") {
      this.listeners.delete(listener);
    }
  }

  dispatch(data: unknown, source: unknown, origin: string): void {
    for (const listener of this.listeners) {
      listener({ data, source, origin } as MessageEvent<unknown>);
    }
  }
}
