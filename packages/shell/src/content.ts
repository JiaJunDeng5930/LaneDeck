import type { Diagnostic } from "@lanedeck/protocol";
import type {
  ShellHostContentRoute,
  ShellHostMessage,
  ShellHostState,
} from "@lanedeck/protocol";

import type { CurrentContentDescriptor } from "./center";

export type ShellToContentMessage = ShellHostMessage;

export type ContentHostState = ShellHostState;

export interface ContentFrameHost {
  setSource(uri: string): void;
  postMessage(message: ShellToContentMessage): void;
  setHeight(height: number): void;
  onLoad?(listener: () => void): () => void;
  waitForLoad?(): Promise<void>;
  close(): Promise<void> | void;
}

export interface LoadedContentSession {
  status: "ready";
  descriptor: CurrentContentDescriptor;
  revision: string;
  uri: string;
  reloadCount: number;
  hostState?: ContentHostState;
  postMessage(message: ShellToContentMessage): void;
  setHeight(height: number): void;
  close(): Promise<void>;
}

export interface ContentLoadFailure {
  status: "error";
  descriptor?: CurrentContentDescriptor;
  diagnostics: Diagnostic[];
  error: unknown;
}

export type ContentSession = LoadedContentSession | ContentLoadFailure;

export interface ContentLoader {
  loadCurrent(
    descriptor: CurrentContentDescriptor,
    hostState?: ContentHostState,
  ): Promise<ContentSession>;
  setPickerMode(enabled: boolean): void;
  setHeight(height: number): void;
  close(): Promise<void>;
}

export function createIframeContentLoader(
  host: ContentFrameHost,
): ContentLoader {
  let activeSession: LoadedContentSession | undefined;
  let pendingSession: LoadedContentSession | undefined;
  let reloadCount = 0;
  let pendingLoadCleanup: (() => void) | undefined;
  let pendingInitCleanup: (() => void) | undefined;

  return {
    async loadCurrent(
      descriptor: CurrentContentDescriptor,
      hostState = defaultHostState(descriptor),
    ): Promise<ContentSession> {
      let session: LoadedContentSession | undefined;
      try {
        pendingLoadCleanup?.();
        pendingLoadCleanup = undefined;
        pendingInitCleanup?.();
        pendingInitCleanup = undefined;
        reloadCount += 1;
        const uri = contentUriFor(descriptor);
        session = {
          status: "ready",
          descriptor,
          revision: descriptor.revision,
          uri,
          reloadCount,
          hostState,
          postMessage(message: ShellToContentMessage) {
            host.postMessage(message);
          },
          setHeight(height: number) {
            host.setHeight(height);
          },
          async close() {
            if (activeSession === this) {
              pendingLoadCleanup?.();
              pendingLoadCleanup = undefined;
              pendingInitCleanup?.();
              pendingInitCleanup = undefined;
              activeSession = undefined;
            }
            if (pendingSession === this) {
              pendingLoadCleanup?.();
              pendingLoadCleanup = undefined;
              pendingInitCleanup?.();
              pendingInitCleanup = undefined;
              pendingSession = undefined;
            }
            await host.close();
          },
        };
        pendingSession = session;
        const createdSession = session;
        const sendInit = () => {
          if (
            pendingSession === createdSession ||
            activeSession === createdSession
          ) {
            createdSession.postMessage({
              type: "init",
              payload: {
                hostState: createdSession.hostState ?? hostState,
              },
            });
          }
        };
        host.setSource(uri);
        pendingInitCleanup = startInitRetry(sendInit);
        await waitForFrameLoad(host, (cleanup) => {
          pendingLoadCleanup = cleanup;
        });
        if (pendingLoadCleanup !== undefined) {
          pendingLoadCleanup = undefined;
        }
        pendingInitCleanup?.();
        pendingInitCleanup = undefined;
        if (pendingSession === session) {
          activeSession = session;
          pendingSession = undefined;
          sendInit();
        }
        return session;
      } catch (error) {
        if (pendingSession === session) {
          pendingSession = undefined;
        }
        pendingLoadCleanup?.();
        pendingLoadCleanup = undefined;
        pendingInitCleanup?.();
        pendingInitCleanup = undefined;
        return contentLoadFailure(error, descriptor);
      }
    },
    setPickerMode(enabled: boolean): void {
      if (activeSession !== undefined) {
        const hostState = updateSessionPickerMode(activeSession, enabled);
        activeSession.postMessage({
          type: "host_state",
          payload: { hostState },
        });
      }
      if (pendingSession !== undefined && pendingSession !== activeSession) {
        updateSessionPickerMode(pendingSession, enabled);
      }
    },
    setHeight(height: number): void {
      activeSession?.setHeight(height);
    },
    async close(): Promise<void> {
      pendingLoadCleanup?.();
      pendingLoadCleanup = undefined;
      pendingInitCleanup?.();
      pendingInitCleanup = undefined;
      activeSession = undefined;
      pendingSession = undefined;
      await host.close();
    },
  };
}

function startInitRetry(sendInit: () => void): () => void {
  const retryIntervalMs = 250;
  const maxAttempts = 20;
  let attempts = 0;
  let interval: ReturnType<typeof globalThis.setInterval> | undefined;

  const cleanup = () => {
    if (interval !== undefined) {
      globalThis.clearInterval(interval);
      interval = undefined;
    }
  };
  const tick = () => {
    attempts += 1;
    sendInit();
    if (attempts >= maxAttempts) {
      cleanup();
    }
  };

  tick();
  interval = globalThis.setInterval(tick, retryIntervalMs);
  return cleanup;
}

function updateSessionPickerMode(
  session: LoadedContentSession,
  enabled: boolean,
): ContentHostState {
  const hostState = {
    ...(session.hostState ?? defaultHostState(session.descriptor)),
    pickerEnabled: enabled,
  };
  session.hostState = hostState;
  return hostState;
}

export function createIframeHost(
  iframe: HTMLIFrameElement,
  targetOrigin = "*",
): ContentFrameHost {
  return {
    setSource(uri: string): void {
      iframe.src = uri;
    },
    postMessage(message: ShellToContentMessage): void {
      iframe.contentWindow?.postMessage(message, targetOrigin);
    },
    waitForLoad(): Promise<void> {
      return new Promise((resolve) => {
        const listener = () => {
          iframe.removeEventListener("load", listener);
          resolve();
        };
        iframe.addEventListener("load", listener);
      });
    },
    setHeight(height: number): void {
      iframe.style.height = `${Math.max(0, Math.ceil(height))}px`;
    },
    close(): void {
      iframe.removeAttribute("src");
    },
  };
}

export function defaultHostState(
  descriptor: CurrentContentDescriptor,
): ContentHostState {
  const hostDescriptor = descriptor as CurrentContentDescriptor &
    Partial<ContentHostState>;
  return {
    pickerEnabled: false,
    workspaceId: descriptor.workspaceId,
    contentRevision: descriptor.revision,
    ...(hostDescriptor.centerQueryUrl === undefined
      ? {}
      : { centerQueryUrl: hostDescriptor.centerQueryUrl }),
    ...(hostDescriptor.centerReadToken === undefined
      ? {}
      : { centerReadToken: hostDescriptor.centerReadToken }),
    route: hostDescriptor.route ?? dashboardRoute(descriptor.workspaceId),
  };
}

export function dashboardRoute(workspaceId: string): ShellHostContentRoute {
  return { view: "dashboard", workspaceId };
}

async function waitForFrameLoad(
  host: ContentFrameHost,
  onCleanup: (cleanup: () => void) => void,
): Promise<void> {
  if (host.waitForLoad !== undefined) {
    await host.waitForLoad();
    return;
  }
  if (host.onLoad !== undefined) {
    await new Promise<void>((resolve) => {
      let cleanup: () => void = () => undefined;
      cleanup =
        host.onLoad?.(() => {
          cleanup();
          resolve();
        }) ?? (() => undefined);
      onCleanup(cleanup);
    });
  }
}

export function contentUriFor(descriptor: CurrentContentDescriptor): string {
  if (descriptor.uri !== undefined) {
    return descriptor.uri;
  }
  const workspace = encodeURIComponent(descriptor.workspaceId);
  const revision = encodeURIComponent(descriptor.revision);
  const path = normalizeContentPath(descriptor.path);
  return `lanedeck://content/${workspace}/${revision}/${path}`;
}

export function contentLoadFailure(
  error: unknown,
  descriptor?: CurrentContentDescriptor,
): ContentLoadFailure {
  return {
    status: "error",
    ...(descriptor === undefined ? {} : { descriptor }),
    diagnostics: [
      {
        path: "content",
        message: error instanceof Error ? error.message : "content load failed",
      },
    ],
    error,
  };
}

function normalizeContentPath(path: string): string {
  const withoutLeadingSlash = path.replace(/^\/+/, "");
  const safePath =
    withoutLeadingSlash.length === 0 ? "index.html" : withoutLeadingSlash;
  return safePath.split("/").map(encodeURIComponent).join("/");
}
