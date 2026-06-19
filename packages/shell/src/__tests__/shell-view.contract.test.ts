import { describe, expect, it } from "vitest";

import { isAllowedContentOrigin } from "../ui/ShellView";

describe("ShellView content message origin filtering", () => {
  it.each(["ready", "height_changed", "pick_result"] as const)(
    "accepts %s from the iframe source origin",
    () => {
      expect(
        isAllowedContentOrigin(
          "http://localhost:4173",
          "http://localhost:4173/app.html",
        ),
      ).toBe(true);
    },
  );

  it.each(["ready", "height_changed", "pick_result"] as const)(
    "rejects %s from a different origin for the same iframe source",
    () => {
      expect(
        isAllowedContentOrigin(
          "http://evil.example",
          "http://localhost:4173/app.html",
        ),
      ).toBe(false);
    },
  );
});
