import { describe, expect, it } from "vitest";

import {
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
