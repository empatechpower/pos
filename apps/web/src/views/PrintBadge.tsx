import { useEffect, useState } from "react";
import { staffFetch } from "../auth";

export type PrintState = { state: "printed" | "waiting" | "failed" | "unconfirmed"; error?: string };

/** Where each order's tickets stand, refreshed every few seconds. Quietly empty when not signed in or no printer is set up. */
export function usePrintStatus(orderIds: string[], signedIn: boolean): Record<string, PrintState> {
  const [map, setMap] = useState<Record<string, PrintState>>({});
  const key = orderIds.slice(0, 100).join(",");
  useEffect(() => {
    if (!signedIn || !key) return;
    let alive = true;
    const load = async () => {
      const r = await staffFetch(`/api/print/order-status?ids=${encodeURIComponent(key)}`);
      if (alive && "res" in r && r.res.ok) setMap(((await r.res.json()) as { statuses: Record<string, PrintState> }).statuses);
    };
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [key, signedIn]);
  return map;
}

const LABEL: Record<PrintState["state"], string> = {
  printed: "Printed",
  waiting: "Waiting to print",
  failed: "Not printed",
  unconfirmed: "Check the printer",
};
const COLOR: Record<PrintState["state"], string> = { printed: "#1b7f3b", waiting: "#8a6d00", failed: "#c0392b", unconfirmed: "#c0392b" };

/** A small badge: Printed, Waiting to print, Not printed (with a Reprint button) or Check the printer. */
export function PrintBadge({ s, onReprint }: { s: PrintState | undefined; onReprint?: () => void }) {
  if (!s) return null;
  const bad = s.state === "failed" || s.state === "unconfirmed";
  const why =
    s.state === "failed" ? "The printer could not be reached. It will keep trying, or press Reprint." : s.state === "unconfirmed" ? "It may already have printed. Look at the printer before reprinting." : s.state === "waiting" ? "The ticket is queued and prints as soon as Rezein and the printer are reachable." : "";
  return (
    <span title={why || undefined} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, fontWeight: 600, color: COLOR[s.state] }}>
      <span aria-hidden>{s.state === "printed" ? "✓" : s.state === "waiting" ? "…" : "!"}</span>
      {LABEL[s.state]}
      {bad && onReprint && <button className="secondary sm" onClick={onReprint}>Reprint</button>}
    </span>
  );
}
