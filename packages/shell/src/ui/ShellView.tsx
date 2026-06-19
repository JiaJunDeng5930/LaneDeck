import { useEffect, useRef, useState } from "react";

import {
  centerLiveUrl,
  contentMessageOriginPolicyForUri,
  createBrowserDiagnosticReporter,
  createHttpCenterClient,
  createIframeContentLoader,
  createIframeHost,
  createNavigatorClipboardWriter,
  createShellApp,
  createWebSocketLiveClient,
  type ShellApp,
} from "../index";

const centerBaseUrl =
  import.meta.env.VITE_LANEDECK_CENTER_URL ?? "http://localhost:8787";
const workspaceId =
  import.meta.env.VITE_LANEDECK_WORKSPACE_ID ?? "workspace.local";
const readToken = import.meta.env.VITE_LANEDECK_READ_TOKEN ?? "";
const contentBaseUrl = import.meta.env.VITE_LANEDECK_CONTENT_BASE_URL ?? "";

export interface ShellViewReadiness {
  contentReady: boolean;
  liveReady: boolean;
  startupSettled: boolean;
}

export function shellVisibleStatusForReadiness(
  readiness: ShellViewReadiness,
): "Ready" | "Waiting for live" | "Content error" | undefined {
  if (
    readiness.startupSettled &&
    readiness.contentReady &&
    readiness.liveReady
  ) {
    return "Ready";
  }
  if (readiness.startupSettled && readiness.contentReady) {
    return "Waiting for live";
  }
  if (readiness.startupSettled && !readiness.contentReady) {
    return "Content error";
  }
  return undefined;
}

export function ShellView() {
  const appRef = useRef<ShellApp | undefined>(undefined);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readinessRef = useRef({
    contentReady: false,
    liveReady: false,
    startupSettled: false,
  });
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState("Starting");
  const [pickerEnabled, setPickerEnabled] = useState(false);

  const updateStatusFromReadiness = () => {
    const nextStatus = shellVisibleStatusForReadiness(readinessRef.current);
    if (nextStatus !== undefined) {
      setStatus(nextStatus);
    }
  };

  useEffect(() => {
    if (iframe === null) {
      return undefined;
    }

    const center = createHttpCenterClient({
      baseUrl: centerBaseUrl,
      workspaceId,
      readToken,
      contentBaseUrl,
      reportProtocolDiagnostic: createBrowserDiagnosticReporter(),
    });
    const live = createWebSocketLiveClient({
      url: centerLiveUrl(centerBaseUrl, workspaceId, readToken),
    });
    const contentLoader = createIframeContentLoader(createIframeHost(iframe));
    readinessRef.current = {
      contentReady: false,
      liveReady: false,
      startupSettled: false,
    };
    const updateStatus = () => {
      if (!mounted) {
        return;
      }
      updateStatusFromReadiness();
    };
    const app = createShellApp({
      center,
      live,
      contentLoader,
      clipboard: createNavigatorClipboardWriter(),
      onContentSession(session) {
        if (!mounted) {
          return;
        }
        readinessRef.current.contentReady = session.status === "ready";
        if (!readinessRef.current.contentReady) {
          setStatus("Content error");
          return;
        }
        updateStatus();
      },
      onLiveConnectionChange(connected) {
        readinessRef.current.liveReady = connected;
        updateStatus();
      },
      onPickerModeChange(enabled) {
        if (mounted) {
          setPickerEnabled(enabled);
        }
      },
    });
    let mounted = true;
    appRef.current = app;

    void app
      .start()
      .then(() => {
        readinessRef.current.startupSettled = true;
        updateStatus();
      })
      .catch((error: unknown) => {
        if (mounted) {
          setStatus(error instanceof Error ? error.message : "Shell error");
        }
      });

    return () => {
      mounted = false;
      const activeApp = appRef.current;
      appRef.current = undefined;
      void activeApp?.stop();
    };
  }, [iframe]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (!isHostedContentMessage(event, iframeRef.current)) {
        return;
      }
      void appRef.current?.handleContentMessage(event.data);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const togglePicker = () => {
    const nextEnabled = !pickerEnabled;
    setPickerEnabled(nextEnabled);
    appRef.current?.setPickerMode(nextEnabled);
  };

  const refreshContent = () => {
    setStatus("Refreshing");
    void appRef.current?.loadCurrentContent().then((session) => {
      readinessRef.current.contentReady = session.status === "ready";
      if (readinessRef.current.contentReady) {
        updateStatusFromReadiness();
        return;
      }
      setStatus("Content error");
    });
  };

  return (
    <main className="shell">
      <header className="shell-toolbar">
        <div>
          <h1>LaneDeck</h1>
          <p>{status}</p>
        </div>
        <div className="shell-actions">
          <button type="button" onClick={refreshContent}>
            Refresh
          </button>
          <button
            type="button"
            aria-pressed={pickerEnabled}
            onClick={togglePicker}
          >
            Pick
          </button>
        </div>
      </header>
      <iframe
        ref={(element) => {
          iframeRef.current = element;
          setIframe(element);
        }}
        className="shell-content"
        title="LaneDeck content"
      />
    </main>
  );
}

function isHostedContentMessage(
  event: MessageEvent<unknown>,
  iframe: HTMLIFrameElement | null,
): boolean {
  return (
    iframe?.contentWindow === event.source &&
    isAllowedContentOrigin(event.origin, iframe.src)
  );
}

export function isAllowedContentOrigin(
  origin: string,
  contentSource: string,
): boolean {
  return (
    contentMessageOriginPolicyForUri(contentSource)?.acceptedOrigins.includes(
      origin,
    ) ?? false
  );
}
