import { Component, type ErrorInfo, type ReactNode } from "react";
import { applyUpdate } from "../pwa";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** App-wide safety net. A throw anywhere in the render tree (e.g. a malformed
 *  field in a generated JSON surfacing inside a render-phase useMemo) would
 *  otherwise unmount everything to a blank white screen — which also hides the
 *  service-worker update toast that could ship the fix. Catch it and offer a
 *  reload instead of a dead page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No remote logger in this app; leave a console trail for field diagnostics.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          textAlign: "center",
          color: "var(--text, #e7e7e7)",
          background: "var(--bg, #14161a)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>Something went wrong</h1>
        <p style={{ margin: 0, maxWidth: 480, color: "var(--text-soft, #9aa0a6)" }}>
          The app hit an unexpected error and couldn&rsquo;t continue. Reloading usually
          fixes it — if an update is available it will be applied.
        </p>
        <pre
          style={{
            maxWidth: 480,
            overflow: "auto",
            fontSize: 12,
            color: "var(--text-soft, #9aa0a6)",
            whiteSpace: "pre-wrap",
          }}
        >
          {error.message}
        </pre>
        {/* applyUpdate activates a waiting service worker before reloading (a
            plain reload would not under registerType "prompt"); with no update
            waiting — or in Electron — it is just a reload. */}
        <button className="btn primary" onClick={applyUpdate}>
          Reload
        </button>
      </div>
    );
  }
}
