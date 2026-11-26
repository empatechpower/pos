import { useMemo, useState } from "react";
import { confirmedPaid, formatMoney, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { useOrders } from "../hooks";
import { OrderDetails } from "./OrderDetails";
import { NoteSheet } from "./NoteSheet";
import { record } from "../db";
import { go, queryParams } from "../nav";
import { logView } from "../orderViews";
import { ProtoModal } from "../proto/ProtoDialog";

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
  const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
  const whereOf = (o: OrderState) => o.spot ?? o.channelName ?? (o.fulfilment === "takeaway" ? "Take away" : o.fulfilment === "delivery" ? "Delivery" : "Dine in");
  const detail = shown ? all.find((x) => x.orderId === shown) : undefined;
  const openDetail = (o: OrderState) => { setShown(o.orderId); setMsg(null); logView(o.orderId, "Orders"); };
  // The markup and class names are the prototype's own (proto-reference/index.html: renderOrders, ordRowOpen, ordRowPaid), styled by its stylesheet.
  return (
    <div className="proto protohead ordscreen">
      <main className="viewmain">
        <div className="ordwrap">
          {!staff && <div className="floormsg">Sign in to reprint. <a href="/login">Sign in</a></div>}
          <div className="ordtools">
            <input aria-label="Search orders" placeholder="Search order no., table or tab" value={q} onChange={(e) => { setQ(e.target.value); setLimit(40); }} />
            <div className="ordtabs" role="tablist">
              {TABS.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "selected" : ""} onClick={() => { setTab(t); setLimit(40); }}>{l} <span className="ordcount">{counts[t]}</span></button>)}
            </div>
          </div>
          <div className="ordtabs ordstatus" aria-label="Filter by status">
            {(["all", "paid", "cancelled", "refunded", "voided"] as Status[]).map((x) => <button key={x} className={status === x ? "selected" : ""} aria-pressed={status === x} onClick={() => setStatus(x)}>{x === "all" ? "All statuses" : LABEL[x]}</button>)}
          </div>
          {tab === "range" && (
            <div className="ordrange">
              <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
          )}
          {msg && !detail && !preview && <div className="floormsg" role="status">{msg}</div>}
          <div id="ordlist">
            {list.length === 0 && <p className="muted" style={{ padding: "1em" }}>No orders match.</p>}
            {list.slice(0, limit).map((o) => {
              const t = orderTotals(o, config);
              const st = stat.get(o.orderId)!;
              const items = o.lines.reduce((n, l) => n + l.qty, 0);
              const left = st === "open" && confirmedPaid(o) > 0 ? ` · ${formatMoney(t.total - confirmedPaid(o))} left` : "";
              return (
                <div className="ordline" key={o.orderId}>
                  <button className="ordrow" onClick={() => (st === "open" ? openOnTill(o) : openDetail(o))}>
                    <span className="ordmain"><strong>Order {o.queueNumber ? `#${o.queueNumber}` : "—"}</strong><small>{whereOf(o)} · {hm(o.openedAt)} · {items} items{left}{o.note ? ` · Note: ${o.note}` : ""}</small></span>
                    <span className="ordamt">{formatMoney(t.total)}</span>
                    <span className={`ordchip ${st === "open" ? "" : LABEL[st].toLowerCase()}`}>{LABEL[st]}</span>
                  </button>
                  {st === "open" && <button className="orddetail" aria-label={`Details of order ${o.queueNumber ?? ""}`} onClick={() => openDetail(o)}>Details</button>}
                </div>
              );
            })}
          </div>
          {list.length > limit && <button onClick={() => setLimit((n) => n + 40)}>Show more ({list.length - limit} more)</button>}
        </div>
      </main>
      {detail && !preview && !noting && (() => {
        const o = detail, st = stat.get(o.orderId)!, t = orderTotals(o, config);
        return (
          <ProtoModal title={`Order ${o.queueNumber ? `#${o.queueNumber}` : ""}`} wide onClose={() => setShown(null)}>
            <p className="muted">{LABEL[st]} · {whereOf(o)} · {timeOf(o.openedAt)} · {formatMoney(t.total)}{o.note ? ` · Note: ${o.note}` : ""}</p>
            {msg && <div className="error warn" role="status">{msg}</div>}
            <div className="choices ordacts">
              {st === "open" && <button className="primary" onClick={() => openOnTill(o)}>Open on till</button>}
              <button disabled={!staff} onClick={() => void showReceipt(o.orderId)}>Preview receipt</button>
              <button disabled={!staff} onClick={() => void reprint(o.orderId, "receipt")}>Print receipt</button>
              <button disabled={!staff} onClick={() => void reprint(o.orderId, "kitchen")}>Kitchen ticket</button>
              <button onClick={() => setNoting(o.orderId)}>{o.note ? "Edit note" : "Note"}</button>
              <button aria-pressed={mods} className={mods ? "selected" : ""} title="Whether a receipt lists each item's choices (extras, size, spice). Off unless you turn it on." onClick={() => setMods((m) => !m)}>Print modifiers: {mods ? "On" : "Off"}</button>
            </div>
            <div className="orddetailbody setours">
              <OrderDetails order={o} config={config} />
            </div>
            <div className="actions"><button onClick={() => setShown(null)}>Close</button></div>
          </ProtoModal>
        );
      })()}
      {noting && (() => {
        const o = all.find((x) => x.orderId === noting);
        if (!o) return null;
        return <NoteSheet title={`Note · order ${o.queueNumber ?? ""}`} initial={o.note ?? ""} max={200} onClose={() => setNoting(null)} onSave={(t) => { void record(o.orderId, { type: "OrderNoted", note: t, ...(staff ? { byName: staff.name } : {}) }).then(() => setMsg(t ? "Note saved. If the order was already sent, the kitchen gets a short slip." : "Note removed.")); setNoting(null); }} />;
      })()}
      {preview && (
        <ProtoModal title="Receipt" onClose={() => setPreview(null)}>
          <pre className="receipt r7" style={{ whiteSpace: "pre-wrap" }}>{preview.text}</pre>
          <div className="actions">
            <button onClick={() => { setMods((m) => !m); void showReceipt(preview.id, !mods); }}>Print modifiers: {mods ? "On" : "Off"}</button>
            <button onClick={() => void reprint(preview.id, "receipt").then(() => setPreview(null))}>Print</button>
            <button className="primary" onClick={() => setPreview(null)}>Close</button>
          </div>
        </ProtoModal>
      )}
    </div>
  );
}
