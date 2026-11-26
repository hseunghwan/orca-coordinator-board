/** @jsxImportSource react */
// The dashboard: a full-width editor tab Orca opens on .coordinator-board files. The file is only a
// key; everything shown comes from the worker.
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { STYLE } from "./ui/style";

const style = document.createElement("style");
style.textContent = STYLE;
document.head.append(style);
const root = document.createElement("div");
root.id = "board-root";
document.body.append(root);

// Orca waits for an editor to ask for its file before it counts the editor as open.
void orca.document?.get().catch(() => undefined);
createRoot(root).render(<App />);
