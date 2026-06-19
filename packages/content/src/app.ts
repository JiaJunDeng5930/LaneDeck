import { protocolPackage, type ShellContentMessage } from "@lanedeck/protocol";

import { ContentError, errorDetail } from "./errors";
import {
  registerPickTarget,
  setPickerListening,
  subscribePickTargets,
  type PickRegistration,
  type PickTarget,
} from "./picker";
import {
  dashboardQueryRequest,
  type CenterQueryClient,
  type ContentRoute,
} from "./query";
import type { ShellBridge, ShellHostState } from "./shell";
import type { ShellSubscription } from "./shell";
import { renderDashboardMarkup, renderErrorMarkup } from "./views";

export interface ContentDeps {
  query: CenterQueryClient;
  shell: ShellBridge;
}

export interface ContentApp {
  init(): Promise<void>;
  render(route: ContentRoute): Promise<void>;
  setHostState(state: ShellHostState): void;
  reportPickTarget(target: PickTarget): void;
  dispose(): void;
}

export function createContentApp(deps: ContentDeps): ContentApp {
  let hostState: ShellHostState = { pickerEnabled: false };
  let activeRegistrations: PickRegistration[] = [];
  let renderSequence = 0;
  let currentRoute: ContentRoute | undefined;
  let pendingRoute: ContentRoute | undefined;
  let retryRouteAfterFailure: ContentRoute | undefined;
  let disposed = false;

  const pickSubscription = subscribePickTargets((target) => {
    if (hostState.pickerEnabled) {
      app.reportPickTarget(target);
    }
  });

  const app: ContentApp = {
    async init() {
      try {
        const init = await deps.shell.waitForInit();
        if (disposed) {
          return;
        }

        applyHostState(init.hostState);
        await send({
          type: "ready",
          payload: { package: protocolPackage },
        });

        const route = init.route ?? init.hostState.route;
        if (route !== undefined) {
          await app.render(route);
        }
      } catch (error) {
        if (disposed) {
          return;
        }

        renderError("content init failed", error);
        await reportHeight();
        await reportError("content init failed", error);
      }
    },

    async render(route) {
      const sequence = (renderSequence += 1);
      pendingRoute = route;
      retryRouteAfterFailure = undefined;
      clearActiveRegistrations();

      try {
        const response = await deps.query.query(dashboardQueryRequest(route));
        if (sequence !== renderSequence || disposed) {
          return;
        }

        const root = resolveRoot();
        const rendered = renderDashboardMarkup(route, response);
        root.innerHTML = rendered.html;
        activeRegistrations = bindRenderedPickTargets(root);
        currentRoute = route;
        pendingRoute = undefined;
        retryRouteAfterFailure = undefined;
        await reportHeight();
      } catch (error) {
        if (sequence !== renderSequence || disposed) {
          return;
        }

        const retryRoute = retryRouteAfterFailure;
        pendingRoute = undefined;
        retryRouteAfterFailure = undefined;
        if (retryRoute !== undefined && sameContentRoute(route, retryRoute)) {
          await app.render(retryRoute);
          return;
        }

        renderError("content render failed", error);
        await reportHeight();
        await reportError("content render failed", error);
      }
    },

    setHostState(state) {
      const nextRoute = state.route;
      const shouldRetryPendingRoute =
        nextRoute !== undefined &&
        pendingRoute !== undefined &&
        sameContentRoute(pendingRoute, nextRoute) &&
        hasQueryAccessPatch(state);
      const shouldRender =
        nextRoute !== undefined &&
        !sameContentRoute(pendingRoute ?? currentRoute, nextRoute);
      applyHostState(state);
      if (shouldRetryPendingRoute) {
        retryRouteAfterFailure = nextRoute;
      }
      if (shouldRender) {
        void app.render(nextRoute);
      }
    },

    reportPickTarget(target) {
      void send({
        type: "pick_result",
        payload: { pickId: target.pickId },
      }).catch((error: unknown) => {
        void reportError("content pick report failed", error);
      });
    },

    dispose() {
      disposed = true;
      renderSequence += 1;
      setPickerListening(false);
      clearActiveRegistrations();
      hostStateSubscription?.unsubscribe();
      pickSubscription.unregister();
    },
  };

  const hostStateSubscription: ShellSubscription | undefined =
    deps.shell.subscribeHostState?.((state) => {
      if (!disposed) {
        app.setHostState(state);
      }
    });

  async function send(message: ShellContentMessage): Promise<void> {
    if (!disposed) {
      await deps.shell.send(message);
    }
  }

  async function reportError(message: string, error: unknown): Promise<void> {
    try {
      await send({
        type: "error_report",
        payload: {
          message,
          detail: errorDetail(error),
        },
      });
    } catch {
      return;
    }
  }

  function renderError(message: string, error: unknown): void {
    try {
      resolveRoot().innerHTML = renderErrorMarkup(message, errorDetail(error));
    } catch {
      return;
    }
  }

  async function reportHeight(): Promise<void> {
    try {
      await send({
        type: "height_changed",
        payload: { height: measureContentHeight() },
      });
    } catch {
      return;
    }
  }

  function measureContentHeight(): number {
    const root = globalThis.document?.getElementById("root");
    const body = globalThis.document?.body;
    const documentElement = globalThis.document?.documentElement;

    return Math.ceil(
      Math.max(
        root?.scrollHeight ?? 0,
        body?.scrollHeight ?? 0,
        documentElement?.scrollHeight ?? 0,
      ),
    );
  }

  function clearActiveRegistrations(): void {
    for (const registration of activeRegistrations) {
      registration.unregister();
    }
    activeRegistrations = [];
  }

  function applyHostState(state: ShellHostState): void {
    hostState = { ...hostState, ...state };
    setPickerListening(state.pickerEnabled);
    if (state.centerQueryUrl !== undefined) {
      deps.query.setQueryUrl?.(state.centerQueryUrl);
    }
    if (state.centerReadToken !== undefined) {
      deps.query.setReadToken?.(state.centerReadToken);
    }
  }

  return app;
}

function sameContentRoute(
  current: ContentRoute | undefined,
  next: ContentRoute,
): boolean {
  if (current === undefined || current.view !== next.view) {
    return false;
  }
  if (current.workspaceId !== next.workspaceId) {
    return false;
  }
  if (current.view === "dashboard" && next.view === "dashboard") {
    return (
      current.laneId === next.laneId &&
      stableJsonKey(current.params ?? {}) === stableJsonKey(next.params ?? {})
    );
  }
  if (current.view === "custom" && next.view === "custom") {
    return (
      current.query === next.query &&
      current.title === next.title &&
      stableJsonKey(current.params ?? {}) === stableJsonKey(next.params ?? {})
    );
  }
  return false;
}

function hasQueryAccessPatch(state: ShellHostState): boolean {
  return (
    state.centerQueryUrl !== undefined || state.centerReadToken !== undefined
  );
}

function stableJsonKey(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map(stableJsonKey).join(",")}]`;
  }
  if (typeof input === "object" && input !== null) {
    return `{${Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJsonKey(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input) ?? "undefined";
}

function resolveRoot(): HTMLElement {
  const root = globalThis.document?.getElementById("root");
  if (root === null || root === undefined) {
    throw new ContentError("content root element #root is missing");
  }

  return root;
}

function bindRenderedPickTargets(root: HTMLElement): PickRegistration[] {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>("[data-pick-id]"),
  );

  return elements.map((element) =>
    registerPickTarget({
      pickId: element.getAttribute("data-pick-id") ?? "content.unknown",
      element,
    }),
  );
}
