import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch } from "../auth";

interface Row { bankRef: string; amountCents: number; payerName: string; emailDate: number; note: string | null }
interface Cand { orderId: string; queueNumber: string | null; channel: string; table: string | null; customerName: string | null; openedAt: string; items: number }

const when = (t: number) => new Date(t).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Money that reached the shop's bank by PayNow with no live QR to match (paid after the QR timed out, from a screenshot, or the order
 * could not take it). Nothing here is applied by guesswork: staff put it on an order that is owed exactly that amount, or settle it another way.
 */
export function UnassignedPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await staffFetch("/api/payments/paynow/unassigned");
    if ("res" in r && r.res.ok) setRows(((await r.res.json()) as { payments: Row[] }).payments);
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, [load]);

  async function choose(row: Row) {
    setMsg(""); setCands(null); setOpen(row.bankRef);
    const r = await staffFetch(`/api/payments/paynow/candidates?amount=${row.amountCents}`);
    setCands("res" in r && r.res.ok ? ((await r.res.json()) as { orders: Cand[] }).orders : []);
  }
  async function assign(row: Row, orderId: string) {
    const r = await staffFetch(`/api/payments/paynow/unassigned/${encodeURIComponent(row.bankRef)}/assign`, { method: "POST", body: { orderId } });
    if ("res" in r && r.res.ok) { setMsg(`${formatMoney(row.amountCents)} put on the order.`); setOpen(null); void load(); }
    else setMsg("That order can no longer take this payment. It may already be paid or cancelled.");
  }
  async function dismiss(row: Row) {
    const note = window.prompt("What happened to this payment? (for example: refunded to the customer)", "refunded");
    if (note === null) return;
    const r = await staffFetch(`/api/payments/paynow/unassigned/${encodeURIComponent(row.bankRef)}/dismiss`, { method: "POST", body: { note } });
    if ("res" in r && r.res.ok) { setMsg("Marked as settled."); void load(); }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Unassigned PayNow payments{rows.length ? ` (${rows.length})` : ""}</h3>
      <p className="muted">Money that arrived with no matching QR. Put it on the order it was for, or mark it settled once you have refunded it.</p>
      {msg && <div className="flash">{msg}</div>}
      {rows.length === 0 && <p className="muted">Nothing waiting.</p>}
      {rows.map((p) => (
        <div key={p.bankRef} style={{ borderBottom: "1px solid var(--line, #ddd)", padding: "8px 0" }}>
          <div className="row" style={{ alignItems: "center" }}>
            <span style={{ flex: 1 }}><b>{formatMoney(p.amountCents)}</b> · {p.payerName || "unknown payer"}<small className="muted" style={{ display: "block" }}>{when(p.emailDate)} · bank ref {p.bankRef}{p.note ? ` · ${p.note}` : ""}</small></span>
            <button className="secondary sm" onClick={() => void (open === p.bankRef ? setOpen(null) : choose(p))}>Put on an order</button>
            <button className="secondary sm" onClick={() => void dismiss(p)}>Settled</button>
          </div>
          {open === p.bankRef && (
            <div style={{ marginTop: 6 }}>
              {cands === null && <p className="muted">Looking…</p>}
              {cands?.length === 0 && <p className="muted">No open order from the last two days is owed exactly {formatMoney(p.amountCents)}.</p>}
              {cands?.map((c) => (
                <div className="row" key={c.orderId} style={{ alignItems: "center" }}>
                  <span style={{ flex: 1 }}>#{c.queueNumber ?? "?"} · {c.channel}{c.table ? ` · ${c.table}` : ""}{c.customerName ? ` · ${c.customerName}` : ""} · {c.items} item{c.items === 1 ? "" : "s"}<small className="muted"> · {when(Date.parse(c.openedAt))}</small></span>
                  <button className="primary sm" onClick={() => void assign(p, c.orderId)}>Use this order</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
