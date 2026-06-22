import {
  createContentApp,
  createHttpCenterQueryClient,
  createWindowShellBridge,
} from "./index";
import "./styles.css";

const app = createContentApp({
  query: createHttpCenterQueryClient(),
  shell: createWindowShellBridge(),
});

void app.init();
