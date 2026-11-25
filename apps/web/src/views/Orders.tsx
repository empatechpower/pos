import { useMemo, useState } from "react";
import { confirmedPaid, formatMoney, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { useOrders } from "../hooks";
import { RefundPanel } from "./RefundPanel";
import { OrderDetails } from "./OrderDetails";
import { NoteSheet } from "./NoteSheet";
import { record } from "../db";
import { go, queryParams } from "../nav";
import { logView } from "../orderViews";
import { Modal } from "../till/Modal";

const timeOf = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
const DAY = 86_400_000;
const startOfDay = (t = Date.now()) => new Date(t).setHours(0, 0, 0, 0);
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };

type Tab = "open" | "today" | "week" | "month" | "range" | "all";
type Status = "all" | "open" | "paid" | "cancelled" | "refunded" | "voided";
export type OrderStatus = "open" | "paid" | "refunded" | "voided" | "cancelled";

/** Where an order stands: still to be paid, paid, partly or wholly refunded, voided, or cancelled (or merged into another table). */
export function statusOf(o: OrderState, config: BusinessConfig): OrderStatus {
  if (o.voided) return "voided";
  if (o.stage === "cancelled" || o.mergedInto) return "cancelled";
  if (o.refunds?.length) return "refunded";
  return o.lines.length > 0 && confirmedPaid(o) >= orderTotals(o, config).total ? "paid" : "open";
}
const LABEL: Record<OrderStatus, string> = { open: "Open", paid: "Paid", refunded: "Refund", voided: "Void", cancelled: "Cancelled" }; // the names the handout fixes for these statuses (4.1, decision Q27)

/** Which tab an order belongs in by date: open orders are always shown under Open, whatever their age. */
export function inRange(o: OrderState, tab: Tab, now: number, range: { from: number; to: number }): boolean {
  const t = o.openedAt;
  if (tab === "all" || tab === "open") return true;
  if (tab === "today") return t >= startOfDay(now);
  if (tab === "week") return t >= startOfDay(now) - 6 * DAY;
  if (tab === "month") return t >= startOfMonth();
  return t >= range.from && t < range.to + DAY;
}

/** Orders, newest first: search, Open / Today / Week / Month / Range / All, and a filter by how each stands. */
export function Orders({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const orders = useOrders();
  const [tab, setTab] = useState<Tab>(() => { const t = queryParams().get("tab"); return t === "open" || t === "today" || t === "week" || t === "month" || t === "range" || t === "all" ? t : "today"; });
  const [status, setStatus] = useState<Status>("all");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(() => new Date(startOfDay() - 6 * DAY).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState<string | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  /** "Print modifiers" is off every time (TengSern, Q46): a receipt shows the item and its price; the choices print only when asked for. */
  const [mods, setMods] = useState(false);
  const [preview, setPreview] = useState<null | { id: string; text: string }>(null);
  async function showReceipt(id: string, withMods = mods) {
    logView(id, "Orders");
    const r = await staffFetch(`/api/orders/${id}/receipt${withMods ? "?modifiers=1" : ""}`);
    if ("res" in r && r.res.ok) setPreview({ id, text: ((await r.res.json()) as { text: string }).text });
    else setMsg("The server does not have that order yet. Wait for it to sync, then try again.");
  }
  const now = Date.now();
  const range = { from: new Date(`${from}T00:00:00+08:00`).getTime() || 0, to: new Date(`${to}T00:00:00+08:00`).getTime() || now };

  const all = useMemo(() => orders.filter((o) => o.lines.length).sort((a, b) => b.openedAt - a.openedAt), [orders]);
  const stat = useMemo(() => new Map(all.map((o) => [o.orderId, statusOf(o, config)])), [all, config]);
  const matches = (o: OrderState) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [o.queueNumber, o.spot, o.channelName, o.note, o.customerName, ...o.lines.map((l) => l.name)].some((x) => x?.toLowerCase().includes(needle));
  };
  const byTab = (t: Tab) => all.filter((o) => matches(o) && (t === "open" ? stat.get(o.orderId) === "open" : inRange(o, t, now, range)));
  const counts: Record<Tab, number> = { open: byTab("open").length, today: byTab("today").length, week: byTab("week").length, month: byTab("month").length, range: byTab("range").length, all: byTab("all").length };
  // Open orders stay pinned above the history in a range view, until a status is chosen (decision Q27).
  const picked = byTab(tab).filter((o) => status === "all" || stat.get(o.orderId) === status);
  const list = status === "all" && tab !== "open" ? [...picked.filter((o) => stat.get(o.orderId) === "open"), ...picked.filter((o) => stat.get(o.orderId) !== "open")] : picked;

  async function reprint(orderId: string, docType: "receipt" | "kitchen") {
    setMsg(null);
    logView(orderId, "Orders");
    const r = await staffFetch("/api/print/reprint", { body: { orderId, docType, ...(docType === "receipt" && mods ? { modifiers: true } : {}) } });
    if ("problem" in r) return setMsg(r.problem);
    if (r.res.ok) return setMsg(docType === "receipt" ? "Receipt sent to the printer." : "Kitchen ticket sent again.");
    const code = ((await r.res.json().catch(() => ({}))) as { error?: string }).error;
    setMsg(code === "order_not_found" ? "The server doesn't have that order yet. Wait for it to sync, then try again." : code === "no_printer_for_this" ? "No printer is set up for that. Ask a manager." : "Could not reprint.");
  }
  /** An open order goes back on the till; the opening is written into its history. */
  function openOnTill(o: OrderState) {
    logView(o.orderId, "Orders: reopened on the till");
    localStorage.setItem("pos.openOrder", o.orderId);
    go("/pos");
  }

  const TABS: Array<[Tab, string]> = [["open", "Open"], ["today", "Today"], ["week", "This Week"], ["month", "This Month"], ["range", "Date Range"], ["all", "All"]];
  return (
    <div className="credit prices orders-screen">
      <h2>Orders</h2>
      {!staff && <div className="flash">Sign in to reprint. <a href="/login">Sign in</a></div>}
      {msg && <div className="flash">{msg}</div>}
      <div className="row" style={{ alignItems: "center" }}>
        <button className={mods ? "primary sm" : "secondary sm"} aria-pressed={mods} onClick={() => setMods((m) => !m)} title="Whether a receipt lists each item's choices (extras, size, spice). Off unless you turn it on.">Print modifiers: {mods ? "On" : "Off"}</button>
        <span className="muted">Applies to the receipt you print or preview below.</span>
      </div>
      <input className="orders-search" aria-label="Search orders" placeholder="Search by number, table, item, customer or note" value={q} onChange={(e) => { setQ(e.target.value); setLimit(40); }} />
      <div className="orders-tabs" role="tablist">
        {TABS.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setLimit(40); }}>{l} <b>{counts[t]}</b></button>)}
      </div>
      {tab === "range" && <div className="row"><label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label><label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label></div>}
      <div className="orders-chips" aria-label="Filter by status">
        {(["all", "paid", "cancelled", "refunded", "voided"] as Status[]).map((s) => <button key={s} className={status === s ? "on" : ""} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === "all" ? "All statuses" : LABEL[s]}</button>)}
      </div>
      {list.length === 0 && <p className="muted">No orders here.</p>}
      {noting && (() => {
        const o = all.find((x) => x.orderId === noting);
        if (!o) return null;
        return <NoteSheet title={`Note · order ${o.queueNumber ?? ""}`} initial={o.note ?? ""} max={200} onClose={() => setNoting(null)} onSave={(t) => { void record(o.orderId, { type: "OrderNoted", note: t, ...(staff ? { byName: staff.name } : {}) }).then(() => setMsg(t ? "Note saved. If the order was already sent, the kitchen gets a short slip." : "Note removed.")); setNoting(null); }} />;
      })()}
      {list.slice(0, limit).map((o) => {
        const t = orderTotals(o, config);
        const st = stat.get(o.orderId)!;
        return (
          <div key={o.orderId}>
            <div className="tab">
              <div>
                <b>{o.queueNumber ?? o.spot ?? "—"}</b> <span className={`ord-badge ${st}`}>{LABEL[st]}</span>{" "}
                <span className="muted">· {o.spot ? `${o.spot} · ` : ""}{o.channelName ?? o.fulfilment} · {timeOf(o.openedAt)} · {formatMoney(t.total)}{st === "open" && confirmedPaid(o) > 0 ? ` (${formatMoney(t.total - confirmedPaid(o))} left)` : ""}</span>
              </div>
              <div className="tabr">
                {st === "open" && <button className="primary sm" onClick={() => openOnTill(o)}>Open on till</button>}
                <button className="secondary sm" onClick={() => { const next = shown === o.orderId ? null : o.orderId; setShown(next); if (next) logView(o.orderId, "Orders"); }}>{shown === o.orderId ? "Hide" : "Details"}</button>
                <button className="secondary sm" disabled={!staff} onClick={() => void showReceipt(o.orderId)}>Preview</button>
                <button className="secondary sm" disabled={!staff} onClick={() => void reprint(o.orderId, "receipt")}>Receipt</button>
                <button className="secondary sm" disabled={!staff} onClick={() => void reprint(o.orderId, "kitchen")}>Kitchen ticket</button>
                <button className="secondary sm" onClick={() => { logView(o.orderId, "Orders"); setNoting(o.orderId); }}>{o.note ? "Edit note" : "Note"}</button>
              </div>
            </div>
            {o.note && <div className="muted" style={{ padding: "0 12px" }}><b>Note:</b> {o.note}</div>}
            {shown === o.orderId && <OrderDetails order={o} config={config} />}
            {staff && st !== "cancelled" && <RefundPanel order={o} />}
          </div>
        );
      })}
      {preview && (
        <Modal title="Receipt" onClose={() => setPreview(null)}>
          <pre className="t-receipt">{preview.text}</pre>
          <div className="t-dact">
            <button className="t-ghost" onClick={() => { setMods((m) => !m); void showReceipt(preview.id, !mods); }}>Print modifiers: {mods ? "On" : "Off"}</button>
            <button className="t-ghost" onClick={() => void reprint(preview.id, "receipt").then(() => setPreview(null))}>Print</button>
            <button className="t-primary" onClick={() => setPreview(null)}>Close</button>
          </div>
        </Modal>
      )}
      {list.length > limit && <button className="secondary" onClick={() => setLimit((n) => n + 40)}>Show more ({list.length - limit} more)</button>}
    </div>
  );
}
