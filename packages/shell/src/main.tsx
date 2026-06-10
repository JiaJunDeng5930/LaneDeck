import { createRoot } from "react-dom/client";

import { ShellView } from "./ui/ShellView";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<ShellView />);
