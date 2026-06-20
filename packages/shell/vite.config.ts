import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@lanedeck/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
