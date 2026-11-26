import { useEffect, useState } from "react";
import { commissionOf, confirmedPaid, formatMoney, optionLines, orderTotals, type BusinessConfig, type Catalog, type OrderState, recordedTender } from "@pos/core";
import { staffFetch } from "../auth";
import { RefundPanel } from "./RefundPanel";
import { OrderTrail } from "./OrderTrail";
import { logView } from "../orderViews";

interface ShopInfo {
  name: string;
  outletName: string;
  address?: string;
  gstRegNo?: string;
  brand?: { logoUrl: string | null };
}
let infoCache: Promise<ShopInfo | null> | null = null;
const loadInfo = () => (infoCache ??= fetch("/api/shop/info").then((r) => (r.ok ? (r.json() as Promise<ShopInfo>) : null)).catch(() => null));

let catalogCache: Promise<Catalog | null> | null = null;
const loadCatalog = () => (catalogCache ??= fetch("/api/catalog").then((r) => (r.ok ? (r.json() as Promise<Catalog>) : null)).catch(() => null));

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const dateOf = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const orderType = (o: OrderState) => `${o.source === "online" ? "QR" : "POS"} (${o.fulfilment === "dine_in" ? "Dine-in" : o.fulfilment === "takeaway" ? "Take away" : "Delivery"})`;

/** The full picture of one order for staff: who, where, when, what, and how it was paid. */
export function OrderDetails({ order: o, config }: { order: OrderState; config: BusinessConfig }) {
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [entered, setEntered] = useState<number | null>(null); // the actual commission just recorded, until the order syncs back
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { logView(o.orderId, "Order details"); }, [o.orderId]);
  useEffect(() => {
    let alive = true;
    void loadInfo().then((i) => alive && setInfo(i));
    void loadCatalog().then((c) => alive && setCatalog(c));
    return () => {
      alive = false;
    };
  }, []);
  const t = orderTotals(o, config);
  const paid = confirmedPaid(o);
  const owing = t.total - paid;
  const lines = o.lines.filter((l) => l.qty > 0);
  const channel = catalog?.channels.find((c) => c.id === o.channelId);
  const comm = commissionOf(entered !== null ? { commission: { cents: entered } } : o, t.total, channel);
  async function saveCommission() {
    const cents = Math.round(Number(amt) * 100);
    const r = await staffFetch(`/api/orders/${o.orderId}/commission`, { method: "POST", body: { cents, ...(note.trim() ? { note: note.trim() } : {}) } });
    if ("res" in r && r.res.ok) { setEntered(cents); setMsg("Saved."); setAmt(""); setNote(""); }
    else if ("res" in r) setMsg(((await r.res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
    else setMsg(r.problem);
  }
  const row = (k: string, v: string | undefined) => (v ? <div className="od-row"><span className="od-k">{k}</span><span className="od-v">{v}</span></div> : null);
  return (
    <div className="order-details" role="region" aria-label={`Details of order ${o.queueNumber ?? ""}`}>
      <div className="od-head">
        {info?.brand?.logoUrl && <img src={info.brand.logoUrl} alt="" width={56} height={56} style={{ objectFit: "contain" }} />}
        <div>
          <div className="od-title">{info?.name ?? "Order"}{info ? " Cafe" : ""}</div>
          {info?.address && <div className="muted">{info.address}</div>}
          <div className="muted">GST Reg No. {info?.gstRegNo ?? "—"}</div>
        </div>
        <div className="od-total"><div className="muted">Order Total</div><b>{(t.total / 100).toFixed(2)}</b></div>
      </div>
      <div className="od-card">
        {row("Date", dateOf(o.openedAt))}
        {row("Reference ID", o.orderId.slice(0, 8))}
        {row("Queue number", o.queueNumber)}
        {row("Order Type", orderType(o))}
        {row("Storefront", o.source === "online" ? "Scan-to-Order" : "Counter")}
        {row("Channel", o.channelName)}
        {row("Table No.", o.spot)}
        {row("Guests", o.pax ? String(o.pax) : undefined)}
        {row("Order note", o.note)}
        {row("Customer", [o.customerName, o.customerPhone].filter(Boolean).join(" · ") || undefined)}
      </div>
      {comm && (
        <div className="od-card">
          {row("Commission", `${formatMoney(comm.cents)} (${comm.source === "actual" ? "actual, entered for this order" : `contract rate ${channel!.commission!.ratePct}%`})`)}
          {row("Note", o.commission?.note)}
          <div className="od-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input style={{ width: 90 }} inputMode="decimal" placeholder="Actual S$" aria-label="Actual commission in dollars" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} />
            <input style={{ flex: 1, minWidth: 120 }} maxLength={120} placeholder="Note (e.g. platform promotion)" aria-label="Commission note" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="secondary sm" disabled={amt === ""} onClick={() => void saveCommission()}>Record actual</button>
          </div>
          {msg && <div className="muted">{msg}</div>}
        </div>
      )}
      <table className="od-items">
        <thead><tr><th>Qty</th><th>Item</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineId}>
              <td>{l.qty}</td>
              <td>{l.name}{l.override && <div className="muted">price changed from {formatMoney(l.listUnitCents ?? 0)} · {l.override.reason}{l.override.approvedByName ? ` · ${l.override.approvedByName}` : ""}</div>}{optionLines(l.options).map((x) => <div key={x} className="muted">- {x}</div>)}</td>
              <td>{(l.unitCents / 100).toFixed(2)}</td>
              <td>{((l.unitCents * l.qty) / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="od-sums">
        <div className="od-row"><span>Items subtotal</span><span>{formatMoney(t.subtotal)}</span></div>
        {t.service > 0 && <div className="od-row"><span>Service charge ({Math.round(config.pricing.serviceRate * 1000) / 10}%)</span><span>{formatMoney(t.service)}</span></div>}
        {t.gst > 0 && <div className="od-row"><span>GST</span><span>{formatMoney(t.gst)}</span></div>}
        {t.bcrs > 0 && <div className="od-row"><span>BCRS deposit</span><span>{formatMoney(t.bcrs)}</span></div>}
        {t.couponDiscount > 0 && <div className="od-row"><span>Coupon</span><span>-{formatMoney(t.couponDiscount)}</span></div>}
        {t.discountCents > 0 && <div className="od-row"><span>Discount{(o.discounts ?? []).length ? ` · ${(o.discounts ?? []).map((x) => x.reason).join(", ")}` : ""}</span><span>-{formatMoney(t.discountCents)}</span></div>}
        {t.pointsDiscount > 0 && <div className="od-row"><span>Points</span><span>-{formatMoney(t.pointsDiscount)}</span></div>}
        <div className="od-row od-grand"><span>Total</span><span>{formatMoney(t.total)}</span></div>
        {o.handover && <div className="od-row"><span>Handed to {o.handover.to}{o.handover.ref ? ` (${o.handover.ref})` : ""}{o.handover.byName ? ` · by ${o.handover.byName}` : ""}</span><span>{new Date(o.handover.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" })}</span></div>}
        {o.payments.filter((p) => p.confirmed && !p.paymentId.startsWith("refund:")).map((p, i) => <div className="od-row" key={i}><span>Paid by {recordedTender(p.tender)?.label ?? p.tenderName ?? METHOD[p.method] ?? p.method}{p.reference ? ` · ref ${p.reference}` : ""}</span><span>{formatMoney(p.amountCents)}</span></div>)}
        {o.voided ? <div className="od-row"><span>Status</span><span>Voided</span></div> : owing > 0 ? <div className="od-row od-due"><span>Balance due</span><span>{formatMoney(owing)}</span></div> : <div className="od-row"><span>Status</span><span>Paid</span></div>}
      </div>
      <RefundPanel order={o} />
      <OrderTrail orderId={o.orderId} />
    </div>
  );
}
