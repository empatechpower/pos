import { useEffect, useState } from "react";
import { confirmedPaid, formatMoney, optionLines, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";

interface ShopInfo {
  name: string;
  outletName: string;
  address?: string;
  gstRegNo?: string;
  brand?: { logoUrl: string | null };
}
let infoCache: Promise<ShopInfo | null> | null = null;
const loadInfo = () => (infoCache ??= fetch("/api/shop/info").then((r) => (r.ok ? (r.json() as Promise<ShopInfo>) : null)).catch(() => null));

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const dateOf = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const orderType = (o: OrderState) => `${o.source === "online" ? "QR" : "POS"} (${o.fulfilment === "dine_in" ? "Dine-in" : o.fulfilment === "takeaway" ? "Take away" : "Delivery"})`;

/** The full picture of one order for staff: who, where, when, what, and how it was paid. */
export function OrderDetails({ order: o, config }: { order: OrderState; config: BusinessConfig }) {
  const [info, setInfo] = useState<ShopInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  const t = orderTotals(o, config);
  const paid = confirmedPaid(o);
  const owing = t.total - paid;
  const lines = o.lines.filter((l) => l.qty > 0);
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
        {row("Customer", [o.customerName, o.customerPhone].filter(Boolean).join(" · ") || undefined)}
      </div>
      <table className="od-items">
        <thead><tr><th>Qty</th><th>Item</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineId}>
              <td>{l.qty}</td>
              <td>{l.name}{optionLines(l.options).map((x) => <div key={x} className="muted">- {x}</div>)}</td>
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
        {t.pointsDiscount > 0 && <div className="od-row"><span>Points</span><span>-{formatMoney(t.pointsDiscount)}</span></div>}
        <div className="od-row od-grand"><span>Total</span><span>{formatMoney(t.total)}</span></div>
        {o.payments.filter((p) => p.confirmed).map((p, i) => <div className="od-row" key={i}><span>Paid by {METHOD[p.method] ?? p.method}</span><span>{formatMoney(p.amountCents)}</span></div>)}
        {owing > 0 ? <div className="od-row od-due"><span>Balance due</span><span>{formatMoney(owing)}</span></div> : <div className="od-row"><span>Status</span><span>Paid</span></div>}
      </div>
    </div>
  );
}
