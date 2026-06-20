import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@lanedeck/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
  },
});
