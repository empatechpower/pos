import { useEffect, useMemo, useState } from "react";
import { formatMoney, menuFor, quoteOrder, type BusinessConfig, type Catalog, type ShopStatus } from "@pos/core";

interface Info {
  name: string;
  outletName: string;
  paymentTiming: string;
  channels: Array<{ id: string; name: string; kind: string }>;
  brand: { primary: string; accent: string; ink: string; logoUrl: string | null };
}
interface OrderView {
  orderId: string;
  queueNumber: string;
  status: ShopStatus;
  channelName?: string;
  items: Array<{ name: string; qty: number; unitCents: number }>;
  totalCents: number;
  paidCents: number;
}

const LS_LAST = "shop.lastOrder";
const params = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
const orderIdFromHash = () => /^#\/shop\/order\/([\w-]+)/.exec(location.hash)?.[1] ?? null;

const STATUS_TEXT: Record<ShopStatus, { title: string; body: (o: OrderView) => string }> = {
  received: { title: "Order sent", body: () => "Waiting for the shop to accept your order. This page updates by itself." },
  awaiting_payment: { title: "Accepted: please pay", body: (o) => `Pay ${formatMoney(o.totalCents - o.paidCents)} at the counter and quote your number. We start your order once it is paid.` },
  queued: { title: "In the queue", body: () => "Your order is paid and waiting to be made." },
  preparing: { title: "Being prepared", body: () => "Your order is being made right now." },
  ready: { title: "Ready!", body: () => "Please collect your order at the counter." },
  completed: { title: "Collected", body: () => "Enjoy! Thank you for ordering." },
  cancelled: { title: "Order cancelled", body: () => "The shop could not take this order. Please ask at the counter, or order again." },
};
const STEPS: ShopStatus[] = ["received", "awaiting_payment", "queued", "preparing", "ready"];

/** The customer's own ordering page: no sign-in, no device set-up. Public by design. */
export function Shop() {
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BusinessConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [orderId, setOrderId] = useState(orderIdFromHash());

  useEffect(() => {
    const onHash = () => setOrderId(orderIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    Promise.all([fetch("/api/shop/info"), fetch("/api/catalog"), fetch("/api/config")])
      .then(async ([i, c, k]) => {
        if (!i.ok || !c.ok || !k.ok) throw new Error("bad response");
        setInfo((await i.json()) as Info);
        setCatalog((await c.json()) as Catalog);
        setConfig((await k.json()) as BusinessConfig);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <div className="shop"><div className="shop-msg"><h2>Ordering isn't available right now</h2><p>Please order at the counter, or try again in a moment.</p></div></div>;
  if (!info || !catalog || !config) return <div className="shop"><div className="shop-msg"><p>Loading…</p></div></div>;

  const theme = { "--brand": info.brand.primary, "--brand-ink": info.brand.ink, "--brand-soft": info.brand.accent } as React.CSSProperties;
  return (
    <div className="shop" style={theme}>
      <header className="shop-head">
        {info.brand.logoUrl ? <img src={info.brand.logoUrl} alt={info.name} /> : <b className="shop-name">{info.name}</b>}
        <span>{info.outletName}</span>
      </header>
      {orderId ? <Status orderId={orderId} /> : <Menu info={info} catalog={catalog} config={config} />}
    </div>
  );
}

function Menu({ info, catalog, config }: { info: Info; catalog: Catalog; config: BusinessConfig }) {
  const q = params();
  const channels = info.channels;
  const wanted = q.get("channel");
  const table = q.get("table") ?? "";
  const [channelId, setChannelId] = useState(channels.find((c) => c.id === wanted)?.id ?? (table ? channels.find((c) => c.kind === "dine_in")?.id : undefined) ?? channels[0]?.id ?? "");
  const [category, setCategory] = useState("All");
  const [bag, setBag] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [spot, setSpot] = useState(table);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [agreed, setAgreed] = useState<number | null>(null); // total the customer has accepted after a price change

  const ctx = { outletId: info.outletName, channelId };
  const menu = useMemo(() => menuFor(catalog, ctx), [catalog, info.outletName, channelId]);
  const channel = channels.find((c) => c.id === channelId);
  const categories = useMemo(() => ["All", ...new Set(menu.map((m) => m.category))], [menu]);

  // Items this channel does not sell leave the bag when the customer switches channel.
  useEffect(() => {
    setBag((cur) => {
      const kept = Object.fromEntries(Object.entries(cur).filter(([id]) => menu.some((m) => m.id === id && !m.soldOut)));
      if (Object.keys(kept).length < Object.keys(cur).length) setNote(`Some items were removed: they aren't sold for ${channel?.name}.`);
      return Object.keys(kept).length === Object.keys(cur).length ? cur : kept;
    });
  }, [menu]);

  const items = Object.entries(bag).map(([productId, qty]) => ({ productId, qty }));
  const count = items.reduce((n, i) => n + i.qty, 0);
  const quote = items.length ? quoteOrder(catalog, config, ctx, items) : null;
  const total = quote?.ok ? quote.priced.total : 0;
  const add = (id: string, d: number) => setBag((cur) => {
    const next = Math.min(20, (cur[id] ?? 0) + d);
    const { [id]: _, ...rest } = cur;
    return next > 0 ? { ...rest, [id]: next } : rest;
  });

  async function place() {
    if (!quote?.ok || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, items, customerName: name, customerPhone: phone, spot, expectedTotalCents: agreed ?? total }),
      });
      const j = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string; totalCents?: number; productId?: string };
      if (res.ok && j.orderId) {
        localStorage.setItem(LS_LAST, j.orderId);
        location.hash = `#/shop/order/${j.orderId}`;
      } else if (res.status === 409 && j.error === "price_changed") {
        setAgreed(j.totalCents ?? null);
        setNote(`Prices changed while you were ordering. The new total is ${formatMoney(j.totalCents ?? 0)}. Tap Place order again to confirm.`);
      } else if (res.status === 429) {
        setNote("Too many orders from this device. Please wait a few minutes or order at the counter.");
      } else if (j.error === "unavailable") {
        setNote("One of your items just sold out. Please check your bag.");
      } else {
        setNote("We couldn't place your order. Please try again, or order at the counter.");
      }
    } catch {
      setNote("No connection. Your order was not sent. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const last = localStorage.getItem(LS_LAST);
  const phoneOk = !phone || /^[+\d][\d\s-]{5,19}$/.test(phone);
  return (
    <>
      {last && <a className="shop-last" href={`#/shop/order/${last}`}>View my last order</a>}
      <div className="shop-seg">
        {channels.map((c) => (
          <button key={c.id} className={c.id === channelId ? "on" : ""} onClick={() => { setChannelId(c.id); setAgreed(null); }}>{c.name}</button>
        ))}
      </div>
      <div className="shop-chips">
        {categories.map((c) => <button key={c} className={c === category ? "on" : ""} onClick={() => setCategory(c)}>{c}</button>)}
      </div>
      {note && !open && <div className="shop-note">{note}</div>}
      <div className="shop-grid">
        {menu.filter((m) => category === "All" || m.category === category).map((m) => (
          <div key={m.id} className={`shop-card ${bag[m.id] ? "in" : ""} ${m.soldOut ? "out" : ""}`}>
            <span className="n">{m.name}</span>
            <span className="p">{m.soldOut ? "Sold out" : formatMoney(m.priceCents)}</span>
            {!m.soldOut && (bag[m.id] ? (
              <span className="step"><button aria-label={`Fewer ${m.name}`} onClick={() => add(m.id, -1)}>−</button><b>{bag[m.id]}</b><button aria-label={`More ${m.name}`} onClick={() => add(m.id, 1)}>+</button></span>
            ) : (
              <button className="add" onClick={() => add(m.id, 1)}>Add</button>
            ))}
          </div>
        ))}
      </div>

      {count > 0 && !open && (
        <button className="shop-bar" onClick={() => setOpen(true)}>
          <span>View bag · {count} item{count > 1 ? "s" : ""}</span><b>{formatMoney(total)}</b>
        </button>
      )}

      {open && quote?.ok && (
        <div className="shop-sheet" role="dialog" aria-label="Your bag">
          <div className="shop-sheet-in">
            <div className="shop-sheet-head"><h2>Your order</h2><button onClick={() => setOpen(false)} aria-label="Close">✕</button></div>
            <p className="muted">{channel?.name} · {info.outletName}</p>
            {quote.lines.map((l) => (
              <div className="shop-line" key={l.productId}>
                <span>{l.name}</span>
                <span className="step"><button onClick={() => add(l.productId, -1)} aria-label={`Fewer ${l.name}`}>−</button><b>{l.qty}</b><button onClick={() => add(l.productId, 1)} aria-label={`More ${l.name}`}>+</button></span>
                <span>{formatMoney(l.unitCents * l.qty)}</span>
              </div>
            ))}
            <dl className="shop-totals">
              <div><dt>Subtotal</dt><dd>{formatMoney(quote.priced.subtotal)}</dd></div>
              {quote.priced.service > 0 && <div><dt>Service charge</dt><dd>{formatMoney(quote.priced.service)}</dd></div>}
              {quote.priced.gst > 0 && <div><dt>GST</dt><dd>{formatMoney(quote.priced.gst)}</dd></div>}
              {quote.priced.bcrs > 0 && <div><dt>BCRS deposit</dt><dd>{formatMoney(quote.priced.bcrs)}</dd></div>}
              <div className="grand"><dt>Total</dt><dd>{formatMoney(agreed ?? total)}</dd></div>
            </dl>
            <label>Your name (optional)<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
            <label>Mobile number (optional, so we can reach you)<input value={phone} inputMode="tel" maxLength={20} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></label>
            {!phoneOk && <div className="shop-note">That number doesn't look right.</div>}
            {channel?.kind === "dine_in" && <label>Table<input value={spot} maxLength={30} onChange={(e) => setSpot(e.target.value)} placeholder="e.g. Table 12" /></label>}
            <p className="muted">{info.paymentTiming === "prepay" ? "You pay at the counter. We start your order once it is paid." : "You can pay at the counter."}</p>
            {note && <div className="shop-note">{note}</div>}
            <button className="shop-primary" disabled={busy || !phoneOk} onClick={() => void place()}>{busy ? "Sending…" : `Place order · ${formatMoney(agreed ?? total)}`}</button>
          </div>
        </div>
      )}
    </>
  );
}

function Status({ orderId }: { orderId: string }) {
  const [o, setO] = useState<OrderView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/shop/orders/${orderId}`);
        if (!alive) return;
        if (res.status === 404) return setProblem("We can't find that order.");
        if (!res.ok) return setProblem("Couldn't refresh. Retrying…");
        setO((await res.json()) as OrderView);
        setProblem(null);
      } catch {
        if (alive) setProblem("No connection. Retrying…");
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [orderId]);

  if (!o) return <div className="shop-msg"><p>{problem ?? "Loading your order…"}</p><a href="#/shop">Back to the menu</a></div>;
  const text = STATUS_TEXT[o.status];
  const step = STEPS.indexOf(o.status);
  return (
    <div className="shop-status">
      <div className="shop-number" aria-label={`Your number is ${o.queueNumber}`}>{o.queueNumber}</div>
      <h2 className={`s-${o.status}`}>{text.title}</h2>
      <p>{text.body(o)}</p>
      {step >= 0 && <ol className="shop-steps">{STEPS.map((s, i) => <li key={s} className={i <= step ? "done" : ""}>{STATUS_TEXT[s].title.split(":")[0]}</li>)}</ol>}
      <div className="shop-receipt">
        {o.items.map((i) => <div key={i.name}><span>{i.qty} × {i.name}</span><span>{formatMoney(i.qty * i.unitCents)}</span></div>)}
        <div className="grand"><span>Total</span><span>{formatMoney(o.totalCents)}</span></div>
      </div>
      {problem && <div className="shop-note">{problem}</div>}
      <a className="shop-primary link" href="#/shop" onClick={() => localStorage.removeItem(LS_LAST)}>Order again</a>
    </div>
  );
}
