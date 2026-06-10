import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@lanedeck/protocol": new URL("../protocol/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});
