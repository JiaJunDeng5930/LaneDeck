import { createRoot } from "react-dom/client";
import { protocolPackage } from "@lanedeck/protocol";

function App() {
  return <main data-protocol={protocolPackage}>LaneDeck Shell</main>;
}

createRoot(document.getElementById("root")!).render(<App />);
