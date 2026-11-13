import { Component, type ReactNode } from "react";

/**
 * If a page fails while drawing, show a message and a way back instead of a blank screen. The saved bag and the pending
 * checkout key are cleared first, since a bad saved value is the usual cause and clearing them only costs the customer a bag.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[app] a page failed to draw:", error);
    try {
      localStorage.removeItem("pos.shopBag");
      localStorage.removeItem("pos.purchase");
    } catch {
      /* storage not available */
    }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 420, margin: "0 auto", padding: "60px 20px", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <h2>Something went wrong</h2>
        <p style={{ color: "#6f6455" }}>Sorry. Please reload the page. If it happens again, tell the shop and mention the line below.</p>
        <button style={{ padding: "12px 22px", borderRadius: 999, border: 0, background: "#ea7016", color: "#fff", fontWeight: 700, fontSize: 16 }} onClick={() => location.reload()}>Reload</button>
        <p style={{ color: "#999", fontSize: 12, marginTop: 24, wordBreak: "break-word" }}>{String(this.state.error.message || this.state.error).slice(0, 200)}</p>
      </div>
    );
  }
}
