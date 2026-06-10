import { protocolPackage, type ShellContentMessage } from "@lanedeck/protocol";

import { ContentError, errorDetail } from "./errors";
import {
  registerPickTarget,
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
        hostState = init.hostState;
        await send({
          type: "ready",
          payload: { package: protocolPackage },
        });

        const route = init.route ?? init.hostState.route;
        if (route !== undefined) {
          await app.render(route);
        }
      } catch (error) {
        renderError("content init failed", error);
        await reportError("content init failed", error);
      }
    },

    async render(route) {
      clearActiveRegistrations();

      try {
        const response = await deps.query.query(dashboardQueryRequest(route));
        const root = resolveRoot();
        const rendered = renderDashboardMarkup(route, response);
        root.innerHTML = rendered.html;
        activeRegistrations = bindRenderedPickTargets(root);
      } catch (error) {
        renderError("content render failed", error);
        await reportError("content render failed", error);
      }
    },

    setHostState(state) {
      hostState = state;
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
      clearActiveRegistrations();
      pickSubscription.unregister();
    },
  };

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

  function clearActiveRegistrations(): void {
    for (const registration of activeRegistrations) {
      registration.unregister();
    }
    activeRegistrations = [];
  }

  return app;
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
