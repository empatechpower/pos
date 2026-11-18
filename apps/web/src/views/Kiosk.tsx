import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { cleanNote, defaultSelection, formatMoney, menuFor, priceRange, quoteOrder, readableOn, resolveOptions, type BusinessConfig, type Catalog, type ChosenOptionInput, type MenuEntry } from "@pos/core";
import { OptionSheet } from "./OptionSheet";
import { RollMoney } from "./RollMoney";
import { Icon, SwipeRow, linkOutlet, photo, tint, useDialog, type BagLine, type Info, type OrderView } from "./Shop";
import { LANGS, lang, setLangMode, t, tx, useLang } from "../shopI18n";
import "../kiosk.css";

/**
 * The in-store self-order kiosk (a portrait tablet). It shares the customer shop's data, prices, options sheet, rolling money and
 * language system; what is here is only what the kiosk does differently: a start screen, one merged Review & pay screen, a session
 * that wipes itself when nobody is there, and payment shown as a QR for the customer's own phone.
 *
 * Not built yet: member sign-in and points/coupons (waiting for the CRM handover) and the 30-language picker (8 languages today).
 */

type Screen = "start" | "menu" | "review" | "pay" | "done";

// The kiosk lists languages in the product's source-market order (the handover's list); the ones we have, in that order.
const KIOSK_LANG_ORDER = ["en", "id", "zh", "ms", "ta", "ja", "de", "fr"];
const FLAG: Record<string, string> = { en: "🇺🇳", ms: "🇲🇾", id: "🇮🇩", zh: "🇨🇳", ja: "🇯🇵", fr: "🇫🇷", de: "🇩🇪", ta: "🇮🇳" };
const NUDGE_AFTER_S = 20; // the Reset button starts pulsing
const WARN_FOR_S = 10; // "Still there?" shows for the last ten seconds before the wipe
const DONE_CLEARS_S = 20; // the confirmation clears itself
const LS_IDLE = "kiosk.idleMinutes";
const LS_CHIPS = "kiosk.chips";
const LS_SIGNIN = "kiosk.signinBlock";
const IDLE_CHOICES = [1, 2, 3, 5];
const CHIPS = [
  { id: "earn", text: "Earn points on every order", icon: "★" },
  { id: "rate", text: "100 points = S$1 off", icon: "✦" },
  { id: "stamps", text: "Collect stamps & rewards", icon: "♥" },
] as const;

const readNum = (k: string, d: number) => {
  try {
    const n = Number(localStorage.getItem(k));
    return IDLE_CHOICES.includes(n) ? n : d;
  } catch {
    return d;
  }
};
const readSignin = (): boolean => {
  try {
    return localStorage.getItem(LS_SIGNIN) !== "0";
  } catch {
    return true;
  }
};
const readChips = (): Record<string, boolean> => {
  try {
    return { earn: true, rate: true, stamps: true, ...(JSON.parse(localStorage.getItem(LS_CHIPS) ?? "{}") as Record<string, boolean>) };
  } catch {
    return { earn: true, rate: true, stamps: true };
  }
};

export function Kiosk() {
  useLang();
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BusinessConfig | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const o = linkOutlet();
    Promise.all([fetch(`/api/shop/info${o ? `?outlet=${encodeURIComponent(o)}` : ""}`), fetch("/api/catalog"), fetch("/api/config")])
      .then(async ([i, c, k]) => {
        if (!i.ok || !c.ok || !k.ok) throw new Error("bad response");
        setInfo((await i.json()) as Info);
        setCatalog((await c.json()) as Catalog);
        setConfig((await k.json()) as BusinessConfig);
      })
      .catch(() => setFailed(true));
  }, []);

  // Keep the menu current: ask for its version now and then, download only when it changed.
  const have = useRef(0);
  have.current = catalog?.version ?? 0;
  useEffect(() => {
    const run = async () => {
      if (!have.current) return;
      try {
        const v = await fetch("/api/catalog/version", { cache: "no-store" });
        if (!v.ok) return;
        if (((await v.json()) as { version: number }).version === have.current) return;
        const c = await fetch("/api/catalog", { cache: "no-cache" });
        if (c.ok) setCatalog((await c.json()) as Catalog);
      } catch {
        /* offline: keep what we have */
      }
    };
    const id = window.setInterval(() => void run(), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (failed) return <div className="kiosk shop"><div className="k-msg"><h2>{tx("Ordering isn't available right now")}</h2><p>{tx("Please order at the counter, or try again in a moment.")}</p></div></div>;
  if (!info || !catalog || !config) return <div className="kiosk shop"><div className="k-msg"><p>{tx("Loading…")}</p></div></div>;
  return <KioskSession info={info} catalog={catalog} config={config} />;
}

function KioskSession({ info, catalog, config }: { info: Info; catalog: Catalog; config: BusinessConfig }) {
  const b = info.brand;
  const theme = { "--brand": b.primary, "--accent": b.accent, "--accent-ink": readableOn(b.accent), "--soft": tint(b.accent), "--brand-ink": b.ink } as React.CSSProperties;

  // (Development only: ?screen=menu opens the menu directly, for screenshots.)
  const [screen, setScreen] = useState<Screen>(() => (import.meta.env.DEV && new URLSearchParams(location.search).get("screen") === "menu" ? "menu" : "start"));
  const [bag, setBag] = useState<BagLine[]>([]);
  const channels = info.channels.filter((c) => c.kind === "dine_in" || c.kind === "takeaway");
  const [channelId, setChannelId] = useState(channels.find((c) => c.kind === "dine_in")?.id ?? channels[0]?.id ?? info.channels[0]?.id ?? "");
  const [langOpen, setLangOpen] = useState(() => import.meta.env.DEV && new URLSearchParams(location.search).get("dialog") === "lang"); // (development only: ?dialog=lang)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetAsk, setResetAsk] = useState(false);
  const [picking, setPicking] = useState<MenuEntry | null>(null);
  const [editing, setEditing] = useState<BagLine | null>(null);
  const [idleMin, setIdleMin] = useState(() => readNum(LS_IDLE, 1));
  const [chips, setChips] = useState(readChips);
  const [signinBlock, setSigninBlock] = useState(readSignin);
  const [soon, setSoon] = useState(false);
  const [startQr, setStartQr] = useState<string | null>(null);
  useEffect(() => { void QRCode.toDataURL(`${location.origin}/shop`, { margin: 1, width: 160 }).then(setStartQr).catch(() => undefined); }, []);
  useEffect(() => {
    if (!soon) return;
    const id = window.setTimeout(() => setSoon(false), 3500);
    return () => window.clearTimeout(id);
  }, [soon]);
  const [order, setOrder] = useState<{ id: string; qr: string | null; view: OrderView | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [idle, setIdle] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const [doneLeft, setDoneLeft] = useState(DONE_CLEARS_S);
  // (Development only: ?dialog=idle or ?dialog=reset shows that dialog, for screenshots.)
  const devDialog = import.meta.env.DEV ? new URLSearchParams(location.search).get("dialog") : null;

  // ---- menu data
  const ctx = { outletId: info.outletId ?? info.outletName, channelId };
  const menu = useMemo(() => menuFor(catalog, ctx), [catalog, info.outletId, info.outletName, channelId]);
  const byId = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const items = bag.map((l) => ({ productId: l.productId, qty: l.qty, options: l.selection, ...(l.note ? { note: l.note } : {}) }));
  const quote = items.length ? quoteOrder(catalog, config, ctx, items, null, null) : null;
  const total = quote?.ok ? quote.priced.total : 0;
  const count = bag.reduce((n, l) => n + l.qty, 0);
  // What a guest would earn if they signed up, on the amount they would pay (the prototype shows 522 for a S$5.22 order). The shop's own earning rule when points are on; while the sign-in block is shown as a
  // preview and points are off, the prototype's sample rate (100 points a dollar), so the screen can be compared with the prototype.
  const earnRate = config.rewards.pointsEnabled ? config.rewards.earnPointsPerDollar : signinBlock ? 100 : 0;
  const earnPts = earnRate > 0 && quote?.ok ? Math.floor((quote.priced.total / 100) * earnRate) : 0;

  // ---- the bag
  const addLine = (m: MenuEntry, selection: ChosenOptionInput[], d = 1, rawNote = "") => {
    const r = resolveOptions(m.options, selection);
    if (!r.ok) return;
    const note = cleanNote(rawNote);
    const key = `${m.id}#${r.key}${note ? `#${note}` : ""}`;
    setBag((cur) => {
      const have = cur.find((l) => l.key === key);
      const qty = (have?.qty ?? 0) + d;
      if (qty <= 0) return cur.filter((l) => l.key !== key);
      const next = Math.min(20, qty);
      return have ? cur.map((l) => (l.key === key ? { ...l, qty: next } : l)) : [...cur, { key, productId: m.id, qty: next, selection, ...(note ? { note } : {}) }];
    });
  };
  /** The item's plain line: the one added with its default choices and no note. */
  const plain = (m: MenuEntry) => {
    const r = resolveOptions(m.options, m.options?.length ? defaultSelection(m.options) : []);
    return r.ok ? bag.find((l) => l.key === `${m.id}#${r.key}`) : undefined;
  };
  const qtyOf = (m: MenuEntry) => bag.filter((l) => l.productId === m.id).reduce((n, l) => n + l.qty, 0);
  const addQuick = (m: MenuEntry, d: number) => addLine(m, m.options?.length ? defaultSelection(m.options) : [], d);
  /** The card's minus: takes one off the plain line; if the item is in the bag only with choices, it opens Review & pay instead of guessing. */
  const lessOf = (m: MenuEntry) => {
    const p = plain(m);
    if (p) addLine(m, p.selection, -1);
    else go("review");
  };
  const go = (s: Screen) => {
    setScreen(s);
    setProblem(null);
    window.scrollTo(0, 0);
  };

  // (Development only, for screenshots: ?bag=3 starts with three items in the bag; ?screen=review opens Review & pay.)
  const seeded = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || seeded.current || !menu.length) return;
    const q = new URLSearchParams(location.search);
    const n = Number(q.get("bag") ?? (q.get("screen") === "review" ? 3 : 0));
    if (!n && q.get("screen") !== "review") return;
    seeded.current = true;
    menu.slice(0, n).forEach((m) => addLine(m, m.options?.length ? defaultSelection(m.options) : [], 1));
    if (q.get("screen") === "review") setScreen("review");
  }, [menu]);

  // ---- the session: wipe when nobody is there
  const touch = useRef(Date.now());
  const wipe = useCallback(() => {
    setBag([]);
    setOrder(null);
    setPicking(null);
    setEditing(null);
    setLangOpen(false);
    setResetAsk(false);
    setSettingsOpen(false);
    setProblem(null);
    setIdle(0);
    setScreen("start");
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const mark = () => { touch.current = Date.now(); setIdle(0); };
    const ev = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    ev.forEach((e) => window.addEventListener(e, mark, { passive: true, capture: true }));
    return () => ev.forEach((e) => window.removeEventListener(e, mark, true));
  }, []);
  // Scrolling anywhere under the floating buttons fades them down until the scroll settles (400 ms).
  useEffect(() => {
    let timer = 0;
    const on = () => { setScrolling(true); window.clearTimeout(timer); timer = window.setTimeout(() => setScrolling(false), 400); };
    document.addEventListener("scroll", on, { capture: true, passive: true });
    return () => { document.removeEventListener("scroll", on, true); window.clearTimeout(timer); };
  }, []);
  const watching = screen === "menu" || screen === "review";
  useEffect(() => {
    if (!watching) { setIdle(0); return; }
    touch.current = Date.now();
    const id = window.setInterval(() => {
      const s = Math.floor((Date.now() - touch.current) / 1000);
      setIdle(s);
      if (s >= idleMin * 60) wipe();
    }, 1000);
    return () => window.clearInterval(id);
  }, [watching, idleMin, wipe]);
  const warnLeft = idleMin * 60 - idle;
  const warning = watching && warnLeft <= WARN_FOR_S && warnLeft > 0;
  const nudge = screen === "menu" && idle >= NUDGE_AFTER_S && !resetAsk;

  // The confirmation clears itself.
  useEffect(() => {
    if (screen !== "done") return;
    setDoneLeft(DONE_CLEARS_S);
    const id = window.setInterval(() => setDoneLeft((n) => n - 1), 1000);
    return () => window.clearInterval(id);
  }, [screen]);
  useEffect(() => { if (screen === "done" && doneLeft <= 0) wipe(); }, [screen, doneLeft, wipe]);

  // ---- placing the order
  const place = async () => {
    if (!quote?.ok || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, outletId: info.outletId, items, customerName: "Kiosk", customerPhone: "", spot: "", expectedTotalCents: total }),
      });
      const j = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string; totalCents?: number };
      if (!res.ok || !j.orderId) {
        setProblem(j.error === "sign_in_to_order" || j.error === "pay_with_credit" ? tx("This shop takes orders from members only. Please order at the counter.") : res.status === 409 ? tx("Prices changed while you were ordering. The new total is {amt}. Tap Pay again to confirm.", { amt: formatMoney(j.totalCents ?? 0) }) : tx("We couldn't place your order. Please try again, or order at the counter."));
        return;
      }
      // PayNow: the shop's payment page, shown as a QR the customer scans with their own phone. Otherwise they pay at the counter.
      let qr: string | null = null;
      if (info.payments.online && info.payments.methods.includes("paynow")) {
        const pr = await fetch(`/api/shop/orders/${j.orderId}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "paynow" }) })
          .then((r) => r.json() as Promise<{ url?: string }>)
          .catch(() => ({}) as { url?: string });
        if (pr.url) qr = await QRCode.toDataURL(pr.url, { margin: 1, width: 560 }).catch(() => null);
      }
      setOrder({ id: j.orderId, qr, view: null });
      setBag([]);
      go(qr ? "pay" : "done");
    } catch {
      setProblem(tx("We lost the connection, so we cannot tell if your order went through. Tap Pay again: you will not be charged twice."));
    } finally {
      setBusy(false);
    }
  };

  // While the QR is on screen, watch for the payment to land.
  useEffect(() => {
    if (screen !== "pay" || !order) return;
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/shop/orders/${order.id}`).catch(() => null);
      if (!r || !r.ok || stop) return;
      const v = (await r.json()) as OrderView;
      setOrder((o) => (o ? { ...o, view: v } : o));
      if (v.paidCents >= v.totalCents && v.totalCents > 0) go("done");
    };
    const id = window.setInterval(() => void tick(), 3000);
    void tick();
    return () => { stop = true; window.clearInterval(id); };
  }, [screen, order?.id]);
  // The confirmation needs the order's collection number.
  useEffect(() => {
    if (screen !== "done" || !order || order.view) return;
    void fetch(`/api/shop/orders/${order.id}`).then((r) => (r.ok ? (r.json() as Promise<OrderView>) : null)).then((v) => v && setOrder((o) => (o ? { ...o, view: v } : o))).catch(() => undefined);
  }, [screen, order]);

  const langNative = LANGS.find((l) => l.code === lang())!.native;
  // The language button is on every screen; Reset screen only on the menu, where an order is being built.
  const langButton = <button className="k-lang pulse" onClick={() => setLangOpen(true)} aria-label={t("language", "Language")}><span aria-hidden>{FLAG[lang()]}</span> {langNative} <span aria-hidden>▾</span></button>;
  const floating = (
    <div className="k-float">
      <button className={`k-reset ${nudge ? "pulse" : ""}`} onClick={() => setResetAsk(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg><span>{tx("Reset screen")}</span></button>
      {langButton}
    </div>
  );
  const langOnly = <div className="k-float">{langButton}</div>;
  // Double-tapping the logo opens the operator's settings.
  const lastTap = useRef(0);
  const logoTap = () => { const n = Date.now(); if (n - lastTap.current < 450) setSettingsOpen(true); lastTap.current = n; };
  const logo = b.logoUrl ? <img className="k-logo" src={b.logoUrl} alt={info.name} onClick={logoTap} /> : <b className="k-logo-text" onClick={logoTap}>{info.name}</b>;

  let body: React.ReactNode;
  if (screen === "start") {
    const anyChip = CHIPS.some((c) => chips[c.id]);
    body = (
      <div className="k-start">
        <div className="k-hero">
          {b.heroUrl && <img src={b.heroUrl} alt="" />}
          <div className="k-brand">
            {b.logoUrl ? <img src={b.logoUrl} alt={info.name} onClick={logoTap} /> : <b className="k-logo-text" onClick={logoTap}>{info.name}</b>}
            <div className="k-bt"><b>{info.name}</b>{b.tagline && <span>{b.tagline}</span>}</div>
          </div>
        </div>
        <div className="k-start-body">
          <h1>{tx("What would you like today?")}</h1>
          <p className="k-sub">{tx("Tap to order, pay here, and listen for your number at the counter.")}</p>
          <button className="k-cta" onClick={() => go("menu")}><b>{tx("Start my order")}</b><span>{tx("Continue as guest — no sign-in needed")}</span></button>
          {(anyChip || signinBlock) && <div className="k-or">{tx("Members — sign in for points & rewards")}</div>}
          {anyChip && (
            <div className="k-perks">
              <p><strong>{tx("New here?")}</strong> {tx("Sign in or sign up free on your phone — it takes less than a minute.")}</p>
              <div className="k-chips">{CHIPS.filter((c) => chips[c.id]).map((c) => <span key={c.id}><i aria-hidden>{c.icon}</i>{tx(c.text)}</span>)}</div>
            </div>
          )}
          {signinBlock && (
            <>
              <button className="k-qrhero" onClick={() => setSoon(true)}>
                {startQr && <img src={startQr} alt="" />}
                <span><b>{tx("Scan with your phone to sign in")}</b><small>{tx("Point your phone camera at the code — no typing on this screen")}</small></span>
                <i aria-hidden>›</i>
              </button>
              <button className="k-ghost-wide" onClick={() => setSoon(true)}>{tx("Sign in with phone number")}</button>
              <div className="k-social">
                <button className="k-ghost-wide" onClick={() => setSoon(true)}><span className="g">G</span> Google</button>
                <button className="k-ghost-wide" onClick={() => setSoon(true)}><span className="m">▦</span> Microsoft</button>
              </div>
            </>
          )}
        </div>
        <div className={`k-corner ${scrolling ? "fade" : ""}`}>{langOnly}</div>
      </div>
    );
  } else if (screen === "menu") {
    body = <KioskMenu info={info} menu={menu} channels={channels} channelId={channelId} setChannelId={setChannelId} count={count} total={total} qtyOf={qtyOf} addQuick={addQuick} lessOf={lessOf} open={(m) => (m.options?.length ? setPicking(m) : addQuick(m, 1))} onCheckout={() => go("review")} floating={floating} logo={logo} showSignin={signinBlock} onSignin={() => setSoon(true)} scrolling={scrolling} />;
  } else if (screen === "review") {
    const q = quote?.ok ? quote : null;
    body = (
      <div className="k-review">
        <header className="k-bar"><button className="k-back" onClick={() => go("menu")}>‹ {tx("Back to menu")}</button><h2>{tx("Order summary")}</h2></header>
        <div className="k-lines">
          {bag.length === 0 && <p className="k-empty">{tx("Your order is empty.")}</p>}
          {bag.map((l, at) => {
            const m = byId.get(l.productId);
            const pl = q?.lines[at]; // the quote lists the lines in the bag's order
            if (!m) return null;
            return (
              <SwipeRow key={l.key} label={tx("Remove")} onRemove={() => setBag((c) => c.filter((x) => x.key !== l.key))}>
                <div className="k-line">
                  {photo(m) && <img src={photo(m)!} alt="" />}
                  <div className="k-line-name" onClick={() => m.options?.length && setEditing(l)}>
                    <b>{pl?.name ?? m.name}</b>
                    {pl?.bcrs ? <small>+{config.pricing.bcrsDepositCents}c BCRS {tx("Deposit per item")}</small> : null}
                    <small>{formatMoney(pl?.unitCents ?? m.priceCents)} {tx("each")}</small>
                    {m.options?.length ? <small className="k-edit">{tx("Change")}</small> : null}
                  </div>
                  <div className="k-step"><button aria-label="−" onClick={() => addLine(m, l.selection, -1, l.note)}>−</button><span>{l.qty}</span><button aria-label="+" onClick={() => addLine(m, l.selection, 1, l.note)}>+</button></div>
                  <span className="k-line-price"><RollMoney cents={(pl?.unitCents ?? m.priceCents) * l.qty} /></span>
                </div>
              </SwipeRow>
            );
          })}
          {earnPts > 0 && <div className="k-guestnote">{tx("Ordering as a guest — sign up as a member to earn")} <b>{earnPts.toLocaleString()}</b> {tx("points on this order.")}</div>}
          <div className="k-totals">
            <div><span>{tx("Items")}</span><span><RollMoney cents={q?.priced.subtotal ?? 0} /></span></div>
            {q && q.priced.service > 0 && <div><span>{t("pmService", "Service charge")} ({Math.round(config.pricing.serviceRate * 1000) / 10}%)</span><span><RollMoney cents={q.priced.service} /></span></div>}
            {q && q.priced.gst > 0 && <div><span>{tx("GST")}</span><span><RollMoney cents={q.priced.gst} /></span></div>}
            {q && q.priced.bcrs > 0 && <div><span>{t("bcrsDeposit", "BCRS Deposit")} (+{config.pricing.bcrsDepositCents}c × {q.lines.reduce((n, l) => n + (l.bcrs ? l.qty : 0), 0)})</span><span><RollMoney cents={q.priced.bcrs} /></span></div>}
            <div className="k-total"><span>{t("total", "Total")}</span><span><RollMoney cents={total} /></span></div>
          </div>
        </div>
        {problem && <p className="k-problem" role="alert">{problem}</p>}
        <footer className="k-foot"><div className="k-actions">
          <button className="k-ghost" onClick={() => go("menu")}>{tx("Add more items")}</button>
          <button className="k-cta-sm" disabled={!q || busy} onClick={() => void place()}><span className="k-cta-label">{busy ? tx("Placing your order…") : bag.length ? <>{tx("Place order & pay")} · <RollMoney cents={total} /></> : tx("Place order & pay")}</span></button>
        </div></footer>
        <div className={`k-corner ${scrolling ? "fade" : ""}`}>{langOnly}</div>
      </div>
    );
  } else if (screen === "pay") {
    body = (
      <div className="k-review">
        <header className="k-bar"><h2>{tx("Payment")}</h2></header>
        <div className="k-pay">
          <p className="k-sub">{tx("Total to pay")}</p>
          <div className="k-big"><RollMoney cents={order?.view?.totalCents ?? 0} /></div>
          {order?.qr && <img className="k-qr" src={order.qr} alt="PayNow" />}
          <h3>{tx("Scan to pay")}</h3>
          <p className="k-sub">{tx("Open your banking app, scan this PayNow QR, and confirm the amount. This screen updates on its own once your payment lands.")}</p>
          <p className="k-wait"><i className="k-spin" /> {tx("Waiting for your payment…")}</p>
          <button className="k-ghost" onClick={() => go("done")}>{tx("Pay at the counter instead")}</button>
        </div>
      </div>
    );
  } else {
    const v = order?.view;
    const paid = !!v && v.paidCents >= v.totalCents && v.totalCents > 0;
    body = (
      <div className="k-done">
        <div className="k-tick">✓</div>
        <h2>{tx("Thank you!")}</h2>
        <p className="k-sub">{paid ? tx("Your order is being prepared. Listen out for your number at the counter.") : tx("Your order is in. Please pay at the counter and listen for your number.")}</p>
        {v && <div className="k-number"><small>{tx("Collection number")}</small><b>{v.queueNumber}</b></div>}
        {v && (
          <ul className="k-receipt">
            {v.items.map((i, n) => <li key={n}><span>{i.name} × {i.qty}</span><span>{formatMoney(i.unitCents * i.qty)}</span></li>)}
            <li className="k-receipt-total"><span>{paid ? tx("Total paid") : tx("Total to pay")}</span><span>{formatMoney(v.totalCents)}</span></li>
          </ul>
        )}
        <p className="k-sub">{tx("This screen clears in {n}s", { n: Math.max(0, doneLeft) })}</p>
        <button className="k-cta-sm" onClick={wipe}>{t("done", "Done")}</button>
        <div className={`k-corner ${scrolling ? "fade" : ""}`}>{langOnly}</div>
      </div>
    );
  }

  return (
    <div className="kiosk shop" style={theme}>
      {body}
      {picking && (
        <OptionSheet notes cta={tx("Add to order")} name={picking.name} description={picking.description} photoUrl={photo(picking)} baseCents={picking.priceCents} groups={picking.options ?? []} onClose={() => setPicking(null)} onAdd={(sel, note) => { addLine(picking, sel, 1, note); setPicking(null); }} />
      )}
      {editing && byId.get(editing.productId) && (() => {
        const em = byId.get(editing.productId)!;
        return <OptionSheet notes cta={tx("Save changes")} name={em.name} description={em.description} photoUrl={photo(em)} baseCents={em.priceCents} groups={em.options ?? []} initial={editing.selection} initialNote={editing.note ?? ""} onClose={() => setEditing(null)} onAdd={(sel, note) => { setBag((cur) => cur.filter((x) => x.key !== editing.key)); addLine(em, sel, editing.qty, note); setEditing(null); }} />;
      })()}
      {soon && <div className="k-toast" role="status">{tx("Member sign-in is coming soon. You can still order as a guest.")}</div>}
      <ResetDialog open={resetAsk || devDialog === "reset"} onNo={() => setResetAsk(false)} onYes={wipe} />
      <StillThere open={warning || devDialog === "idle"} left={devDialog === "idle" ? 6 : warnLeft} />
      <LanguageDialog open={langOpen} onClose={() => setLangOpen(false)} />
      <SettingsDialog open={settingsOpen} idleMin={idleMin} chips={chips} signin={signinBlock} onSignin={(on) => { setSigninBlock(on); try { localStorage.setItem(LS_SIGNIN, on ? "1" : "0"); } catch { /* not kept */ } }} onIdle={(n) => { setIdleMin(n); try { localStorage.setItem(LS_IDLE, String(n)); } catch { /* not kept */ } }} onChip={(id, on) => { const next = { ...chips, [id]: on }; setChips(next); try { localStorage.setItem(LS_CHIPS, JSON.stringify(next)); } catch { /* not kept */ } }} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function KioskMenu({ info, menu, channels, channelId, setChannelId, count, total, qtyOf, addQuick, lessOf, open, onCheckout, floating, logo, showSignin, onSignin, scrolling }: {
  info: Info; menu: MenuEntry[]; channels: Info["channels"]; channelId: string; setChannelId: (id: string) => void; count: number; total: number;
  qtyOf: (m: MenuEntry) => number; addQuick: (m: MenuEntry, d: number) => void; lessOf: (m: MenuEntry) => void; open: (m: MenuEntry) => void; onCheckout: () => void; floating: React.ReactNode; logo: React.ReactNode; showSignin: boolean; onSignin: () => void; scrolling: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const [cat, setCat] = useState("All");
  const menuRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const pairRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [popping, setPopping] = useState(false);
  const lastCount = useRef(count);
  // The Checkout button pops each time an item is added.
  useEffect(() => {
    const grew = count > lastCount.current;
    lastCount.current = count;
    if (!grew) return;
    setPopping(true);
    const id = window.setTimeout(() => setPopping(false), 560);
    return () => window.clearTimeout(id);
  }, [count]);
  const [headH, setHeadH] = useState(150);
  const [pairH, setPairH] = useState(56);
  const q = (search ?? "").trim().toLowerCase();
  const shown = q ? menu.filter((m) => `${m.name} ${m.description ?? ""} ${m.category}`.toLowerCase().includes(q)) : menu;
  const cats = useMemo(() => [...new Set(menu.map((m) => m.category))], [menu]);
  const groups = useMemo(() => (q ? [{ c: tx("Search results"), items: shown }] : cats.map((c) => ({ c, items: shown.filter((m) => m.category === c) })).filter((g) => g.items.length)), [cats, shown, q]);
  const counts = useMemo(() => new Map(cats.map((c) => [c, menu.filter((m) => m.category === c).length])), [cats, menu]);

  // The header's and the floating pair's heights, so the first row is never trapped under them.
  useLayoutEffect(() => {
    const watch = (el: HTMLElement | null, set: (n: number) => void) => {
      if (!el) return () => undefined;
      const f = () => set(el.getBoundingClientRect().height);
      f();
      const ro = new ResizeObserver(f);
      ro.observe(el);
      return () => ro.disconnect();
    };
    const a = watch(headRef.current, setHeadH);
    const b = watch(pairRef.current, setPairH);
    return () => { a(); b(); };
  }, []);

  // At least nine cards (3 across, 3 rows) must be fully visible. The photos keep their size: only the text under them tightens, in up to three steps.
  const fit = useCallback(() => {
    const root = menuRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap || wrap.clientHeight < 80) return;
    const cards = wrap.querySelectorAll<HTMLElement>(".k-card");
    root.removeAttribute("data-fit");
    if (cards.length < 9) return;
    const ninth = cards[8]!;
    void wrap.offsetHeight;
    const excess = () => ninth.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom;
    if (excess() <= 2) return;
    for (let lvl = 1; lvl <= 3; lvl++) {
      root.setAttribute("data-fit", String(lvl));
      void wrap.offsetHeight;
      if (excess() <= 2) return;
    }
  }, []);
  useLayoutEffect(() => { fit(); }, [fit, groups, headH, pairH, count === 0]);
  useEffect(() => {
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); };
    window.addEventListener("resize", on);
    void document.fonts?.ready?.then(on);
    return () => { window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, [fit]);

  // Scroll-spy: the chip of the category at the top is lit, including the last ones at the bottom of the list. The floating pair fades while scrolling.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer = 0;
    const onScroll = () => {
      if (q) return;
      const atEnd = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 4;
      const secs = [...wrap.querySelectorAll<HTMLElement>("[data-cat]")];
      const line = wrap.getBoundingClientRect().top + pairH + 14;
      let cur = secs[0]?.dataset.cat ?? "All";
      for (const sec of secs) if (sec.getBoundingClientRect().top <= line) cur = sec.dataset.cat!;
      if (atEnd && secs.length) cur = secs[secs.length - 1]!.dataset.cat!;
      setCat(wrap.scrollTop < 8 ? "All" : cur);
    };
    wrap.addEventListener("scroll", onScroll, { passive: true });
    return () => { wrap.removeEventListener("scroll", onScroll); window.clearTimeout(timer); };
  }, [pairH, groups.length, q]);

  const jump = (c: string) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (c === "All") { wrap.scrollTo({ top: 0, behavior: "smooth" }); return; }
    const el = wrap.querySelector<HTMLElement>(`[data-cat="${CSS.escape(c)}"]`);
    if (el) wrap.scrollTo({ top: el.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - pairH - 10, behavior: "smooth" });
  };

  return (
    <div className="k-menu" ref={menuRef}>
      <div className="k-head" ref={headRef}>
        <div className="k-top">
          <div className="k-brandlock">{logo}<div className="k-mt">{info.name}<small>{info.outletName}</small></div></div>
          <div className="k-seg">{channels.map((c) => <button key={c.id} className={c.id === channelId ? "on" : ""} onClick={() => setChannelId(c.id)}>{c.kind === "dine_in" ? t("dineIn", "Dine in") : t("takeAway", "Take away")}</button>)}</div>
          {showSignin && <button className="k-session" onClick={onSignin}>{tx("Guest")} · {tx("Sign in")}</button>}
          <button className={`k-checkout ${count ? "live" : "none"} ${popping ? "pop" : ""}`} onClick={onCheckout} aria-label={tx("Checkout")}>
            <Icon name="bag" size={30} />
            <span className="k-checkout-label">{tx("Checkout")}</span>
            {count > 0 && <span className="k-checkout-total"><RollMoney cents={total} /></span>}
            {count > 0 && <span className="k-bagbadge">{count}</span>}
          </button>
        </div>
        <div className="k-chiprow">
          <div className="k-chipbar">
            <button className={`k-chip ${cat === "All" && !q ? "on" : ""}`} onClick={() => { setSearch(null); jump("All"); }}>{t("all", "All")} <i>{menu.length}</i></button>
            {cats.map((c) => <button key={c} className={`k-chip ${cat === c && !q ? "on" : ""}`} onClick={() => { if (q) setSearch(null); window.setTimeout(() => jump(c), q ? 60 : 0); }}>{c} <i>{counts.get(c)}</i></button>)}
          </div>
          <button className={`k-search ${search !== null ? "on" : ""}`} aria-label={tx("Search the menu")} onClick={() => setSearch((x) => (x === null ? "" : null))}><Icon name="search" size={24} /></button>
        </div>
        {search !== null && <div className="k-searchrow"><input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx("Search the menu")} /></div>}
      </div>
      <div className={`k-floatwrap ${scrolling ? "fade" : ""}`} ref={pairRef} style={{ top: headH + 10 }}>{floating}</div>
      <div className="k-gridwrap" ref={wrapRef}>
        <div style={{ height: pairH + 6 }} aria-hidden />
        {groups.length === 0 && <p className="k-empty">{tx("Nothing matches that search.")}</p>}
        {groups.map((g) => (
          <section key={g.c} className="k-sec" data-cat={q ? undefined : g.c}>
            <h3>{g.c} <small>{g.items.length} {g.items.length === 1 ? tx("item") : tx("items")}</small></h3>
            <div className="k-grid">
              {g.items.map((m) => {
                const n = qtyOf(m);
                const [lo, hi] = priceRange(m.priceCents, m.options);
                const deposit = (m as { bcrs?: boolean }).bcrs ?? /bcrs/i.test(m.name);
                return (
                  <article key={m.id} className={`k-card ${n ? "in" : ""}`} onClick={() => open(m)}>
                    <div className="k-photo">
                      {photo(m) ? <img src={photo(m)!} alt="" loading="lazy" /> : <span className="k-nophoto" />}
                      {n > 0 && <span className="k-badge">×{n} {tx("in your order")}</span>}
                    </div>
                    <div className="k-body">
                      <div className="k-nm">{m.name}</div>
                      <div className="k-pr">
                        {hi > lo ? <span className="k-from">{tx("From")}</span> : null}
                        <span className="k-p">{formatMoney(lo)}</span>
                        {deposit && <span className="k-bcrs">+10c {tx("deposit")}</span>}
                        {n > 0 ? <span className="k-cstep" onClick={(e) => e.stopPropagation()}><button aria-label="−" onClick={() => lessOf(m)}>−</button><span>{n}</span><button className="plus" aria-label="+" onClick={() => addQuick(m, 1)}>+</button></span> : <button className="k-add" aria-label={tx("Add")} onClick={(e) => { e.stopPropagation(); addQuick(m, 1); }}>+</button>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ResetDialog({ open, onNo, onYes }: { open: boolean; onNo: () => void; onYes: () => void }) {
  const box = useDialog(open, onNo);
  if (!open) return null;
  return (
    <div className="k-scrim reset" role="presentation">
      <div className="k-idle reset-card" ref={box} role="alertdialog" aria-modal="true" aria-labelledby="k-reset-h">
        <h2 id="k-reset-h">{tx("Start over?")}</h2>
        <p>{tx("Your order will be cleared.")}</p>
        <div className="k-reset-actions"><button className="k-ghost-sm" onClick={onNo}>{tx("Cancel")}</button><button className="k-danger" onClick={onYes}>{tx("Reset")}</button></div>
      </div>
    </div>
  );
}

function StillThere({ open, left }: { open: boolean; left: number }) {
  const box = useDialog(open, () => undefined);
  if (!open) return null;
  return (
    <div className="k-scrim idle" role="presentation">
      <div className="k-idle" ref={box} role="alertdialog" aria-modal="true" aria-labelledby="k-still-h">
        <h2 id="k-still-h">{tx("Still there?")}</h2>
        <p>{tx("Your order will be cleared and this screen will reset in")}</p>
        <div className="k-cd">{left}</div>
        <p>{tx("seconds — anything on screen, including sign-in details, is removed for your privacy.")}</p>
        <button className="k-stay">{tx("I’m still here")}</button>
      </div>
    </div>
  );
}

function LanguageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const box = useDialog(open, onClose);
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  if (!open) return null;
  // Every language on one screen, no scrolling: the tiles share the height, so they shrink as the list grows.
  const cols = w >= 1100 ? 6 : w >= 700 ? 5 : 3;
  const rows = Math.ceil(LANGS.length / cols);
  const rowSize = LANGS.length >= 24 ? "minmax(0, 1fr)" : "minmax(0, 150px)";
  return (
    <div className="k-lang-screen" ref={box} role="dialog" aria-modal="true" aria-labelledby="k-lang-h">
      <header><h3 id="k-lang-h">{tx("Choose your language")}</h3><button aria-label={t("close", "Close")} onClick={onClose}>×</button></header>
      <div className="k-lang-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, ${rowSize})` }}>
        {[...LANGS].sort((a, b) => KIOSK_LANG_ORDER.indexOf(a.code) - KIOSK_LANG_ORDER.indexOf(b.code)).map((l) => (
          <button key={l.code} className={l.code === lang() ? "on" : ""} onClick={() => { setLangMode(l.code); onClose(); }}>
            {l.code === lang() && <em aria-hidden>✓</em>}
            <span aria-hidden>{FLAG[l.code]}</span>
            <b>{l.code === "zh" ? "简体中文" : l.native}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingsDialog({ open, idleMin, chips, signin, onSignin, onIdle, onChip, onClose }: { open: boolean; idleMin: number; chips: Record<string, boolean>; signin: boolean; onSignin: (on: boolean) => void; onIdle: (n: number) => void; onChip: (id: string, on: boolean) => void; onClose: () => void }) {
  const box = useDialog(open, onClose);
  if (!open) return null;
  return (
    <div className="k-scrim" role="presentation">
      <div className="k-dialog wide" ref={box} role="dialog" aria-modal="true" aria-labelledby="k-set-h">
        <h3 id="k-set-h">{tx("Operator settings")}</h3>
        <p>{tx("Idle / session timeout — how long the kiosk waits with no touches before showing “Still there?” and clearing the session for privacy.")}</p>
        <div className="k-choices">{IDLE_CHOICES.map((n) => <button key={n} className={n === idleMin ? "on" : ""} onClick={() => onIdle(n)}>{n} min</button>)}</div>
        <h4>{tx("Start screen rewards")}</h4>
        {CHIPS.map((c) => (
          <label key={c.id} className="k-toggle"><span>{tx(c.text)}</span><input type="checkbox" checked={!!chips[c.id]} onChange={(e) => onChip(c.id, e.target.checked)} /><i /></label>
        ))}
        <h4>{tx("Member sign-in buttons")}</h4>
        <label className="k-toggle"><span>{tx("Show the sign-in block (preview: not connected yet)")}</span><input type="checkbox" checked={signin} onChange={(e) => onSignin(e.target.checked)} /><i /></label>
        <button className="k-cta-sm" onClick={onClose}>{t("done", "Done")}</button>
      </div>
    </div>
  );
}
