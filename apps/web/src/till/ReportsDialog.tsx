import { useMemo, useState } from "react";
import { confirmedPaid, formatMoney, orderTotals, productMix, reportDay, staffSales, summarize, type BusinessConfig, type OrderState } from "@pos/core";
import { staffFetch } from "../auth";
import { go } from "../nav";
import { ProtoDialog } from "../proto/ProtoDialog";
import { statusOf } from "../views/Orders";

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow", mock: "Practice" };
const LABEL: Record<string, string> = { open: "Open", paid: "Paid", refunded: "Refunded", voided: "Voided", cancelled: "Cancelled" };
const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/**
 * Reports on the till, as in the prototype (proto-reference/index.html: reports, dayReport, historyList, txnDetail): the shift's X and Z, today's
 * sales across every shift, and the transaction history with each order's receipt. The figures come from the orders this till already holds,
 * through the same sums the back-office reports use.
 */
export function ReportsDialog({ orders, config, categoryOf, manager, onShift, onClose }: { orders: OrderState[]; config: BusinessConfig; categoryOf: (productId: string) => string; manager: boolean; onShift: () => void; onClose: () => void }) {
  const [view, setView] = useState<"menu" | "today" | "history" | "receipt">("menu");
  const [receipt, setReceipt] = useState<null | { order: OrderState; text: string }>(null);
  const [msg, setMsg] = useState("");
  const real = useMemo(() => orders.filter((o) => o.lines.length > 0 && !o.mergedInto), [orders]);
  const today = useMemo(() => { const d = reportDay(Date.now()); return real.filter((o) => reportDay(o.paidAt ?? o.openedAt) === d); }, [real]);
  const history = useMemo(() => [...real].sort((a, b) => (b.paidAt ?? b.openedAt) - (a.paidAt ?? a.openedAt)).slice(0, 50), [real]);
  const wrap = (title: string, body: React.ReactNode) => <div className="proto protohead"><ProtoDialog title={title} onClose={onClose}>{body}</ProtoDialog></div>;
  const back = <div className="actions"><button onClick={() => { setView("menu"); setMsg(""); }}>Back</button></div>;

  async function open(o: OrderState) {
    setMsg("");
    const r = await staffFetch(`/api/orders/${o.orderId}/receipt`);
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("That receipt could not be opened. It may not have reached the server yet.");
    setReceipt({ order: o, text: ((await r.res.json()) as { text: string }).text });
    setView("receipt");
  }

  if (view === "today") {
    const s = summarize(today, config);
    const mix = productMix(today.filter((o) => !o.voided && o.stage !== "cancelled"), categoryOf);
    const people = staffSales(today, config).filter((p) => p.takenCents > 0);
    return wrap("Today's sales · All shifts", (
      <>
        <table className="rep"><tbody>
          <tr><td>Paid orders</td><td>{s.orders - s.unpaidOrders}</td></tr>
          <tr><td>Gross sales</td><td>{formatMoney(s.grossCents)}</td></tr>
          {s.payments.map((p) => <tr key={p.method}><td>{METHOD[p.method] ?? p.method}</td><td>{formatMoney(p.cents)}</td></tr>)}
          <tr><td>Service charge</td><td>{formatMoney(s.serviceCents)}</td></tr>
          {s.gstCents > 0 && <tr><td>GST</td><td>{formatMoney(s.gstCents)}</td></tr>}
          <tr><td>Discounts given</td><td>{formatMoney(s.discountsCents)}</td></tr>
          <tr><td>Deposits (BCRS)</td><td>{formatMoney(s.liabilitiesCents)}</td></tr>
          {s.unpaidOrders > 0 && <tr><td>Orders not paid yet</td><td>{s.unpaidOrders}</td></tr>}
          {s.voided.orders > 0 && <tr><td>Voided or cancelled</td><td>{s.voided.orders} · {formatMoney(s.voided.cents)}</td></tr>}
        </tbody></table>
        <h3>Items sold</h3>
        <table className="rep"><tbody>{mix.length ? mix.map((m) => <tr key={m.name}><td>{m.name}</td><td>{m.qty} · {formatMoney(m.cents)}</td></tr>) : <tr><td>No items yet</td><td /></tr>}</tbody></table>
        <h3>By staff</h3>
        <table className="rep"><tbody>{people.length ? people.map((p) => <tr key={p.name}><td>{p.name}</td><td>{formatMoney(p.takenCents)}</td></tr>) : <tr><td>No sales yet</td><td /></tr>}</tbody></table>
        {back}
      </>
    ));
  }
  if (view === "history") {
    return wrap("Transaction history", (
      <>
        {msg && <p className="error" role="alert">{msg}</p>}
        {history.length === 0 && <p className="muted">No transactions yet.</p>}
        {history.map((o) => {
          const st = statusOf(o, config), t = orderTotals(o, config);
          const tenders = [...new Set(o.payments.filter((p) => p.confirmed).map((p) => METHOD[p.method] ?? p.method))].join(", ");
          return (
            <button key={o.orderId} className="heldrow" onClick={() => void open(o)}>
              <div className="row"><strong>{st === "cancelled" ? "Cancelled order" : `Order ${o.queueNumber ?? o.spot ?? "—"}`}</strong><span>{formatMoney(t.total)}</span></div>
              <small>{when(o.paidAt ?? o.openedAt)} · {LABEL[st] ?? st}{tenders ? ` · ${tenders}` : ""} · {o.channelName ?? o.fulfilment}{o.spot ? ` · ${o.spot}` : ""}{confirmedPaid(o) > 0 && confirmedPaid(o) < t.total ? ` · ${formatMoney(t.total - confirmedPaid(o))} left` : ""}</small>
            </button>
          );
        })}
        {back}
      </>
    ));
  }
  if (view === "receipt" && receipt) {
    return wrap("Order detail", (
      <>
        <p className="muted">{LABEL[statusOf(receipt.order, config)]} · {when(receipt.order.paidAt ?? receipt.order.openedAt)}</p>
        <pre className="receipt r7" style={{ whiteSpace: "pre-wrap", margin: "0.6em auto" }}>{receipt.text}</pre>
        <div className="actions"><button onClick={() => { onClose(); go("/orders"); }}>Open in Orders</button><button onClick={() => setView("history")}>Back</button></div>
      </>
    ));
  }
  return wrap("Reports", (
    <>
      <div className="settingsgroup">
        <button onClick={onShift}>X report · My shift</button>
        <button onClick={onShift}>Close shift · Z report</button>
        <button onClick={() => setView("today")}>Today's sales · All shifts</button>
        <button onClick={() => setView("history")}>Transaction history</button>
        {manager && <button onClick={() => { onClose(); go("/manager?tab=reports"); }}>Full reports · Back office</button>}
      </div>
      <div className="actions"><button onClick={onClose}>Close</button></div>
    </>
  ));
}
