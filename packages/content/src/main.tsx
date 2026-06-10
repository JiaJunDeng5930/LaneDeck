import {
  createContentApp,
  createHttpCenterQueryClient,
  createWindowShellBridge,
} from "./index";

const app = createContentApp({
  query: createHttpCenterQueryClient({ endpoint: globalThis.location.origin }),
  shell: createWindowShellBridge(),
});

void app.init();
