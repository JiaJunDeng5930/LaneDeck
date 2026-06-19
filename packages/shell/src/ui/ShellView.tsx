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

export function ShellView() {
  const appRef = useRef<ShellApp | undefined>(undefined);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState("Starting");
  const [pickerEnabled, setPickerEnabled] = useState(false);

  useEffect(() => {
    if (iframe === null) {
      return undefined;
    }

    const center = createHttpCenterClient({
      baseUrl: centerBaseUrl,
      workspaceId,
      readToken,
      reportProtocolDiagnostic: createBrowserDiagnosticReporter(),
    });
    const live = createWebSocketLiveClient({
      url: centerLiveUrl(centerBaseUrl, workspaceId, readToken),
    });
    const contentLoader = createIframeContentLoader(createIframeHost(iframe));
    let startupSettled = false;
    let contentReady = false;
    const app = createShellApp({
      center,
      live,
      contentLoader,
      clipboard: createNavigatorClipboardWriter(),
      onContentSession(session) {
        if (!mounted) {
          return;
        }
        contentReady = session.status === "ready";
        if (contentReady && startupSettled) {
          setStatus("Ready");
          return;
        }
        if (!contentReady) {
          setStatus("Content error");
        }
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
        startupSettled = true;
        if (mounted) {
          setStatus(contentReady ? "Ready" : "Content error");
        }
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
      setStatus(session.status === "ready" ? "Ready" : "Content error");
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
