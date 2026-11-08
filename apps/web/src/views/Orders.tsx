import { useState } from "react";
import { formatMoney, orderTotals, type BusinessConfig } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { useOrders } from "../hooks";

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/** Recent orders, newest first, so a customer who lost their receipt gets another. */
export function Orders({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const orders = useOrders();
  const [msg, setMsg] = useState<string | null>(null);
  const recent = orders.filter((o) => o.lines.length).sort((a, b) => b.openedAt - a.openedAt).slice(0, 25);

  async function reprint(orderId: string, docType: "receipt" | "kitchen") {
    setMsg(null);
    const r = await staffFetch("/api/print/reprint", { body: { orderId, docType } });
    if ("problem" in r) return setMsg(r.problem);
    if (r.res.ok) return setMsg(docType === "receipt" ? "Receipt sent to the printer." : "Kitchen ticket sent again.");
    const code = ((await r.res.json().catch(() => ({}))) as { error?: string }).error;
    setMsg(
      code === "order_not_found" ? "The server doesn't have that order yet. Wait for it to sync, then try again." : code === "no_printer_for_this" ? "No printer is set up for that. Ask a manager." : "Could not reprint.",
    );
  }

  return (
    <div className="credit prices">
      <h2>Recent orders</h2>
      {!staff && <div className="flash">Sign in to reprint. <a href="#/login">Sign in</a></div>}
      {msg && <div className="flash">{msg}</div>}
      {recent.length === 0 && <p className="muted">No orders yet.</p>}
      {recent.map((o) => {
        const t = orderTotals(o, config);
        return (
          <div className="tab" key={o.orderId}>
            <div>
              <b>{o.queueNumber ?? "—"}</b> <span className="muted">· {o.channelName ?? o.fulfilment} · {timeOf(o.openedAt)} · {formatMoney(t.total)}</span>
            </div>
            <div className="tabr">
              <button className="secondary sm" disabled={!staff} onClick={() => void reprint(o.orderId, "receipt")}>Receipt</button>
              <button className="secondary sm" disabled={!staff} onClick={() => void reprint(o.orderId, "kitchen")}>Kitchen ticket</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
