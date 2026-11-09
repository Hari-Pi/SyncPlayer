import { Component, type ErrorInfo, type ReactNode } from "react";
import { formatActivity, getAllActivity } from "@/features/activity-log/activityLog";

type State = { error: Error | null; copied: boolean };

/** Last line of defence: a render error shows the problem and the activity log instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SyncPlayer crashed while rendering:", error, info.componentStack);
  }

  private details() {
    const { error } = this.state;
    return `${error?.name}: ${error?.message}\n${error?.stack ?? ""}\n\n--- Activity log ---\n${formatActivity(getAllActivity())}`;
  }

  private copy = () => {
    void navigator.clipboard?.writeText(this.details()).then(() => this.setState({ copied: true }));
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ color: "#defbff", fontFamily: "ui-monospace, monospace", margin: "10vh auto", maxWidth: "40rem", padding: "1.5rem" }}>
        <h1 style={{ color: "#ff5c7a", fontSize: "1.1rem" }}>SyncPlayer hit an unexpected error</h1>
        <p style={{ color: "#729aa3" }}>{this.state.error.message}</p>
        <p style={{ color: "#729aa3" }}>Copy the details below into a bug report, then reload to start over.</p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" onClick={this.copy}>{this.state.copied ? "Copied" : "Copy details"}</button>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
