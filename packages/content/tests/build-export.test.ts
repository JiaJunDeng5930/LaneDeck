import { describe, expect, it } from "vitest";

import {
  createContentApp,
  createHttpCenterQueryClient,
  createWindowShellBridge,
  dashboardQueryRequest,
  renderDashboardMarkup,
} from "../src/index";

describe("content package exports", () => {
  it("exports the app, query client, shell bridge, and renderer surfaces", () => {
    expect(typeof createContentApp).toBe("function");
    expect(typeof createHttpCenterQueryClient).toBe("function");
    expect(typeof createWindowShellBridge).toBe("function");
    expect(typeof dashboardQueryRequest).toBe("function");
    expect(typeof renderDashboardMarkup).toBe("function");
  });
});
