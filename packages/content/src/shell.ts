import {
  parseShellContentMessage,
  type JsonObject,
  type ShellContentMessage,
} from "@lanedeck/protocol";

import { ContentError } from "./errors";
import type { ContentRoute } from "./query";

export interface ShellHostState {
  pickerEnabled: boolean;
  workspaceId?: string;
  centerQueryEndpoint?: string;
  contentRevision?: string;
  route?: ContentRoute;
}

export interface ShellInitMessage {
  hostState: ShellHostState;
  route?: ContentRoute;
}

export interface ShellBridge {
  waitForInit(): Promise<ShellInitMessage>;
  send(message: ShellContentMessage): Promise<void>;
  subscribeHostState?(
    listener: (state: ShellHostState) => void,
  ): ShellSubscription;
}

export interface ShellSubscription {
  unsubscribe(): void;
}

export interface WindowShellBridgeOptions {
  window?: Window;
  targetOrigin?: string;
  shellOrigin?: string;
  initTimeoutMs?: number;
}

export function createWindowShellBridge(
  options: WindowShellBridgeOptions = {},
): ShellBridge {
  const windowRef = options.window ?? globalThis.window;
  const targetOrigin = options.targetOrigin ?? "*";
  const shellOrigin =
    options.shellOrigin ?? (targetOrigin === "*" ? undefined : targetOrigin);
  const initTimeoutMs = options.initTimeoutMs ?? 5_000;

  return {
    waitForInit() {
      return new Promise((resolve, reject) => {
        const timeout = windowRef.setTimeout(() => {
          windowRef.removeEventListener("message", handleMessage);
          reject(new ContentError("shell init timed out"));
        }, initTimeoutMs);

        const handleMessage = (event: MessageEvent<unknown>) => {
          if (!isTrustedShellEvent(event, windowRef, shellOrigin)) {
            return;
          }

          try {
            const init = parseShellInitMessage(event.data);
            if (init === undefined) {
              return;
            }

            windowRef.clearTimeout(timeout);
            windowRef.removeEventListener("message", handleMessage);
            resolve(init);
          } catch (error) {
            windowRef.clearTimeout(timeout);
            windowRef.removeEventListener("message", handleMessage);
            reject(error);
          }
        };

        windowRef.addEventListener("message", handleMessage);
      });
    },
    async send(message) {
      parseShellContentMessage(message);
      windowRef.parent.postMessage(message, targetOrigin);
    },
    subscribeHostState(listener) {
      const handleMessage = (event: MessageEvent<unknown>) => {
        if (!isTrustedShellEvent(event, windowRef, shellOrigin)) {
          return;
        }

        const state = parseShellHostStateMessage(event.data);
        if (state !== undefined) {
          listener(state);
        }
      };

      windowRef.addEventListener("message", handleMessage);

      return {
        unsubscribe() {
          windowRef.removeEventListener("message", handleMessage);
        },
      };
    },
  };
}

function isTrustedShellEvent(
  event: MessageEvent<unknown>,
  windowRef: Window,
  shellOrigin: string | undefined,
): boolean {
  return (
    event.source === windowRef.parent &&
    (shellOrigin === undefined || event.origin === shellOrigin)
  );
}

export function parseShellInitMessage(
  input: unknown,
): ShellInitMessage | undefined {
  if (!isRecord(input) || input.type !== "init") {
    return undefined;
  }

  const payload = recordAt(input, "payload");
  const hostState = parseHostState(payload.hostState);
  const route = parseContentRoute(payload.route ?? hostState.route);

  return route === undefined ? { hostState } : { hostState, route };
}

export function parseShellHostStateMessage(
  input: unknown,
): ShellHostState | undefined {
  if (!isRecord(input) || input.type !== "host_state") {
    return undefined;
  }

  const payload = recordAt(input, "payload");
  return parseHostState(payload.hostState ?? payload);
}

export function parseContentRoute(input: unknown): ContentRoute | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!isRecord(input)) {
    throw new ContentError("content route must be an object");
  }

  const view = input.view;
  if (view === "dashboard") {
    const workspaceId = stringAt(input, "workspaceId");
    const laneId = optionalStringAt(input, "laneId");
    const params = optionalJsonObjectAt(input, "params");

    return {
      view,
      workspaceId,
      ...(laneId === undefined ? {} : { laneId }),
      ...(params === undefined ? {} : { params }),
    };
  }

  if (view === "custom") {
    const workspaceId = stringAt(input, "workspaceId");
    const query = stringAt(input, "query");
    const title = optionalStringAt(input, "title");
    const params = optionalJsonObjectAt(input, "params");

    return {
      view,
      workspaceId,
      query,
      ...(title === undefined ? {} : { title }),
      ...(params === undefined ? {} : { params }),
    };
  }

  throw new ContentError("content route view must be dashboard or custom");
}

function parseHostState(input: unknown): ShellHostState {
  const state = recordAt({ state: input }, "state");
  const pickerEnabled = state.pickerEnabled === true;
  const workspaceId = optionalStringAt(state, "workspaceId");
  const centerQueryEndpoint = optionalStringAt(state, "centerQueryEndpoint");
  const contentRevision = optionalStringAt(state, "contentRevision");
  const route = parseContentRoute(state.route);

  return {
    pickerEnabled,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(centerQueryEndpoint === undefined ? {} : { centerQueryEndpoint }),
    ...(contentRevision === undefined ? {} : { contentRevision }),
    ...(route === undefined ? {} : { route }),
  };
}

function optionalJsonObjectAt(
  input: Record<string, unknown>,
  key: string,
): JsonObject | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new ContentError(`${key} must be an object`);
  }

  return value;
}

function recordAt(input: Record<string, unknown>, key: string): JsonObject {
  const value = input[key];
  if (!isRecord(value)) {
    throw new ContentError(`${key} must be an object`);
  }

  return value;
}

function stringAt(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new ContentError(`${key} must be a string`);
  }

  return value;
}

function optionalStringAt(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ContentError(`${key} must be a string`);
  }

  return value;
}

function isRecord(input: unknown): input is JsonObject {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype
  );
}
