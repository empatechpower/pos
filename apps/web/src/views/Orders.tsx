import { useState } from "react";
import { formatMoney, orderTotals, type BusinessConfig } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { useOrders } from "../hooks";
import { RefundPanel } from "./RefundPanel";
import { NoteSheet } from "./NoteSheet";
import { record } from "../db";
import { logView } from "../orderViews";

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/** Recent orders, newest first, so a customer who lost their receipt gets another. */
export function Orders({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const orders = useOrders();
  const [msg, setMsg] = useState<string | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const recent = orders.filter((o) => o.lines.length).sort((a, b) => b.openedAt - a.openedAt).slice(0, 25);

  async function reprint(orderId: string, docType: "receipt" | "kitchen") {
    setMsg(null);
    logView(orderId, "Recent orders");
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
      {!staff && <div className="flash">Sign in to reprint. <a href="/login">Sign in</a></div>}
      {msg && <div className="flash">{msg}</div>}
      {recent.length === 0 && <p className="muted">No orders yet.</p>}
      {noting && (() => {
        const o = recent.find((x) => x.orderId === noting);
        if (!o) return null;
        return <NoteSheet title={`Note · order ${o.queueNumber ?? ""}`} initial={o.note ?? ""} max={200} onClose={() => setNoting(null)} onSave={(t) => { void record(o.orderId, { type: "OrderNoted", note: t, ...(staff ? { byName: staff.name } : {}) }).then(() => setMsg(t ? "Note saved. If the order was already sent, the kitchen gets a short slip." : "Note removed.")); setNoting(null); }} />;
      })()}
      {recent.map((o) => {
        const t = orderTotals(o, config);
        return (
          <div key={o.orderId}>
          <div className="tab">
            <div>
              <b>{o.queueNumber ?? "—"}</b>{o.voided ? <b style={{ color: "#b00020" }}> VOID</b> : null} <span className="muted">· {o.channelName ?? o.fulfilment} · {timeOf(o.openedAt)} · {formatMoney(t.total)}</span>
            </div>
            <div className="tabr">
              <button className="secondary sm" disabled={!staff} onClick={() => void reprint(o.orderId, "receipt")}>Receipt</button>
              <button className="secondary sm" disabled={!staff} onClick={() => void reprint(o.orderId, "kitchen")}>Kitchen ticket</button>
              <button className="secondary sm" onClick={() => { logView(o.orderId, "Recent orders"); setNoting(o.orderId); }}>{o.note ? "Edit note" : "Note"}</button>
            </div>
          </div>
          {o.note && <div className="muted" style={{ padding: "0 12px" }}><b>Note:</b> {o.note}</div>}
          {staff && <RefundPanel order={o} />}
          </div>
        );
      })}
    </div>
  );
}
