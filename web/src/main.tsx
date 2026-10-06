import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, loadTheme } from "./state/theme";
import "./styles.css";

applyTheme(loadTheme());

// A file dropped anywhere that doesn't handle drops (everywhere but the replay
// screen) would otherwise make the browser open it — in Electron that navigates
// the whole window to file:// with no way back. These run after React's own
// handlers (which are attached to #root, below document), so a drop zone that
// already called preventDefault keeps working; everything else becomes a no-op.
// File drags only, so dragging text into an input still behaves natively.
const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
document.addEventListener("dragover", (e) => {
  if (e.defaultPrevented || !isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
});
document.addEventListener("drop", (e) => {
  if (!e.defaultPrevented && isFileDrag(e)) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
