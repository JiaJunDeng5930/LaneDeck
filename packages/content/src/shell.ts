import {
  ProtocolError,
  parseShellHostContentRoute,
  parseShellHostMessage,
  parseShellContentMessage,
  type JsonObject,
  type ShellContentMessage,
  type ShellHostState as ProtocolShellHostState,
} from "@lanedeck/protocol";

import { ContentError } from "./errors";
import type { ContentRoute } from "./query";

export interface ShellHostState extends Omit<ProtocolShellHostState, "route"> {
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

  const message = parseHostMessage(input);
  if (message.type !== "init") {
    return undefined;
  }

  const hostState = message.payload.hostState as ShellHostState;
  const route = (message.payload.route ?? hostState.route) as
    | ContentRoute
    | undefined;

  return route === undefined ? { hostState } : { hostState, route };
}

export function parseShellHostStateMessage(
  input: unknown,
): ShellHostState | undefined {
  if (!isRecord(input) || input.type !== "host_state") {
    return undefined;
  }

  const message = parseHostMessage(input);
  if (message.type !== "host_state") {
    return undefined;
  }

  return message.payload.hostState as ShellHostState;
}

export function parseContentRoute(input: unknown): ContentRoute | undefined {
  if (input === undefined) {
    return undefined;
  }

  return parseProtocolRoute(input) as ContentRoute;
}

function isRecord(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseHostMessage(input: unknown) {
  try {
    return parseShellHostMessage(input);
  } catch (error) {
    throw contentErrorFromProtocol(error);
  }
}

function parseProtocolRoute(input: unknown) {
  try {
    return parseShellHostContentRoute(input);
  } catch (error) {
    throw contentErrorFromProtocol(error);
  }
}

function contentErrorFromProtocol(error: unknown): ContentError {
  if (error instanceof ProtocolError) {
    return new ContentError(
      "shell host message is invalid",
      JSON.stringify(error.diagnostics),
    );
  }
  if (error instanceof Error) {
    return new ContentError(error.message);
  }
  return new ContentError("shell host message is invalid");
}
