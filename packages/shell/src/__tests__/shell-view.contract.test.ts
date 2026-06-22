import { describe, expect, it } from "vitest";

import {
  defaultCenterBaseUrl,
  defaultContentBaseUrl,
  isAllowedContentOrigin,
  shellVisibleStatusForReadiness,
} from "../ui/ShellView";

describe("ShellView content message origin filtering", () => {
  it.each([
    "lanedeck://content",
    "http://lanedeck.localhost",
    "https://lanedeck.localhost",
    "lanedeck://localhost",
    "null",
  ])("accepts %s for lanedeck iframe sources", (origin) => {
    expect(
      isAllowedContentOrigin(
        origin,
        "lanedeck://content/workspace.local/rev-1/index.html",
      ),
    ).toBe(true);
  });

  it("accepts the URL origin for explicit http iframe sources", () => {
    expect(
      isAllowedContentOrigin(
        "http://localhost:4173",
        "http://localhost:4173/app.html",
      ),
    ).toBe(true);
  });

  it.each([
    "http://evil.example",
    "https://lanedeck.localhost",
    "http://lanedeck.localhost",
    "null",
  ])("rejects %s for the same explicit http iframe source", (origin) => {
    expect(
      isAllowedContentOrigin(origin, "http://localhost:4173/app.html"),
    ).toBe(false);
  });
});

describe("ShellView visible readiness", () => {
  it("shows Ready only after startup, content, and live connection are ready", () => {
    expect(
      shellVisibleStatusForReadiness({
        startupSettled: true,
        contentReady: true,
        liveReady: false,
      }),
    ).toBe("Waiting for live");
    expect(
      shellVisibleStatusForReadiness({
        startupSettled: false,
        contentReady: true,
        liveReady: true,
      }),
    ).toBeUndefined();
    expect(
      shellVisibleStatusForReadiness({
        startupSettled: true,
        contentReady: true,
        liveReady: true,
      }),
    ).toBe("Ready");
  });

  it("shows Content error after startup settles without ready content", () => {
    expect(
      shellVisibleStatusForReadiness({
        startupSettled: true,
        contentReady: false,
        liveReady: true,
      }),
    ).toBe("Content error");
  });
});

describe("ShellView center URL defaults", () => {
  it("uses the Worker origin for hosted shells", () => {
    expect(
      defaultCenterBaseUrl(
        "https://lanedeck-center.atticusdeng.workers.dev",
        false,
      ),
    ).toBe("https://lanedeck-center.atticusdeng.workers.dev");
  });

  it("uses the local center for Vite dev and desktop shell origins", () => {
    expect(
      defaultCenterBaseUrl(
        "https://lanedeck-center.atticusdeng.workers.dev",
        true,
      ),
    ).toBe("http://localhost:8787");
    expect(defaultCenterBaseUrl("tauri://localhost", false)).toBe(
      "http://localhost:8787",
    );
    expect(defaultCenterBaseUrl("http://tauri.localhost", false)).toBe(
      "http://localhost:8787",
    );
  });
});

describe("ShellView content URL defaults", () => {
  it("uses same-origin content assets for hosted shells", () => {
    expect(
      defaultContentBaseUrl(
        "https://lanedeck-center.atticusdeng.workers.dev",
        false,
      ),
    ).toBe("https://lanedeck-center.atticusdeng.workers.dev/content-by-workspace/");
  });

  it("keeps custom protocol content for Vite dev and desktop shell origins", () => {
    expect(
      defaultContentBaseUrl(
        "https://lanedeck-center.atticusdeng.workers.dev",
        true,
      ),
    ).toBe("");
    expect(defaultContentBaseUrl("tauri://localhost", false)).toBe("");
    expect(defaultContentBaseUrl("http://tauri.localhost", false)).toBe("");
  });
});
