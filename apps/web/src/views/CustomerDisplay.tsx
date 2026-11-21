import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { IDLE_DISPLAY, formatMoney, readableOn, type DisplayState } from "@pos/core";
import { listenDisplay } from "../customerDisplayBus";
import { tint, type Info } from "./Shop";
import "../customerDisplay.css";

const DEMO_STATE: DisplayState = {
  mode: "sale", orderType: "Dine in", orderNo: "0128", demo: true,
  lines: [
    { qty: 2, name: "Original WTM", details: ["Add noodle", "No spring onion"], lineCents: 1800 },
    { qty: 1, name: "Fried Wanton (7pcs)", details: [], lineCents: 600 },
    { qty: 1, name: "Sparkling drink (330 ml)", details: [], lineCents: 300, deposit: true },
    { qty: 1, name: "Thai Milk Tea", details: ["Iced"], lineCents: 450 },
  ],
  totals: [{ key: "subtotal", label: "Items subtotal", cents: 3150 }, { key: "service", label: "Service fee (10%)", cents: 315 }, { key: "deposit", label: "BCRS deposit", cents: 10 }],
  totalCents: 3475,
  qrText: "demo",
};

/**
 * The screen that faces the customer: what is being rung up, the totals, and the payment QR. It only draws what it is given
 * (see customerDisplayBus) and knows no prices or rules. Public: no sign-in, opened full screen on the second display.
 * ?demo shows a sample sale; ?outlet=CODE picks the shop whose logo and colours it wears.
 */
export function CustomerDisplay() {
  const q = new URLSearchParams(location.search);
  const [state, setState] = useState<DisplayState>(q.has("demo") ? { ...DEMO_STATE, mode: (q.get("mode") as DisplayState["mode"]) || "sale" } : IDLE_DISPLAY);
  const [info, setInfo] = useState<Info | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => listenDisplay(setState), []);
  useEffect(() => {
    const o = q.get("outlet");
    void fetch(`/api/shop/info${o ? `?outlet=${encodeURIComponent(o)}` : ""}`).then((r) => (r.ok ? (r.json() as Promise<Info>) : null)).then(setInfo).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    if (state.qrImage) { setQr(state.qrImage); return; }
    if (!state.qrText) { setQr(null); return; }
    void QRCode.toDataURL(state.qrText, { margin: 1, width: 360 }).then((u) => { if (live) setQr(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [state.qrText, state.qrImage]);

  const b = info?.brand;
  const brand = b?.primary ?? "#091744";
  const accent = b?.accent ?? "#EA7016";
  const theme = { "--cd-brand": brand, "--cd-brand-ink": readableOn(brand), "--cd-accent": accent, "--cd-soft": tint(accent) } as React.CSSProperties;
  const logo = b?.logoUrl ? <img className="cd-logo" src={b.logoUrl} alt={info?.name ?? ""} /> : <b className="cd-logo-text">{info?.name ?? ""}</b>;

  if (state.mode === "idle") {
    return (
      <div className="cd cd-idle" style={theme}>
        {b?.logoUrl ? <img className="cd-idle-logo" src={b.logoUrl} alt={info?.name ?? ""} /> : <h1>{info?.name ?? ""}</h1>}
        {b?.tagline && <p>{b.tagline}</p>}
      </div>
    );
  }

  const thanks = state.mode === "thanks";
  return (
    <div className="cd" style={theme}>
      <header className="cd-head">
        {logo}
        {state.orderType && <span className="cd-chip">{state.orderType}</span>}
        {state.orderNo && <span className="cd-chip cd-big">Order #{state.orderNo}</span>}
        <span className="cd-status">{thanks ? "Thank you!" : state.mode === "pay" ? "Please pay" : "Order in progress"}</span>
      </header>
      <div className="cd-body">
        <aside className="cd-side">
          {state.mode === "pay" && qr ? (
            <div className="cd-qr">
              <img src={qr} alt="Payment QR" />
              <b>Scan to pay</b>
              {state.demo && <small>DEMO · NOT PAYABLE</small>}
            </div>
          ) : state.imageUrl ? (
            <img className="cd-photo" src={state.imageUrl} alt="" />
          ) : b?.logoUrl ? (
            <div className="cd-brandcard"><img src={b.logoUrl} alt={info?.name ?? ""} />{b.tagline && <p>{b.tagline}</p>}</div>
          ) : null}
          <div className="cd-totals">
            {state.totals.map((t) => (
              <div key={t.key} className="cd-row"><span>{t.label}</span><span>{t.negative ? "−" : ""}{formatMoney(t.cents)}</span></div>
            ))}
            <div className="cd-grand"><span>TOTAL TO PAY</span><b>{formatMoney(state.totalCents)}</b></div>
          </div>
        </aside>
        <ol className="cd-lines">
          {state.lines.map((l, i) => (
            <li key={i} className={i === state.lines.length - 1 && state.mode === "sale" ? "cd-new" : ""}>
              <span className="cd-qty">{l.qty}</span>
              <span className="cd-name"><b>{l.name}</b>{l.details.length > 0 && <small>{l.details.join(" • ")}</small>}{l.deposit && <em>BCRS deposit</em>}</span>
              <span className="cd-price">{formatMoney(l.lineCents)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
