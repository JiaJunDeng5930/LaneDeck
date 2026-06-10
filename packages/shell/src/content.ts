import type { Diagnostic } from "@lanedeck/protocol";

import type { CurrentContentDescriptor } from "./center";

export type ShellToContentMessage = {
  type: "picker_mode";
  payload: { enabled: boolean };
};

export interface ContentFrameHost {
  setSource(uri: string): void;
  postMessage(message: ShellToContentMessage): void;
  setHeight(height: number): void;
  close(): Promise<void> | void;
}

export interface LoadedContentSession {
  status: "ready";
  descriptor: CurrentContentDescriptor;
  revision: string;
  uri: string;
  reloadCount: number;
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
  loadCurrent(descriptor: CurrentContentDescriptor): Promise<ContentSession>;
  setPickerMode(enabled: boolean): void;
  setHeight(height: number): void;
  close(): Promise<void>;
}

export function createIframeContentLoader(
  host: ContentFrameHost,
): ContentLoader {
  let activeSession: LoadedContentSession | undefined;
  let reloadCount = 0;

  return {
    async loadCurrent(
      descriptor: CurrentContentDescriptor,
    ): Promise<ContentSession> {
      try {
        reloadCount += 1;
        const uri = contentUriFor(descriptor);
        host.setSource(uri);
        activeSession = {
          status: "ready",
          descriptor,
          revision: descriptor.revision,
          uri,
          reloadCount,
          postMessage(message: ShellToContentMessage) {
            host.postMessage(message);
          },
          setHeight(height: number) {
            host.setHeight(height);
          },
          async close() {
            await host.close();
          },
        };
        return activeSession;
      } catch (error) {
        return contentLoadFailure(error, descriptor);
      }
    },
    setPickerMode(enabled: boolean): void {
      activeSession?.postMessage({
        type: "picker_mode",
        payload: { enabled },
      });
    },
    setHeight(height: number): void {
      activeSession?.setHeight(height);
    },
    async close(): Promise<void> {
      activeSession = undefined;
      await host.close();
    },
  };
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
    setHeight(height: number): void {
      iframe.style.height = `${Math.max(0, Math.ceil(height))}px`;
    },
    close(): void {
      iframe.removeAttribute("src");
    },
  };
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
