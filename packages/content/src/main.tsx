import { createRoot } from "react-dom/client";
import { protocolPackage } from "@lanedeck/protocol";

function App() {
  return (
    <main data-pick-id="content.home" data-protocol={protocolPackage}>
      LaneDeck Content
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
