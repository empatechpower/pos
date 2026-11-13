import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultSelection, formatMoney, menuFor, optionLines, priceRange, quoteOrder, readableOn, resolveOptions, type BusinessConfig, type Catalog, type ChosenOptionInput, type MenuEntry, type ShopStatus } from "@pos/core";
import { OptionSheet } from "./OptionSheet";
import "../shopProto.css";
import { LANGS, detectedLang, greeting, lang, langMode, setLangMode, shortLabel, t, tx, useLang } from "../shopI18n";

interface Info {
  name: string;
  outletName: string;
  paymentTiming: string;
  /** The shop's tables ("Table 1", ...). When present, ordering is dine-in only and the table must be one of these. */
  tables?: string[];
  /** Members only: phone sign-in is the only way in, and an order is paid from member credit. */
  membersOnly?: boolean;
  /** Opening hours and a phone number, when the shop has set them. */
  contact?: { phone?: string; hours?: string };
  channels: Array<{ id: string; name: string; kind: string }>;
  brand: { primary: string; accent: string; ink: string; logoUrl: string | null; heroUrl: string | null; tagline: string | null; promoTitle: string | null; promoBody: string | null };
  /** What this shop can do beyond email sign-in and paying at the counter. */
  auth: { google: boolean; microsoft: boolean; phone: { number: string; simulated?: boolean; manual?: boolean; open?: boolean } | null };
  payments: { online: boolean; methods: string[] };
}
interface OrderView {
  orderId: string;
  queueNumber: string;
  status: ShopStatus;
  channelName?: string;
  spot?: string;
  items: Array<{ name: string; qty: number; unitCents: number; options: string[] }>;
  totalCents: number;
  paidCents: number;
  canCancel?: boolean;
  canPayOnline?: boolean;
}
interface PastOrder {
  orderId: string;
  at: string;
  queueNumber: string;
  status: ShopStatus;
  channelName?: string;
  spot?: string;
  itemCount: number;
  totalCents: number;
}
interface BagLine {
  key: string;
  productId: string;
  qty: number;
  selection: ChosenOptionInput[];
}

const LS_LAST = "shop.lastOrder";
const LS_ENTERED = "shop.entered";
const LS_MEMBER = "shop.member";
interface CouponView {
  id: string;
  title: string;
  amountCents: number;
  minSpendCents: number;
}
interface StampView {
  count: number;
  completed: number;
  target: number;
  rewardTitle: string;
  minPaidCents: number;
}
interface MemberView {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  pointsBalance: number;
  prefs?: { orderUpdates: boolean; promos: boolean };
  /** Prepaid credit the member can pay with, in cents. */
  creditCents?: number;
}
const params = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
const orderIdFromHash = () => /^#\/shop\/order\/([\w-]+)/.exec(location.hash)?.[1] ?? null;

/** A pale version of a colour, for card backgrounds and chips. */
const tint = (hex: string, amount = 0.88) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return "#" + c.map((v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, "0")).join("");
};

const STATUS_TEXT: Record<ShopStatus, { title: string; body: (o: OrderView) => string }> = {
  received: { get title() { return tx("Order sent"); }, body: () => tx("Waiting for the shop to accept your order. This page updates by itself.") },
  awaiting_payment: { get title() { return tx("Accepted: please pay"); }, body: (o) => tx("Pay {amt} at the counter and quote your number. We start your order once it is paid.", { amt: formatMoney(o.totalCents - o.paidCents) }) },
  queued: { get title() { return tx("In the queue"); }, body: () => tx("Your order is paid and waiting to be made.") },
  preparing: { get title() { return tx("Being prepared"); }, body: () => tx("Your order is being made right now.") },
  ready: { get title() { return tx("Ready!"); }, body: () => tx("Please collect your order at the counter.") },
  completed: { get title() { return tx("Collected"); }, body: () => tx("Enjoy! Thank you for ordering.") },
  cancelled: { get title() { return tx("Order cancelled"); }, body: () => tx("The shop could not take this order. Please ask at the counter, or order again.") },
};
const STEPS: ShopStatus[] = ["received", "awaiting_payment", "queued", "preparing", "ready"];

const ICONS: Record<string, string> = {
  pin: '<path d="M12 21s-6.5-5.4-6.5-10.2A6.5 6.5 0 0 1 12 4a6.5 6.5 0 0 1 6.5 6.8C18.5 15.6 12 21 12 21Z"/><circle cx="12" cy="10.6" r="2.3"/>',
  bag: '<path d="M5.5 8h13l-1 12.5h-11L5.5 8Z"/><path d="M9 10.5V6.8a3 3 0 0 1 6 0v3.7"/>',
  table: '<path d="M3 9.5h18"/><path d="M5.5 9.5V20M18.5 9.5V20"/><path d="M5.5 15h13"/><circle cx="12" cy="6" r="1.6"/>',
  cutlery: '<path d="M7 3.5v6.2M4.8 3.5v3.4a2.2 2.2 0 0 0 4.4 0V3.5M7 9.7v10.8M17.5 3.5c-1.7 1.2-2.6 3.4-2.6 5.7 0 1.9 1 3 2.6 3v8.3"/>',
  user: '<circle cx="12" cy="8.2" r="3.7"/><path d="M5 20.2c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5"/>',
  gift: '<rect x="4" y="10" width="16" height="4"/><path d="M6 14v6.5h12V14M12 10v10.5M12 10a2.8 2.8 0 1 1 2.8-2.8c0 1.8-2.8 2.8-2.8 2.8Zm0 0a2.8 2.8 0 1 0-2.8-2.8C9.2 8.9 12 10 12 10Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.6-4.6"/>',
  paw: '<circle cx="7.2" cy="7.6" r="1.7"/><circle cx="12" cy="5.4" r="1.8"/><circle cx="16.8" cy="7.6" r="1.7"/><circle cx="5.4" cy="12.4" r="1.6"/><circle cx="18.6" cy="12.4" r="1.6"/><path d="M12 11.2c2.9 0 5.2 2.3 5.2 4.9 0 1.8-1.3 2.9-3 2.9-1 0-1.5-.3-2.2-.3s-1.2.3-2.2.3c-1.7 0-3-1.1-3-2.9 0-2.6 2.3-4.9 5.2-4.9Z"/>',
  ticket: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-2a2.5 2.5 0 0 0 0-5v-2Z"/><path d="M13.5 7v1.8M13.5 11.2v1.8M13.5 15.2V17"/>',
  arrowR: '<path d="M4.5 12h14M13.5 6l6 6-6 6"/>',
  logout: '<path d="M13.5 4.5H7A1.5 1.5 0 0 0 5.5 6v12A1.5 1.5 0 0 0 7 19.5h6.5"/><path d="M10.5 12h10M17 8l3.5 4L17 16"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5Z"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
  chevD: '<path d="m6 9.5 6 6 6-6"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4.2 7.2 7.8 5.8 7.8-5.8"/>',
  phone: '<path d="M5.2 4h3.6L10.3 8 8.2 9.6a12.5 12.5 0 0 0 6.2 6.2L16 13.7l4 1.5v3.6a1.9 1.9 0 0 1-2 1.9C10.2 20 4 13.8 3.3 6A1.9 1.9 0 0 1 5.2 4Z"/>',
  check: '<path d="m5 12.8 4.5 4.5L19 7.5"/>',
  stack: '<ellipse cx="12" cy="5.8" rx="7" ry="2.8"/><path d="M5 5.8v6.2c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V5.8"/><path d="M5 12v6.2c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V12"/>',
  card: '<rect x="3.5" y="6" width="17" height="12.5" rx="2"/><path d="M3.5 10h17"/>',
  help: '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4A2.5 2.5 0 1 1 12 12.4V14"/><circle cx="12" cy="17" r=".4" fill="currentColor"/>',
  bell: '<path d="M6 9.5a6 6 0 1 1 12 0c0 4 1.2 5.4 2 6.5H4c.8-1.1 2-2.5 2-6.5"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5V6M6.5 6.5l.8 13a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-13"/><path d="M10 10.5v6M14 10.5v6"/>',
  can: '<rect x="7" y="3.5" width="10" height="17" rx="1.5"/><path d="M7 7.2h10M7 16.8h10"/>',
  basket: '<path d="M4.8 9.8h14.4l-1.2 8.4a2 2 0 0 1-2 1.8H8a2 2 0 0 1-2-1.8L4.8 9.8Z"/><path d="M8.3 9.8 12 4.2l3.7 5.6"/><path d="M9.4 13.2v3.4M12 13.2v3.4M14.6 13.2v3.4"/>',
};
/** A bag row that slides left to show a bin button, like the prototype. A slight slide is enough to open it. */
function SwipeRow({ children, onRemove, label }: { children: ReactNode; onRemove: () => void; label: string }) {
  const OPEN = 84;
  const [open, setOpen] = useState(false);
  const [x, setX] = useState<number | null>(null); // live offset while a finger or mouse is dragging
  const g = useRef<{ id: number; x0: number; y0: number; wasOpen: boolean; mode: "?" | "h" | "v" } | null>(null);
  const moved = useRef(false);
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".swipe-bin")) return;
    g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, wasOpen: open, mode: "?" };
    moved.current = false;
  };
  const move = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (s.mode === "?") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      s.mode = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (s.mode === "h") { try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* the drag still works without capture */ } }
    }
    if (s.mode !== "h") return;
    moved.current = true;
    setX(Math.max(-OPEN, Math.min(0, (s.wasOpen ? -OPEN : 0) + dx)));
  };
  const up = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    if (s.mode === "h") {
      const dx = e.clientX - s.x0;
      setOpen(s.wasOpen ? !(dx > 6) : dx < -6); // almost no distance needed: a slight slide is the intent
      setX(null);
    }
  };
  return (
    <div
      className={`swipe-shell ${open ? "is-swiped" : ""} ${x !== null ? "is-dragging has-x" : ""}`}
      style={x !== null ? ({ "--sx": `${x}px` } as React.CSSProperties) : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { g.current = null; setX(null); }}
      onClickCapture={(e) => { if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false; } }}
    >
      <button className="swipe-bin" tabIndex={open ? 0 : -1} aria-label={`${t("removeW", "Remove")} ${label}`} onClick={onRemove}><Icon name="trash" size={22} /><span>{t("bin", "Bin")}</span></button>
      {children}
      <span className="swipe-hint" aria-hidden="true"><Icon name="chevL" size={12} /></span>
    </div>
  );
}
function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name]! }} />;
}
const channelIcon = (kind: string): keyof typeof ICONS => (kind === "dine_in" ? "cutlery" : "bag");

const photo = (p: { id: string; imageVersion?: number }) => (p.imageVersion ? `/api/products/${p.id}/image?v=${p.imageVersion}` : null);
// The card shows the plain lower price; Variants are chosen on the sheet (no ranges on cards).
const cardPrice = (m: MenuEntry) => formatMoney(priceRange(m.priceCents, m.options)[0]);

/** The customer's own ordering page: no sign-in, no device set-up. Public by design. */
const PURCHASE_KEY = "pos.purchase";
/** One key per checkout attempt. Tapping Pay again after a timeout reuses it, so the shop answers with the first result and never debits twice. */
function purchaseKey(sig: string): string {
  try {
    const cur = JSON.parse(localStorage.getItem(PURCHASE_KEY) ?? "null") as { sig: string; key: string } | null;
    if (cur && cur.sig === sig) return cur.key;
  } catch {
    /* start a new one */
  }
  const key = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/[^\w-]/g, "");
  try {
    localStorage.setItem(PURCHASE_KEY, JSON.stringify({ sig, key }));
  } catch {
    /* kept in memory only for this attempt */
  }
  return key;
}
const clearPurchaseKey = () => {
  try {
    localStorage.removeItem(PURCHASE_KEY);
  } catch {
    /* nothing to clear */
  }
};

const BAG_KEY = "pos.shopBag";
/** The unsent bag and table survive a reload or an interrupted visit for a few hours, then are forgotten. */
function loadBag(): { bag: BagLine[]; spot: string } | null {
  try {
    const j = JSON.parse(localStorage.getItem(BAG_KEY) ?? "null") as { at: number; bag: BagLine[]; spot: string } | null;
    return j && Date.now() - j.at < 4 * 3600_000 && Array.isArray(j.bag) ? { bag: j.bag, spot: j.spot ?? "" } : null;
  } catch {
    return null;
  }
}
function saveBag(bag: BagLine[], spot: string) {
  try {
    if (!bag.length && !spot) localStorage.removeItem(BAG_KEY);
    else localStorage.setItem(BAG_KEY, JSON.stringify({ at: Date.now(), bag, spot }));
  } catch {
    /* private window or storage full: the bag simply is not kept */
  }
}

export function Shop() {
  useLang(); // re-render everything below when the language changes
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BusinessConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [orderId, setOrderId] = useState(orderIdFromHash());
  // Coming back from Google or Microsoft: trade the one-time ticket for a session before showing anything.
  const [signing, setSigning] = useState(() => !!params().get("ticket"));
  const [loginError, setLoginError] = useState<string | null>(null);
  useEffect(() => {
    const p = params();
    const ticket = p.get("ticket");
    const err = p.get("login_error");
    if (err) setLoginError(err === "cancelled" ? "Sign-in was cancelled." : "That sign-in didn't work. Please try again, or use another way.");
    if (!ticket && !err) return;
    history.replaceState(null, "", "#/shop");
    if (!ticket) return;
    fetch("/api/shop/auth/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { token?: string };
        if (r.ok && j.token) {
          localStorage.setItem(LS_MEMBER, j.token);
          sessionStorage.setItem(LS_ENTERED, "1");
        } else setLoginError("That sign-in link has expired. Please try again.");
      })
      .catch(() => setLoginError(tx("No connection. Please try again.")))
      .finally(() => setSigning(false));
  }, []);

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

  if (failed) return <div className="shop"><div className="shop-msg"><h2>{tx("Ordering isn't available right now")}</h2><p>{tx("Please order at the counter, or try again in a moment.")}</p></div></div>;
  if (!info || !catalog || !config || signing) return <div className="shop"><div className="shop-msg"><p>{signing ? "Signing you in…" : tx("Loading…")}</p></div></div>;

  const b = info.brand;
  const theme = {
    "--brand": b.primary,
    "--brand-ink": b.ink,
    "--accent": b.accent,
    "--accent-ink": readableOn(b.accent),
    "--soft": tint(b.accent),
    "--brand-soft": tint(b.accent),
  } as React.CSSProperties;
  return (
    <div className="shop" style={theme}>
      {orderId ? (
        <>
          <Status orderId={orderId} info={info} />
        </>
      ) : (
        <Menu info={info} catalog={catalog} config={config} loginError={loginError} />
      )}
    </div>
  );
}

type Screen = "login" | "order" | "rewards" | "account" | "bag" | "summary" | "checkout" | "payment";

function Menu({ info, catalog, config, loginError }: { info: Info; catalog: Catalog; config: BusinessConfig; loginError: string | null }) {
  const q = params();
  const channels = info.channels;
  const wanted = q.get("channel");
  const table = q.get("table") ?? "";
  const startTab = q.get("tab");
  const entered = () => !!localStorage.getItem(LS_MEMBER) || sessionStorage.getItem(LS_ENTERED) === "1";
  const [screen, setScreenRaw] = useState<Screen>(startTab === "account" ? "account" : entered() ? "order" : "login");
  const [channelId, setChannelId] = useState(channels.find((c) => c.id === wanted)?.id ?? (table ? channels.find((c) => c.kind === "dine_in")?.id : undefined) ?? channels[0]?.id ?? "");
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState<string | null>(null);
  const [searchCleared, setSearchCleared] = useState(false); // the × was pressed: the next category tap closes the empty bar
  const saved = useRef(loadBag()).current;
  const [bag, setBag] = useState<BagLine[]>(saved?.bag ?? []);
  const [picking, setPicking] = useState<MenuEntry | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const tableList = info.tables ?? [];
  // A table's own link (…?table=12) sets the starting table.
  const linkTable = tableList.find((x) => x === `Table ${Number(table.replace(/^table\s*/i, ""))}`);
  // The link sets the starting table; the customer can still pick another (they may have moved seats). The server accepts only real tables.
  const tableLocked = false;
  /** Moving to a different table asks first. The order is the customer's own either way: it never joins another person's order at that table. */
  const changeTable = (to: string): boolean => {
    if (!to || to === spot) return true;
    if (spot && !window.confirm(tx("Move to {t}? Your order will be sent to {t}.", { t: to }))) return false;
    setSpot(to);
    return true;
  };
  // Changing only the part after # does not reload the page, so keep the table in step with the link.
  const [, bumpLink] = useState(0);
  useEffect(() => {
    const f = () => bumpLink((n) => n + 1);
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const [spot, setSpot] = useState(linkTable ?? (tableList.length ? (tableList.includes(saved?.spot ?? "") ? saved!.spot : "") : table || saved?.spot || ""));
  const [tableEdit, setTableEdit] = useState(false);
  useEffect(() => { if (linkTable) setSpot(linkTable); }, [linkTable]);
  useEffect(() => saveBag(bag, spot), [bag, spot]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [agreed, setAgreed] = useState<number | null>(null);
  const [member, setMember] = useState<MemberView | null>(null);
  const [usePoints, setUsePoints] = useState(false);
  const [pointsPts, setPointsPts] = useState<number | null>(null); // a chosen amount; null = use all that can be used
  const [pEdit, setPEdit] = useState(false);
  const [pEditAmt, setPEditAmt] = useState(false);
  const [coupons, setCoupons] = useState<CouponView[]>([]);
  const [couponId, setCouponId] = useState<string | null>(null);
  const [stamps, setStamps] = useState<StampView | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [wallet, setWallet] = useState(false);
  const [guestOk, setGuestOk] = useState(false);
  const [guestForm, setGuestForm] = useState(false);
  const [acctPanel, setAcctPanel] = useState<null | "profile" | "help" | "notif" | "prefs">(null);
  const [langOpen, setLangOpen] = useState(false);
  const [payMethod, setPayMethod] = useState<"counter" | "card" | "paynow" | "credit">(info.membersOnly ? "credit" : "counter");
  const [history, setHistory] = useState<PastOrder[] | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const b = info.brand;
  // The greeting, outlet and Dine in / Take away toggle stay put; the category rail sticks just below them.
  const headRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const set = () => document.querySelector<HTMLElement>(".shop")?.style.setProperty("--head-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [screen, tableEdit]);

  const setScreen = (s: Screen) => {
    setScreenRaw(s);
    setNote(null);
    setAcctPanel(null);
    window.scrollTo(0, 0);
  };

  const loadMember = async () => {
    const t = localStorage.getItem(LS_MEMBER);
    if (!t) return setMember(null);
    const r = await fetch("/api/shop/me", { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    if (r?.ok) {
      const j = (await r.json()) as { member: MemberView; creditCents?: number; coupons?: CouponView[]; stamps?: StampView | null };
      setMember({ ...j.member, creditCents: j.creditCents ?? 0 });
      setCoupons(j.coupons ?? []);
      setStamps(j.stamps ?? null);
      setName((n) => n || j.member.name || "");
      setPhone((p) => p || j.member.phone || "");
    } else if (r && r.status === 401) {
      localStorage.removeItem(LS_MEMBER);
      setMember(null);
    }
  };
  useEffect(() => { void loadMember(); }, []);
  useEffect(() => {
    if (screen !== "account" || !member) return;
    const t = localStorage.getItem(LS_MEMBER);
    void fetch("/api/shop/me/orders", { headers: { authorization: `Bearer ${t}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ orders: PastOrder[] }>) : null))
      .then((j) => setHistory(j?.orders ?? []))
      .catch(() => setHistory([]));
  }, [screen, member?.id]);
  async function saveProfile() {
    const r = await fetch("/api/shop/me", { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem(LS_MEMBER) ?? ""}` }, body: JSON.stringify({ name: editName, phone: editPhone }) }).catch(() => null);
    if (r?.ok) {
      setProfileMsg(tx("Saved."));
      if (editPhone) setPhone(editPhone);
      await loadMember();
    } else setProfileMsg(tx("Couldn't save. Please try again."));
  }
  /** Turn a notification choice on or off. It is saved on the account, so it follows the member to other devices. */
  async function savePref(key: "orderUpdates" | "promos", on: boolean) {
    if (!member) return;
    setMember({ ...member, prefs: { orderUpdates: member.prefs?.orderUpdates ?? true, promos: member.prefs?.promos ?? false, [key]: on } });
    const r = await fetch("/api/shop/me", { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem(LS_MEMBER) ?? ""}` }, body: JSON.stringify({ [key]: on }) }).catch(() => null);
    if (!r?.ok) await loadMember(); // could not save: show what the account really has
  }
  const signOut = async () => {
    const t = localStorage.getItem(LS_MEMBER);
    if (t) await fetch("/api/shop/auth/logout", { method: "POST", headers: { authorization: `Bearer ${t}` } }).catch(() => undefined);
    localStorage.removeItem(LS_MEMBER);
    sessionStorage.removeItem(LS_ENTERED);
    setMember(null);
    setCoupons([]);
    setStamps(null);
    setCouponId(null);
    setUsePoints(false);
    setGuestOk(false);
    setScreen("login");
  };

  const ctx = { outletId: info.outletName, channelId };
  const menu = useMemo(() => menuFor(catalog, ctx), [catalog, info.outletName, channelId]);
  const byId = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const channel = channels.find((c) => c.id === channelId);
  const categories = useMemo(() => ["All", ...new Set(menu.map((m) => m.category))], [menu]);

  // Switching channel can remove items it does not sell, or choices that no longer exist.
  useEffect(() => {
    setBag((cur) => {
      const kept = cur.filter((l) => {
        const m = byId.get(l.productId);
        return m && !m.soldOut && resolveOptions(m.options, l.selection).ok;
      });
      if (kept.length < cur.length) setNote(`Some items were removed: they aren't available for ${channel?.name}.`);
      return kept.length === cur.length ? cur : kept;
    });
  }, [byId]);

  useEffect(() => { if (screen === "payment" && member && (member.creditCents ?? 0) >= shownTotal && payMethod === "counter") setPayMethod("credit"); }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!usePoints) { setPointsPts(null); setPEdit(false); setPEditAmt(false); } }, [usePoints]);
  const items = bag.map((l) => ({ productId: l.productId, qty: l.qty, options: l.selection }));
  const count = bag.reduce((n, l) => n + l.qty, 0);
  // Rewards (points, coupons, stamps) can be switched off for a shop. Then none of their screens or wording shows.
  const rewardsOn = config.rewards.pointsEnabled || config.rewards.welcomeVoucherCents > 0 || config.rewards.stampCard.enabled;
  const credit = member?.creditCents ?? 0;
  const canUsePoints = !!member && config.rewards.pointsEnabled && member.pointsBalance >= config.pricing.minPointsRedeem;
  const chosen = coupons.find((c) => c.id === couponId) ?? null;
  const preview = items.length ? quoteOrder(catalog, config, ctx, items, null, null) : null;
  const itemsSubtotal = preview?.ok ? preview.priced.subtotal : 0;
  // A coupon only counts once the items alone reach its minimum spend.
  const chosenOk = !!chosen && itemsSubtotal >= chosen.minSpendCents;
  // The most points this order can take, then what the customer chose (all of it unless they used Edit).
  const couponAsk = chosen && chosenOk ? { amountCents: chosen.amountCents, minSpendCents: chosen.minSpendCents } : null;
  const maxQuote = items.length && usePoints && canUsePoints ? quoteOrder(catalog, config, ctx, items, { balance: member!.pointsBalance, requested: null }, couponAsk) : null;
  const maxPts = maxQuote?.ok ? maxQuote.priced.pointsUsed : 0;
  const minPts = Math.min(config.pricing.minPointsRedeem, maxPts);
  const reqPts = pointsPts !== null && pointsPts < maxPts ? Math.max(minPts, pointsPts) : null;
  const pointsAsk = usePoints && canUsePoints ? { balance: member!.pointsBalance, requested: reqPts } : null;
  const quote = items.length ? quoteOrder(catalog, config, ctx, items, pointsAsk, chosen && chosenOk ? { amountCents: chosen.amountCents, minSpendCents: chosen.minSpendCents } : null) : null;
  const total = quote?.ok ? quote.priced.total : 0;
  const shownTotal = agreed ?? total;
  const inBag = (id: string) => bag.filter((l) => l.productId === id).reduce((n, l) => n + l.qty, 0);
  const earnPts = Math.floor((itemsSubtotal / 100) * config.rewards.earnPointsPerDollar);

  const addLine = (m: MenuEntry, selection: ChosenOptionInput[], d = 1) => {
    const r = resolveOptions(m.options, selection);
    if (!r.ok) return;
    const key = `${m.id}#${r.key}`;
    setBag((cur) => {
      const have = cur.find((l) => l.key === key);
      const qty = (have?.qty ?? 0) + d;
      if (qty <= 0) return cur.filter((l) => l.key !== key);
      const next = Math.min(20, qty);
      return have ? cur.map((l) => (l.key === key ? { ...l, qty: next } : l)) : [...cur, { key, productId: m.id, qty: next, selection }];
    });
    setAgreed(null);
  };
  const bump = (l: BagLine, d: number) => {
    const m = byId.get(l.productId);
    if (m) addLine(m, l.selection, d);
  };
  const addSimple = (m: MenuEntry, d: number) => addLine(m, m.options?.length ? defaultSelection(m.options) : [], d);

  async function place() {
    if (!quote?.ok || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/shop/orders", {
        method: "POST",
        headers: { "content-type": "application/json", ...(member ? { authorization: `Bearer ${localStorage.getItem(LS_MEMBER) ?? ""}` } : {}) },
        body: JSON.stringify({ channelId, items, customerName: name, customerPhone: phone, spot, expectedTotalCents: agreed ?? total, ...(payMethod === "credit" && member ? { payWithCredit: true, idempotencyKey: purchaseKey(JSON.stringify({ channelId, items, spot, m: member.id })) } : {}), ...(pointsAsk ? { usePoints: reqPts ?? "max" } : {}), ...(chosen && chosenOk ? { couponId: chosen.id } : {}) }),
      });
      const j = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string; totalCents?: number };
      if (res.ok && j.orderId) {
        localStorage.setItem(LS_LAST, j.orderId);
        clearPurchaseKey();
        saveBag([], ""); // the order is placed: do not bring this bag back
        if (payMethod === "credit") void loadMember(); // the balance has gone down
        if (payMethod === "card" || payMethod === "paynow") {
          // The order exists; now send the customer to the card / PayNow page. If that is unavailable they land on the
          // order's page, which offers to pay again or to pay at the counter.
          const pr = await fetch(`/api/shop/orders/${j.orderId}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: payMethod }) })
            .then((r) => r.json() as Promise<{ url?: string }>)
            .catch(() => ({}) as { url?: string });
          if (pr.url) {
            location.href = pr.url;
            return;
          }
        }
        location.hash = `#/shop/order/${j.orderId}`;
      } else if (res.status === 409 && j.error === "price_changed") {
        setAgreed(j.totalCents ?? null);
        setNote(`Prices changed while you were ordering. The new total is ${formatMoney(j.totalCents ?? 0)}. Tap Pay again to confirm.`);
      } else if (j.error === "purchase_in_progress") {
        setNote(tx("Your order is still being placed. Please wait a moment, then tap Pay again. You will not be charged twice."));
      } else if (j.error === "idempotency_key_reused") {
        clearPurchaseKey();
        setNote(tx("Something changed on your order. Please check it and tap Pay again."));
      } else if (j.error === "not_enough_credit") {
        void loadMember();
        setNote(tx("Not enough credit: {amt} available.", { amt: formatMoney((j as { balanceCents?: number }).balanceCents ?? 0) }));
      } else if (j.error === "sign_in_to_use_credit") {
        setNote(tx("Sign in to pay with your member credit."));
      } else if (res.status === 429) {
        setNote(tx("Too many orders from this device. Please wait a few minutes or order at the counter."));
      } else if (j.error === "coupon_not_available" || j.error === "coupon_not_eligible") {
        setCouponId(null);
        void loadMember();
        setNote(tx("That coupon can't be used on this order. Please check your total and try again."));
      } else if (j.error === "not_enough_points") {
        setUsePoints(false);
        void loadMember();
        setNote(tx("Your points balance changed. Please check your total and try again."));
      } else if (j.error === "unavailable" || j.error === "option_sold_out") {
        setNote(tx("One of your items just sold out. Please check your bag."));
      } else {
        setNote(tx("We couldn't place your order. Please try again, or order at the counter."));
      }
    } catch {
      setNote(tx("We lost the connection, so we cannot tell if your order went through. Tap Pay again: you will not be charged twice."));
    } finally {
      setBusy(false);
    }
  }

  const last = localStorage.getItem(LS_LAST);
  const phoneOk = /^[+\d][\d\s-]{5,19}$/.test(phone) && phone.replace(/\D/g, "").length >= 8;
  const needle = (search ?? "").trim().toLowerCase();
  const shown = menu.filter((m) => (category === "All" || m.category === category) && (!needle || m.name.toLowerCase().includes(needle) || (m.altName ?? "").toLowerCase().includes(needle)));
  const dine = channel?.kind === "dine_in";
  const spotText = dine ? spot || tx("Add table") : tx("Pickup counter");
  const who = member ? member.name || (member.email ?? member.phone ?? "Member").split("@")[0] : t("guestW", "Guest");
  const canOrder = !!quote?.ok && (!!member || (!info.membersOnly && guestOk)) && phoneOk;
  const navActive = screen === "rewards" ? "rewards" : screen === "account" ? "account" : "order";

  /* ---- shared pieces ---- */
  const header = (noSpot: boolean) => (
    <header className="shop-top">
      <div className="shop-left">
        <span className="shop-greet">{greeting()}</span>
        <b className="shop-name">{who}</b>
        <button className="shop-chip" onClick={() => setLangOpen(true)} aria-label={`${t("language", "Language")} — ${LANGS.find((l) => l.code === lang())!.native}`}><Icon name="globe" size={15} /><span>{shortLabel()}</span></button>
      </div>
      <div className="shop-logo">{b.logoUrl ? <img src={b.logoUrl} alt={info.name} /> : <b>{info.name}</b>}</div>
      <div className="shop-meta">
        {dine && !noSpot && (
          <button className={`shop-table ${spot ? "on" : ""}`} disabled={tableLocked} style={tableLocked ? { opacity: 1, cursor: "default" } : undefined} onClick={() => setTableEdit((v) => !v)} aria-label={tableLocked ? spot : "Change table"}>
            <Icon name="table" size={16} />{spot || tx("Add table")}
          </button>
        )}
        {member ? (
          rewardsOn ? (config.rewards.pointsEnabled && <span className="shop-pts">{member.pointsBalance.toLocaleString()} points</span>) : <span className="shop-pts">{formatMoney(credit)} {tx("credit")}</span>
        ) : rewardsOn ? (
          <button className="shop-pts link" onClick={() => setScreen("login")}>{t("signUpNow", "Sign up now")}<br />{tx("& get {n} points", { n: config.rewards.welcomePoints })}</button>
        ) : (
          <button className="shop-pts link" onClick={() => setScreen("login")}>{t("signInW", "Sign in")}<br />{tx("to pay with credit")}</button>
        )}
        <span className="shop-outlet"><Icon name="pin" size={13} />{info.outletName}</span>
      </div>
    </header>
  );
  const seg = channels.length < 2 ? null : (
    <div className="shop-seg">
      {channels.map((c) => <button key={c.id} className={c.id === channelId ? "on" : ""} onClick={() => { setChannelId(c.id); setAgreed(null); }}><Icon name={channelIcon(c.kind)} size={19} />{c.kind === "dine_in" ? t("dineIn", c.name) : c.kind === "takeaway" ? t("takeAway", c.name) : c.name}</button>)}
    </div>
  );
  const pageHead = (title: string, opts: { seg?: boolean } = {}) => (
    <div className="shop-headwrap">
      {header(true)}
      {opts.seg && seg}
      <h2 className="page-title">{title}</h2>
    </div>
  );
  const back = (label: string, to: Screen) => <button className="e2e-back" onClick={() => setScreen(to)}><Icon name="chevL" size={16} /> {label}</button>;
  const noteEl = note && <div className="shop-note">{note}</div>;

  const totalsRows = (q2: NonNullable<typeof quote> & { ok: true }) => (
    <>
      <div className="sum-row"><span className="k">{t("itemsSubtotal", "Items subtotal")}</span><span className="v">{formatMoney(q2.priced.subtotal)}</span></div>
      {q2.priced.couponDiscount > 0 && <div className="sum-row neg"><span className="k">{chosen?.title ?? "Coupon / voucher"}</span><span className="v">−{formatMoney(q2.priced.couponDiscount)}</span></div>}
      {q2.priced.pointsDiscount > 0 && <div className="sum-row neg"><span className="k">Points · {q2.priced.pointsUsed.toLocaleString()} pts</span><span className="v">−{formatMoney(q2.priced.pointsDiscount)}</span></div>}
      {q2.priced.service > 0 && <div className="sum-row"><span className="k">{t("pmService", "Service charge")} ({Math.round(config.pricing.serviceRate * 1000) / 10}%)</span><span className="v">{formatMoney(q2.priced.service)}</span></div>}
      {q2.priced.gst > 0 && <div className="sum-row"><span className="k">GST</span><span className="v">{formatMoney(q2.priced.gst)}</span></div>}
      {q2.priced.bcrs > 0 && <div className="sum-row"><span className="k">{t("bcrsDeposit", "BCRS Deposit")} ({tx("+{n}c each", { n: config.pricing.bcrsDepositCents })})</span><span className="v">{formatMoney(q2.priced.bcrs)}</span></div>}
      <div className="sum-row grand"><span className="k">{t("total", "Total")}</span><span className="v">{formatMoney(shownTotal)}</span></div>
    </>
  );
  const lineView = (l: BagLine) => {
    const m = byId.get(l.productId);
    const r = m ? resolveOptions(m.options, l.selection) : null;
    if (!m || !r?.ok) return null;
    return { m, r, lineCents: (m.priceCents + r.extraCents) * l.qty, opts: optionLines(r.options).join(" · ") };
  };
  const itemRows = (thumbs: boolean) =>
    bag.map((l) => {
      const v = lineView(l);
      if (!v) return null;
      const img = photo(v.m) ?? b.heroUrl;
      return (
        <div className="sum-row" key={l.key}>
          <span className="k with-thumb">{thumbs && img && <img className="status-thumb" src={img} alt="" />}<span>{v.m.name} × {l.qty}{v.opts && <small className="muted" style={{ display: "block" }}>{v.opts}</small>}</span></span>
          <span className="v">{formatMoney(v.lineCents)}</span>
        </div>
      );
    });
  const detailsCard = (
    <div className="e2e-card">
      <h3>{t("detailsW", "Details")}</h3>
      <div className="sum-row"><span className="k">{t("outletW", "Outlet")}</span><span className="v">{info.outletName}</span></div>
      <div className="sum-row"><span className="k">{t("modeW", "Mode")}</span><span className="v">{channel?.name}{dine ? ` · ${spot || tx("no table yet")}` : ` · ${tx("Pickup counter")}`}</span></div>
      <div className="sum-row"><span className="k">{t("memberW", "Member")}</span><span className="v">{member ? (rewardsOn ? `${who} · ${member.pointsBalance.toLocaleString()} points` : `${who} · ${formatMoney(credit)} ${tx("credit")}`) : "Guest"}</span></div>
      {phone && <div className="sum-row"><span className="k">{t("phoneW", "Phone")}</span><span className="v">{phone}</span></div>}
    </div>
  );

  const nav = (
    <nav className="shop-nav" aria-label="Sections">
      {([["order", "basket", screen !== "order" && count > 0 && navActive === "order" ? tx("Add More") : t("order", "Order")], ...(rewardsOn ? [["rewards", "gift", t("rewards", "Rewards")] as const] : []), ["account", "user", t("account", "Account")]] as const).map(([id, ic, label]) => (
        <button key={id} aria-current={navActive === id ? "page" : undefined} onClick={() => setScreen(id)}><Icon name={ic} size={20} /><span>{label}</span></button>
      ))}
    </nav>
  );

  const langSheet = langOpen && (
    <div className="shop-sheet" role="dialog" aria-label={t("language", "Language")}>
      <div className="shop-sheet-in">
        <div className="shop-sheet-head"><h2>{t("language", "Language")}</h2><button onClick={() => setLangOpen(false)} aria-label={t("close", "Close")}>✕</button></div>
        <p className="muted">{t("langLead", "Choose the language for this app.")}</p>
        <div className="lang-list">
          <button className="lang-opt" aria-current={langMode() === "auto"} onClick={() => { setLangMode("auto"); setLangOpen(false); }}>
            <Icon name="globe" size={19} /><span className="lang-names"><span className="lang-native">{t("auto", "Auto")}</span><span className="lang-en">{LANGS.find((l) => l.code === detectedLang())!.native} · {LANGS.find((l) => l.code === detectedLang())!.en}</span></span>
            {langMode() === "auto" && <span className="cur">{t("current", "Current")}</span>}
          </button>
          {LANGS.map((l) => (
            <button key={l.code} className="lang-opt" aria-current={langMode() === l.code} onClick={() => { setLangMode(l.code); setLangOpen(false); }}>
              <span className="lang-names"><span className="lang-native">{l.native}</span><span className="lang-en">{l.en}</span></span>
              {langMode() === l.code ? <span className="cur">{t("current", "Current")}</span> : langMode() === "auto" && lang() === l.code ? <span className="cur">{t("autoShort", "Auto")}</span> : null}
            </button>
          ))}
        </div>
        <button className="shop-primary" onClick={() => setLangOpen(false)}>{t("close", "Close")}</button>
      </div>
    </div>
  );
  const walletSheet = wallet && (
    <div className="shop-sheet" role="dialog" aria-label={tx("Coupons and vouchers")}>
      <div className="shop-sheet-in">
        <div className="shop-sheet-head"><h2>{tx("Coupons & vouchers")}</h2><button onClick={() => setWallet(false)} aria-label="Close">✕</button></div>
        {!member && <button className="shop-link" onClick={() => { setWallet(false); setScreen("login"); }}>{tx("Sign in to use your coupons & vouchers")}</button>}
        {member && coupons.length === 0 && <p className="muted">{tx("You have no coupons right now.")}</p>}
        {coupons.map((c) => {
          const ok = itemsSubtotal >= c.minSpendCents;
          return (
            <label key={c.id} className={`shop-coupon ${ok ? "" : "off"}`}>
              <input type="radio" name="coupon" disabled={!ok} checked={couponId === c.id} onChange={() => { setCouponId(c.id); setAgreed(null); }} onClick={() => couponId === c.id && setCouponId(null)} />
              <span>
                {c.title}
                <small className="muted">
                  {c.minSpendCents > 0 ? tx("Min. spend {amt} on items only (before service charge, tax and deposits)", { amt: formatMoney(c.minSpendCents) }) : tx("No minimum spend")}
                  {!ok && ` · Add ${formatMoney(c.minSpendCents - itemsSubtotal)} more in items`}
                </small>
              </span>
            </label>
          );
        })}
        <button className="shop-primary" onClick={() => setWallet(false)}>{t("done", "Done")}</button>
      </div>
    </div>
  );

  /* ================= Login ================= */
  if (screen === "login") {
    return (
      <Login
        info={info}
        loginError={loginError}
        welcome={config.rewards.welcomePoints}
        onGuest={() => { sessionStorage.setItem(LS_ENTERED, "1"); setScreen("order"); }}
        onDone={(t) => { localStorage.setItem(LS_MEMBER, t); sessionStorage.setItem(LS_ENTERED, "1"); void loadMember(); setScreen("order"); }}
      />
    );
  }

  /* ================= Order ================= */
  const orderScreen = (
    <>
      <div className="shop-fixedhead" ref={headRef}>
        {header(false)}
        {tableEdit && dine && !tableLocked && (
          tableList.length ? (
            <div className="shop-tableedit"><select autoFocus value={spot} onChange={(e) => { if (changeTable(e.target.value)) setTableEdit(false); }}><option value="">{tx("Choose your table")}</option>{tableList.map((x) => <option key={x}>{x}</option>)}</select></div>
          ) : (
          <div className="shop-tableedit"><input autoFocus value={spot} maxLength={30} placeholder={tx("e.g. Table 12")} onChange={(e) => setSpot(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setTableEdit(false)} /><button onClick={() => setTableEdit(false)}>{t("done", "Done")}</button></div>
          )
        )}
        {seg}
      </div>
      {last && <a className="shop-last" href={`#/shop/order/${last}`}>{tx("View my last order →")}</a>}
      {b.heroUrl && (
        <div className="shop-hero">
          <img src={b.heroUrl} alt="" />
          {b.tagline && <span><Icon name="paw" size={16} />{b.tagline}</span>}
        </div>
      )}
      <div className="shop-catalog">
        {(b.promoTitle || b.promoBody) && (
          <>
            <h2 className="shop-sec">{t("specialOffer", "Special Offer")}</h2>
            <section className="shop-promo">
              {b.promoTitle && <h3>{b.promoTitle}</h3>}
              {b.promoBody && <p>{b.promoBody}</p>}
            </section>
          </>
        )}
        <div className="shop-chips">
          <button className={`search ${search !== null ? "on" : ""}`} aria-label={tx("Search the menu")} aria-expanded={search !== null} onClick={() => { setSearchCleared(false); setSearch((s) => (s === null ? "" : null)); }}><Icon name="search" size={18} /></button>
          {categories.map((c) => <button key={c} className={c === category ? "on" : ""} onClick={() => { setCategory(c); if (searchCleared && search !== null && !search.trim()) { setSearch(null); setSearchCleared(false); } }}>{c === "All" ? t("all", "All") : tx(c)}</button>)}
        </div>
        {search !== null && (
          <div className="search-bar">
            <Icon name="search" size={17} />
            <input className="search-input" type="search" autoFocus autoComplete="off" enterKeyHint="search" placeholder={tx("Search the menu")} aria-label={tx("Search the menu")} value={search} onChange={(e) => { setSearch(e.target.value); setSearchCleared(false); }} />
            {search !== "" && <button className="search-clear" aria-label={`${tx("Search the menu")}: ${t("clear", "Clear")}`} onClick={() => { setSearch(""); setSearchCleared(true); }}>&times;</button>}
          </div>
        )}
        {noteEl}
        <div className="shop-list">
          {shown.length === 0 && <p className="shop-msg">{tx("Nothing matches.")}</p>}
          {shown.map((m) => {
            const n = inBag(m.id);
            const img = photo(m);
            const hasOpts = !!m.options?.length;
            const card = (
              <div key={m.id} className={`sc ${n ? "in" : ""} ${m.soldOut ? "out" : ""}`}>
                <div className="sc-photo">
                  {img ? <img src={img} alt="" loading="lazy" /> : <span className="sc-noimg" />}
                  {n > 0 && <span className="sc-badge">×{n} {tx("in bag")}</span>}
                </div>
                <div className="sc-main">
                  <b>{m.name}</b>
                  <span className="muted">{m.description ?? m.category}</span>
                  <span className="sc-price">{m.soldOut ? "Sold out" : cardPrice(m)}{!m.soldOut && /bcrs/i.test(m.name) && <em className="bcrs-badge"><Icon name="can" size={11} />+10c BCRS Deposit</em>}</span>
                </div>
                {!m.soldOut && (
                  <div className="sc-act">
                    {n > 0 && !hasOpts ? (
                      <span className="sc-step"><button className="minus" aria-label={`Fewer ${m.name}`} onClick={() => addSimple(m, -1)}>−</button><b>{n}</b><button className="plus" aria-label={`More ${m.name}`} onClick={() => addSimple(m, 1)}>+</button></span>
                    ) : (
                      <button className="sc-add" aria-label={`Add ${m.name}`} onClick={() => (hasOpts ? setPicking(m) : addSimple(m, 1))}>+</button>
                    )}
                  </div>
                )}
              </div>
            );
            // An item that is already in the bag slides left to take it out, like the prototype. That removes every variant of it.
            return n > 0 ? <SwipeRow key={m.id} label={m.name} onRemove={() => { setBag((cur) => cur.filter((x) => x.productId !== m.id)); setAgreed(null); }}>{card}</SwipeRow> : card;
          })}
        </div>
      </div>
      {count > 0 && (
        <button className="shop-bar" onClick={() => setScreen("bag")}>
          <Icon name="bag" size={20} /><span>{tx(count > 1 ? "View bag · {n} items" : "View bag · {n} item", { n: count })}</span>
          <span className="amt"><i className="div" /><b>{formatMoney(total)}</b><Icon name="arrowR" size={18} /></span>
        </button>
      )}
    </>
  );

  /* ================= Rewards ================= */
  const rewardsScreen = (
    <>
      {pageHead(tx("Your rewards"))}
      <div className="scroll-body shop-body">
        {!member ? (
          <div className="e2e-card">
            <h3>{t("guestRewardsT", "Rewards are for members")}</h3>
            <p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>{tx("Members earn points on every order and redeem them for money off. Sign up free to start earning.")}</p>
            {earnPts > 0 && <div className="ready-banner" role="status">{tx("Sign up to earn {n} points on this order", { n: earnPts.toLocaleString() })}</div>}
            <button className="e2e-cta" onClick={() => setScreen("login")}><span>{t("signUpBtn", "Sign up")}</span><Icon name="arrowR" size={19} /></button>
            <button className="e2e-cta queue-btn" onClick={() => setScreen("order")}><span>{t("backToOrder", "Back to Order")}</span><Icon name="arrowR" size={19} /></button>
          </div>
        ) : (
          <>
            <div className="member-card">
              <div className="member-top">
                <span className="avatar">{b.logoUrl ? <img src={b.logoUrl} alt="" /> : <Icon name="user" size={26} />}</span>
                <div className="member-main">
                  <div className="name">{who}</div>
                  {config.rewards.pointsEnabled && <div className="pts-stack"><span className="pts-line"><b>{member.pointsBalance.toLocaleString()}</b><span>{t("points", "points")}</span></span><span className="pts-worth">{tx("{amt} worth", { amt: formatMoney(member.pointsBalance) })}</span></div>}
                </div>
              </div>
            </div>
            {stamps && (
              <div className="stamp-panel">
                <div className="panel-head"><h3>{tx("Your stamp card")}</h3></div>
                <div className="stamp-type-name">{stamps.rewardTitle}</div>
                <div className="shop-stamps" aria-label={`Stamp card ${stamps.count} of ${stamps.target}`}><span>{Array.from({ length: stamps.target }, (_, i) => <i key={i} className={i < stamps.count ? "on" : ""} />)}</span></div>
                <div className="stamp-progress"><div className="big">{stamps.count} / {stamps.target} stamps</div>
                  <div className="sub">{stamps.target - stamps.count > 0 ? tx("{n} more to unlock {title}", { n: stamps.target - stamps.count, title: stamps.rewardTitle }) : tx("Ready — {title}", { title: stamps.rewardTitle })}{stamps.minPaidCents > 0 ? tx(" · orders of {amt}+", { amt: formatMoney(stamps.minPaidCents) }) : ""}</div></div>
              </div>
            )}
            <div className="coupon-head"><h3>{tx("Coupons & points")}</h3></div>
            <div className="reward-slots">
              {rewardSlots(false)}
            </div>
          </>
        )}
      </div>
    </>
  );

  function rewardSlots(inBagScreen: boolean) {
    const n = coupons.length;
    return (
      <>
        <div className="reward-slot">
          <span className="ric" style={{ color: "var(--red)" }}><Icon name="ticket" size={26} /></span>
          <span className="reward-copy slot-scroll"><span className="t">{t("walletEntryT", "Coupon(s) / voucher(s)")}</span><span className="d">{chosen && chosenOk ? tx("{title} applied · ", { title: chosen.title }) : ""}{tx("{n} in your wallet", { n })}</span></span>
          <span className="slot-actions">
            {chosen && chosenOk && <button className="slot-act remove" onClick={() => { setCouponId(null); setAgreed(null); }}>{t("removeW", "Remove")}</button>}
            <button className="slot-act" onClick={() => setWallet(true)}>{n > 0 ? tx("View") : tx("Details")}</button>
          </span>
        </div>
        {config.rewards.pointsEnabled && (
          <div className={`reward-slot ${usePoints && canUsePoints ? "is-on" : ""}`}>
            <span className="ric" style={{ color: "var(--orange-dark)" }}><Icon name="stack" size={26} /></span>
            <span className="reward-copy slot-scroll">
              <span className="t">{pointsAsk && quote?.ok ? tx("{pts} points = {amt} off", { pts: quote.priced.pointsUsed.toLocaleString(), amt: formatMoney(quote.priced.pointsDiscount) }) : tx("Points — 100 points = S$1 off")}</span>
              <span className="d">{canUsePoints ? (reqPts !== null ? tx("You chose {a} of the {b} points this order can use.", { a: reqPts.toLocaleString(), b: maxPts.toLocaleString() }) : tx("You have {n} points. Using points redeems all you can use on this order.", { n: member!.pointsBalance.toLocaleString() })) : tx("You have {n} points ({min} needed to use them).", { n: (member?.pointsBalance ?? 0).toLocaleString(), min: config.pricing.minPointsRedeem })}</span>
            </span>
            <span className="slot-actions">
              {pointsAsk ? (
                <>
                  {inBagScreen && maxPts > minPts && <button className="slot-act" onClick={() => setPEdit(true)}>{t("editW", "Edit")}</button>}
                  <button className="slot-act remove" onClick={() => { setUsePoints(false); setAgreed(null); }}>{t("removeW", "Remove")}</button>
                </>
              ) : (
                <button className={`slot-act ${canUsePoints && inBagScreen ? "" : "is-disabled"}`} disabled={!canUsePoints || !inBagScreen} onClick={() => { setUsePoints(true); setAgreed(null); }}>{t("usePointsBtn", "Use points")}</button>
              )}
            </span>
          </div>
        )}
      </>
    );
  }

  /* ================= Account ================= */
  const acctRow = (ic: keyof typeof ICONS, title: string, desc: string, onClick: () => void) => (
    <button className="acct-row" onClick={onClick}><span className="aic"><Icon name={ic} size={21} /></span><span className="at">{tx(title)}{desc && <span className="ad">{tx(desc)}</span>}</span><span className="chev"><Icon name="chevR" size={16} /></span></button>
  );
  const accountScreen = (
    <>
      {pageHead(t("account", "Account"))}
      <div className="scroll-body shop-body">
        {acctPanel === "profile" ? (
          <>
            <button className="e2e-back" onClick={() => setAcctPanel(null)}><Icon name="chevL" size={16} /> {tx("Back to Account")}</button>
            <div className="e2e-card">
              <h3>{t("profile", "Profile details")}</h3>
              {member ? (
                <>
                  {member.email && <div className="sum-row"><span className="k">{t("emailW", "Email")}</span><span className="v">{member.email}</span></div>}
                  <div className="e2e-field"><label htmlFor="pf-name">{t("displayNameL", "Display name")}</label><input className="e2e-input" id="pf-name" value={editName} maxLength={40} onChange={(e) => { setEditName(e.target.value); setProfileMsg(null); }} /></div>
                  <div className="e2e-field"><label htmlFor="pf-phone">{t("phoneW", "Phone")}</label><input className="e2e-input" id="pf-phone" type="tel" value={editPhone} maxLength={20} onChange={(e) => { setEditPhone(e.target.value); setProfileMsg(null); }} /></div>
                  {profileMsg && <p className="e2e-note" role="status">{profileMsg}</p>}
                  <button className="e2e-cta" onClick={() => void saveProfile()}><span>{tx("Save changes")}</span><Icon name="check" size={19} /></button>
                </>
              ) : (
                <>
                  <div className="sum-row"><span className="k">{t("signedInAs", "Signed in as")}</span><span className="v">{t("guestW", "Guest")}</span></div>
                  <button className="e2e-cta" onClick={() => setScreen("login")}><span>{t("signUpBtn", "Sign up")}</span><Icon name="arrowR" size={19} /></button>
                </>
              )}
            </div>
          </>
        ) : acctPanel === "notif" ? (
          <>
            <button className="e2e-back" onClick={() => setAcctPanel(null)}><Icon name="chevL" size={16} /> {t("backToAccount", "Back to Account")}</button>
            <div className="acct-sec" style={{ marginLeft: 4 }}>{t("notifications", "Notifications")}</div>
            <div className="acct-list" style={{ marginLeft: 0, marginRight: 0 }}>
              {!member ? (
                <p className="e2e-sub" style={{ textAlign: "left", padding: "10px 14px" }}>{t("notifGuest", "Sign in to see updates about your orders.")}</p>
              ) : history === null ? (
                <p className="e2e-sub" style={{ textAlign: "left", padding: "10px 14px" }}>{t("loadingW", "Loading…")}</p>
              ) : history.length === 0 ? (
                <p className="e2e-sub" style={{ textAlign: "left", padding: "10px 14px" }}>{t("notifNone", "No updates yet. Updates about your orders will show here.")}</p>
              ) : (
                history.slice(0, 15).map((o) => (
                  <a key={o.orderId} className="acct-row" href={`#/shop/order/${o.orderId}`}>
                    <span className="aic"><Icon name="bell" size={21} /></span>
                    <span className="at">{o.queueNumber} — {STATUS_TEXT[o.status].title.split(":")[0]}<span className="ad">{o.channelName ?? tx("Order")}{o.spot ? ` · ${o.spot}` : ""} · {tx(o.itemCount === 1 ? "{n} item" : "{n} items", { n: o.itemCount })}</span></span>
                    <span className="ad" style={{ flex: "none" }}>{new Date(o.at).toLocaleDateString()}</span>
                  </a>
                ))
              )}
            </div>
          </>
        ) : acctPanel === "prefs" ? (
          <>
            <button className="e2e-back" onClick={() => setAcctPanel(null)}><Icon name="chevL" size={16} /> {t("backToAccount", "Back to Account")}</button>
            <div className="e2e-card">
              <h3>{t("preferences", "Preferences")}</h3>
              <button className="sum-link-row" onClick={() => setLangOpen(true)}><span className="sl-ic"><Icon name="globe" size={21} /></span><span className="sl-t">{t("language", "Language")}<span className="sl-d">{t("langLeadShort", "Auto-selects from your phone settings.")}</span></span><span className="sl-v">{LANGS.find((l) => l.code === lang())!.native}</span><span className="chev"><Icon name="chevR" size={16} /></span></button>
              {([["orderUpdates", "prefNotifT", "Order updates", "prefNotifD", "Email me when my order is ready."], ["promos", "prefPromoT", "Offers and news", "prefPromoD", "Email me about new items and offers."]] as const).map(([k, tk, tt, dk, dd]) => {
                const on = member ? (member.prefs?.[k] ?? k === "orderUpdates") : false;
                return (
                  <button key={k} className="set-opt" aria-pressed={on} disabled={!member} style={{ marginTop: 10, opacity: member ? 1 : 0.6 }} onClick={() => void savePref(k, !on)}>
                    <span className="so-main"><span className="so-t">{t(tk, tt)}</span><span className="so-d">{t(dk, dd)}</span></span>
                    <span className={`set-switch${on ? " is-on" : ""}`}><span className="sw-word">{on ? t("onW", "On") : t("offW", "Off")}</span><span className="sw-track"><span className="sw-knob" /></span></span>
                  </button>
                );
              })}
              {!member && <p className="e2e-note">{t("prefsGuest", "Sign in to choose which emails you get.")}</p>}
              {member && !member.email && <p className="e2e-note">{t("prefsNoEmail", "Add an email address in Profile details to receive these.")}</p>}
            </div>
          </>
        ) : acctPanel === "help" ? (
          <>
            <button className="e2e-back" onClick={() => setAcctPanel(null)}><Icon name="chevL" size={16} /> {tx("Back to Account")}</button>
            <div className="e2e-card">
              <h3>{tx("Help & support")}</h3>
              <div className="sum-row"><span className="k">{t("outletW", "Outlet")}</span><span className="v">{info.name} · {info.outletName}</span></div>
              <div className="sum-row" style={{ display: "block" }}><span className="k" style={{ fontWeight: 700, color: "var(--ink)" }}>{tx("How do I collect my order?")}</span><span className="ad" style={{ display: "block", marginTop: 2, fontSize: 12 }}>{tx("Your collection number is the last 5 digits of the phone number you ordered with. Watch for it on the counter screen.")}</span></div>
              <div className="sum-row" style={{ display: "block" }}><span className="k" style={{ fontWeight: 700, color: "var(--ink)" }}>{t("helpQ2", "How do points work?")}</span><span className="ad" style={{ display: "block", marginTop: 2, fontSize: 12 }}>{tx("Members earn points on every order. 100 points = S$1 off a later order — apply points in the Bag before you check out.")}</span></div>
              {info.contact?.hours && <div className="sum-row"><span className="k">{tx("Opening hours")}</span><span className="v">{info.contact.hours}</span></div>}
              {info.contact?.phone && <div className="sum-row"><span className="k">{tx("Call us")}</span><span className="v"><a href={`tel:${info.contact.phone.replace(/[^+\d]/g, "")}`}>{info.contact.phone}</a></span></div>}
              <p className="e2e-note">{tx("Still need help? Please ask at the counter and we will sort it out.")}</p>
            </div>
          </>
        ) : (
          <>
            <div className="member-card">
              <div className="member-top">
                <span className="avatar">{b.logoUrl ? <img src={b.logoUrl} alt="" /> : <Icon name="user" size={26} />}</span>
                {member ? (
                  <div className="member-main">
                    <div className="name">{who}</div>
                    {member.phone && <div className="acct-phone">{member.phone}</div>}
                    <div className="pts-stack"><span className="pts-line"><b>{formatMoney(credit)}</b><span>{tx("credit")}</span></span></div>
                    {config.rewards.pointsEnabled && <div className="pts-stack"><span className="pts-line"><b>{member.pointsBalance.toLocaleString()}</b><span>{t("points", "points")}</span></span><span className="pts-worth">{tx("{amt} worth", { amt: formatMoney(member.pointsBalance) })}</span></div>}
                  </div>
                ) : (
                  <div className="member-main">
                    <div className="name">{t("guestW", "Guest")}</div>
                    <div className="pts-stack"><span className="pts-line" style={{ fontSize: 14, lineHeight: "18px", fontWeight: 600 }}>{!rewardsOn ? tx("Sign in to pay with your member credit") : earnPts > 0 ? tx("Sign up to earn {n} points on this order", { n: earnPts.toLocaleString() }) : tx("Sign up to earn points on this order")}</span></div>
                    <button className="history" onClick={() => setScreen("login")}>{t("signUpBtn", "Sign up")} <Icon name="chevR" size={14} /></button>
                  </div>
                )}
              </div>
            </div>
            <div className="acct-sec">{t("myAccount", "My account")}</div>
            <div className="acct-list">
              {acctRow("user", t("profile", "Profile details"), "Name, phone and email on this account", () => { setEditName(member?.name ?? ""); setEditPhone(member?.phone ?? ""); setProfileMsg(null); setAcctPanel("profile"); })}
              {acctRow("globe", t("language", "Language"), LANGS.find((l) => l.code === lang())!.native + (langMode() === "auto" ? " · " + t("autoShort", "Auto") : ""), () => setLangOpen(true))}
              {acctRow("bell", t("notifications", "Notifications"), t("notificationsD", "Updates about your orders"), () => { setAcctPanel("notif"); })}
              {acctRow("sliders", t("preferences", "Preferences"), t("preferencesD", "Language and email choices"), () => setAcctPanel("prefs"))}
              {acctRow("help", "Help & support", "FAQs and contacting the outlet", () => setAcctPanel("help"))}
            </div>
            <div className="acct-sec">{t("orderHistory", "Order history")}</div>
            <div className="order-hist">
              {!member ? (
                last ? <a className="acct-row" href={`#/shop/order/${last}`}><span className="aic"><Icon name="ticket" size={21} /></span><span className="at">{tx("View my last order")}<span className="ad">{tx("See its status and items")}</span></span><span className="chev"><Icon name="chevR" size={16} /></span></a> : <p className="e2e-sub" style={{ textAlign: "left" }}>{tx("Sign in to see your past orders.")}</p>
              ) : history === null ? (
                <p className="e2e-sub" style={{ textAlign: "left" }}>{tx("Loading…")}</p>
              ) : history.length === 0 ? (
                <p className="e2e-sub" style={{ textAlign: "left" }}>{tx("No orders yet.")}</p>
              ) : (
                history.map((o) => (
                  <a key={o.orderId} className="acct-row" href={`#/shop/order/${o.orderId}`}>
                    <span className="aic"><Icon name="ticket" size={21} /></span>
                    <span className="at">{o.queueNumber} — {o.channelName ?? tx("Order")}{o.spot ? ` · ${o.spot}` : ""}<span className="ad">{STATUS_TEXT[o.status].title.split(":")[0]} · {new Date(o.at).toLocaleDateString()} · {tx(o.itemCount === 1 ? "{n} item" : "{n} items", { n: o.itemCount })}</span></span>
                    <span className="v" style={{ fontWeight: 700 }}>{formatMoney(o.totalCents)}</span>
                  </a>
                ))
              )}
            </div>
            {member ? (
              <button className="signout-btn" onClick={() => void signOut()}><Icon name="logout" size={19} /><span>{t("signOut", "Sign out")}</span></button>
            ) : (
              <button className="signout-btn" onClick={() => setScreen("login")}><Icon name="user" size={19} /><span>{t("signInUp", "Sign up / Sign in")}</span></button>
            )}
          </>
        )}
      </div>
    </>
  );

  /* ================= Points editor ================= */
  const pVal = Math.max(minPts, Math.min(reqPts ?? maxPts, maxPts));
  const pPct = maxPts > minPts ? Math.round(((pVal - minPts) / (maxPts - minPts)) * 100) : 100;
  const choosePts = (n: number) => {
    if (!Number.isFinite(n)) return;
    const v = Math.max(minPts, Math.min(Math.round(n), maxPts));
    setPointsPts(v >= maxPts ? null : v);
    setAgreed(null);
  };
  const pointsEditor = pEdit && pointsAsk && maxPts > 0 && (
    <div className="popup-back" onClick={(e) => { if (e.target === e.currentTarget) setPEdit(false); }}>
      <div className="popup-wrap">
        <div className="popup-card" role="dialog" aria-modal="true">
          <h3>{t("redeemTitle", "Redeem points")}</h3>
          <p className="lead">{t("redeemLead2", "Slide to choose how many points to use on this order.")}</p>
          <div className="popup-rows">
            <div className="popup-row"><span className="k">{t("yourBalance", "Your balance")}</span><span className="v">{member!.pointsBalance.toLocaleString()} {t("points", "points")}</span></div>
            <div className="popup-row"><span className="k">{t("maxClaim", "Most this order can use")}</span><span className="v">{maxPts.toLocaleString()} {t("points", "points")}</span></div>
          </div>
          <p className="hist-note" style={{ margin: "6px 0 8px" }}>{t("redeemNote2", "100 points = S$1 off. Any points you don't use stay in your balance.")}</p>
          <div className="pedit-slider-box">
            <span className="pedit-val"><span className="n">{pVal.toLocaleString()} {t("points", "points")}</span><br /><span className="d">= {formatMoney(pVal)} {t("offOrder", "off this order")}</span></span>
            <input type="range" className="pedit-slider" min={minPts} max={maxPts} step={1} value={pVal} onChange={(e) => choosePts(Number(e.target.value))} style={{ background: `linear-gradient(90deg,var(--orange) ${pPct}%,#e9dec9 ${pPct}%)` }} aria-label={t("redeemSliderAria", "Points to redeem")} />
            <div className="pedit-scale"><span>{minPts.toLocaleString()}</span><span>{t("maxW", "Max")} {maxPts.toLocaleString()}</span></div>
          </div>
          <button className="pedit-all" aria-expanded={pEditAmt} onClick={() => setPEditAmt(!pEditAmt)}>{t("editAmount", "Type an exact amount")}</button>
          {pEditAmt && <div className="pedit-amt-row"><input className="qty-input" type="number" inputMode="numeric" min={minPts} max={maxPts} step={1} value={pVal} onChange={(e) => choosePts(Number(e.target.value))} aria-label={t("redeemExactAria", "Exact points to redeem")} /><span className="pedit-amt-unit">{t("points", "points")} · = {formatMoney(pVal)} {t("offShort", "off")}</span></div>}
          <button className="pedit-all" onClick={() => { setPointsPts(null); setAgreed(null); }}>{t("redeemMax", "Use the most")} · {maxPts.toLocaleString()} {t("points", "points")}</button>
          <button className="popup-close" onClick={() => setPEdit(false)}>{t("done", "Done")}</button>
        </div>
      </div>
    </div>
  );

  /* ================= Bag ================= */
  const bagScreen = (
    <>
      <div className="shop-headwrap">
        {header(true)}
        {seg}
        <div className="title-row">
          <button className="back-btn" onClick={() => setScreen("order")} aria-label={tx("Back")}><Icon name="chevL" size={20} /></button>
          <h2 className="page-title">{t("yourBag", "Your bag")}</h2>
          <span className="table-tag tag-with-icon"><Icon name={dine ? "table" : "bag"} size={15} />{spotText}</span>
          {confirmClear ? (
            <span className="clear-confirm">{t("clearBagQ", "Clear bag?")}<button className="yes" onClick={() => { setBag([]); setConfirmClear(false); setScreen("order"); }}>{t("clear", "Clear")}</button><button className="no" onClick={() => setConfirmClear(false)}>{t("keep", "Keep")}</button></span>
          ) : (
            bag.length > 0 && <button className="clear-btn" onClick={() => setConfirmClear(true)}>{t("clearAll", "Clear all")}</button>
          )}
        </div>
      </div>
      <div className="bag-sheet shop-body">
        {noteEl}
        {bag.length === 0 && <div className="bag-empty">{t("bagEmptyShort", "Your bag is empty.")}<br />{t("emptyBagD", "Add items from the Order tab.")}</div>}
        {bag.map((l) => {
          const v = lineView(l);
          if (!v) return null;
          const img = photo(v.m);
          return (
            <SwipeRow key={l.key} label={v.m.name} onRemove={() => setBag(bag.filter((x) => x.key !== l.key))}>
            <div className="bag-card">
              {img ? <img className="bag-photo" src={img} alt={v.m.name} /> : <span className="bag-photo-ph"><Icon name="paw" size={26} /></span>}
              <div className="bag-copy2">
                <h3 className="bag-name">{v.m.name}</h3>
                <p className="bag-desc">{v.opts || v.m.description || v.m.category}</p>
                <div className="bag-pricerow">{formatMoney(v.lineCents)}</div>
              </div>
              <div className="sc-act"><span className="sc-step"><button className="minus" aria-label={`Fewer ${v.m.name}`} onClick={() => bump(l, -1)}>−</button><b>{l.qty}</b><button className="plus" aria-label={`More ${v.m.name}`} onClick={() => bump(l, 1)}>+</button></span></div>
            </div>
            </SwipeRow>
          );
        })}
        {quote?.ok && bag.length > 0 && (
          <>
            {rewardsOn && <div className="reward-head">{t("applyReward", "Apply a reward")}</div>}
            {!rewardsOn ? null : member ? (
              <div className="reward-slots">{rewardSlots(true)}</div>
            ) : (
              <div className="reward-slots">
                <div className="reward-slot">
                  <span className="ric" style={{ color: "var(--orange-dark)" }}><Icon name="stack" size={26} /></span>
                  <span className="reward-copy slot-scroll"><span className="t">{earnPts > 0 ? tx("Sign up to earn {n} points on this order", { n: earnPts.toLocaleString() }) : tx("Sign up to earn points on this order")}</span><span className="d">{tx("Members earn points on every order and redeem them for money off. Sign up free to start earning.")}</span></span>
                  <span className="slot-actions"><button className="slot-act" onClick={() => setScreen("login")}>{t("signUpBtn", "Sign up")}</button></span>
                </div>
              </div>
            )}
            <div className="totals">
              <div className="row"><span>{t("subtotal", "Subtotal")}</span><span className="v">{formatMoney(quote.priced.subtotal)}</span></div>
              {quote.priced.couponDiscount > 0 && <div className="row coupon"><span>{chosen?.title ?? "Coupon"}</span><span className="v">−{formatMoney(quote.priced.couponDiscount)}</span></div>}
              {quote.priced.pointsDiscount > 0 && <div className="row coupon"><span>Points · {quote.priced.pointsUsed.toLocaleString()} pts</span><span className="v">−{formatMoney(quote.priced.pointsDiscount)}</span></div>}
              {quote.priced.service > 0 && <div className="row"><span>{t("pmService", "Service charge")} ({Math.round(config.pricing.serviceRate * 1000) / 10}%)</span><span className="v">{formatMoney(quote.priced.service)}</span></div>}
              {quote.priced.gst > 0 && <div className="row"><span>GST</span><span className="v">{formatMoney(quote.priced.gst)}</span></div>}
              {quote.priced.bcrs > 0 && <div className="row"><span>{t("bcrsDeposit", "BCRS Deposit")} ({tx("+{n}c each", { n: config.pricing.bcrsDepositCents })})</span><span className="v">{formatMoney(quote.priced.bcrs)}</span></div>}
              <div className="row grand"><span>{t("total", "Total")}</span><span className="v">{formatMoney(shownTotal)}</span></div>
            </div>
            {rewardsOn && <div className="stamp-note"><span style={{ display: "flex", color: "var(--ink)" }}><Icon name="gift" size={27} /></span><span><span className="t">{t("stampNoteT", "1 stamp after confirmed payment")}</span><br /><span className="d">{tx("You'll earn 1 stamp for this order.")}</span></span></div>}
          </>
        )}
        <button className={`review-cta ${bag.length === 0 ? "off" : ""}`} disabled={bag.length === 0 || !quote?.ok} onClick={() => setScreen("summary")}>
          <Icon name="bag" size={19} /><span>{tx(count === 1 ? "Review order · {n} item" : "Review order · {n} items", { n: count })}</span><span className="div" /><span>{formatMoney(shownTotal)}</span><Icon name="arrowR" size={19} />
        </button>
      </div>
      {pointsEditor}
    </>
  );

  /* ================= Order summary ================= */
  const summaryScreen = quote?.ok ? (
    <>
      {pageHead(tx("Order Summary"))}
      <div className="e2e-scroll shop-body">
        <div className="sum-topbar">
          {back("Back to bag", "bag")}
          {/* As in the prototype: a jump to the bottom, where the order is placed. */}
          <button className="e2e-back" onClick={() => document.getElementById("sum-end")?.scrollIntoView({ behavior: "smooth", block: "center" })}>{tx("Checkout")} <Icon name="chevD" size={16} /></button>
        </div>
        {noteEl}
        <div className="e2e-card">
          <h3>{t("itemsCardT", "Items")}</h3>
          {itemRows(true)}
          {totalsRows(quote)}
        </div>
        <div className="e2e-card">
          <h3>{rewardsOn ? tx("Voucher & payment") : t("payMethodW", "Payment method")}</h3>
          {rewardsOn && <button className="sum-link-row" onClick={() => setWallet(true)}><span className="sl-ic"><Icon name="ticket" size={21} /></span><span className="sl-t">{t("voucher", "Voucher")}<span className="sl-d">{tx("Coupons & vouchers from your wallet")}</span></span><span className="sl-v">{chosen && chosenOk ? chosen.title : "None applied"}</span><span className="chev"><Icon name="chevR" size={16} /></span></button>}
          {info.membersOnly && member ? (
            <div className="sum-link-row" style={{ cursor: "default" }}><span className="sl-ic"><Icon name="stack" size={21} /></span><span className="sl-t">{tx("Paying with member credit")}<span className="sl-d">{credit >= shownTotal ? tx("{a} now → {b} after this order", { a: formatMoney(credit), b: formatMoney(credit - shownTotal) }) : tx("Not enough credit: {amt} available.", { amt: formatMoney(credit) })}</span></span></div>
          ) : (
          <button className="sum-link-row" onClick={() => setScreen("payment")}><span className="sl-ic"><Icon name="card" size={21} /></span><span className="sl-t">{t("payMethodW", "Payment method")}<span className="sl-d">{tx("Chosen at the payment step")}</span></span><span className="sl-v">{t("chooseLater", "Choose later")}</span><span className="chev"><Icon name="chevR" size={16} /></span></button>
          )}
          <div className="sum-link-row" style={{ cursor: "default" }}><span className="sl-ic"><Icon name="pin" size={21} /></span><span className="sl-t">{dine ? `${channel?.name} · ${spot || tx("no table yet")}` : `${channel?.name} · Pickup counter`}<span className="sl-d">{info.outletName}</span></span></div>
        </div>
        {detailsCard}
        {dine && !tableLocked && (
          <div className="e2e-card"><h3>{t("typeTableW", "Table")}</h3><div className="e2e-field"><label htmlFor="sum-table">{tx("Table number")}</label>
            {tableList.length ? (
              <select className="e2e-input" id="sum-table" value={spot} onChange={(e) => { changeTable(e.target.value); }}><option value="">{tx("Choose your table")}</option>{tableList.map((x) => <option key={x}>{x}</option>)}</select>
            ) : (
              <input className="e2e-input" id="sum-table" value={spot} maxLength={30} placeholder={tx("e.g. Table 12")} onChange={(e) => setSpot(e.target.value)} />
            )}
          </div></div>
        )}
        {!member && info.membersOnly && (
          <button className="e2e-cta" onClick={() => setScreen("login")}><span>{tx("Sign in with your phone to order")}</span><Icon name="arrowR" size={19} /></button>
        )}
        {!member && !info.membersOnly && (
          <div className="summary-guest-row" role="group" aria-label={tx("Sign up or check out as guest")}>
            <button className="summary-signup-btn" onClick={() => setScreen("login")}><span>{t("signUpBtn", "Sign up")}</span></button>
            <button className="summary-guest-btn" aria-pressed={guestOk} onClick={() => setGuestForm(true)}><span>{t("checkoutGuest", "Check out as guest")}</span></button>
          </div>
        )}
        {(member ? !phoneOk : !info.membersOnly && guestForm) && (
          <div className="e2e-card guest-inline">
            <h3>{t("beforeOrder", "Before you order")}</h3>
            <p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>{tx("Enter your phone number to place this order. For takeaway, your")} <b>{tx("collection number comes from this number")}</b> {tx("— watch for it on the counter screen.")}</p>
            <div className="e2e-field"><label htmlFor="g-name">{tx("Name (optional)")}</label><input className="e2e-input" id="g-name" value={name} maxLength={40} autoComplete="name" onChange={(e) => setName(e.target.value)} /></div>
            <div className="e2e-field"><label htmlFor="g-phone">{t("phoneReq", "Phone number (required)")}</label><input className="e2e-input" id="g-phone" type="tel" inputMode="tel" value={phone} maxLength={20} placeholder={tx("e.g. +65 9123 4567")} autoComplete="tel" onChange={(e) => setPhone(e.target.value)} /></div>
            {phone !== "" && !phoneOk && <p className="login-err" role="alert">{tx("That number doesn't look right.")}</p>}
            {!member && <button className="e2e-cta" disabled={!phoneOk} onClick={() => { setGuestOk(true); setGuestForm(false); }}><span>{t("continueW", "Continue")}</span><Icon name="arrowR" size={19} /></button>}
          </div>
        )}
        {rewardsOn && !member && guestOk && <p className="e2e-note">{t("guestNoPoints", "Continuing as guest — no points will be earned on this order.")}</p>}
        <div id="sum-end" />
        {info.membersOnly && member ? (
          <div className="pay-sticky">
            {noteEl}
            {dine && !spot && <p className="e2e-sub">{tx("Choose your table to continue.")}</p>}
            {credit < shownTotal && <p className="e2e-sub">{tx("Your credit is not enough for this order. Please top up at the counter.")}</p>}
            <button className={`e2e-cta ${canOrder && (!dine || !!spot) && credit >= shownTotal ? "" : "off"}`} disabled={!canOrder || (dine && !spot) || credit < shownTotal || busy} onClick={() => void place()}>
              <span>{busy ? tx("Placing your order…") : tx("Pay with credit")}</span><span>{formatMoney(shownTotal)}</span>
            </button>
          </div>
        ) : (
        <button className={`e2e-cta ${canOrder && (!dine || !!spot) ? "" : "off"}`} disabled={!canOrder || (dine && !spot)} onClick={() => setScreen("checkout")}>
          <span>{tx(count === 1 ? "Order Now · {n} item" : "Order Now · {n} items", { n: count })}</span><span>{formatMoney(shownTotal)}</span>
        </button>
        )}
        {!canOrder && <p className="e2e-sub">{member ? "Add your phone number to place this order." : "Tap Sign up, or Check out as guest, to place this order."}</p>}
      </div>
    </>
  ) : null;

  /* ================= Checkout ================= */
  const checkoutScreen = quote?.ok ? (
    <>
      {pageHead(tx("Checkout"))}
      <div className="e2e-scroll shop-body">
        {back("Back to order summary", "summary")}
        <div className="e2e-card"><h3>{t("orderSummaryCard", "Order summary")}</h3>{itemRows(false)}</div>
        <div className="e2e-card"><h3>{tx("Charges & rewards")}</h3>{totalsRows(quote)}</div>
        {detailsCard}
        <button className="e2e-cta" onClick={() => setScreen("payment")}><span>{t("jumpPay", "Proceed to payment")}</span><span>{formatMoney(shownTotal)}</span></button>
      </div>
    </>
  ) : null;

  /* ================= Payment ================= */
  const paymentScreen = quote?.ok ? (
    <>
      {pageHead(tx("Payment"))}
      <div className="e2e-scroll shop-body">
        {busy ? (
          <>
            <div className="spinner" aria-hidden="true" />
            <h2 className="e2e-title" style={{ fontSize: 21 }}>{tx("Placing your order…")}</h2>
            <p className="e2e-sub">{t("processingD", "Please wait — do not close this screen.")}</p>
          </>
        ) : (
          <>
            {back("Back to order summary", "summary")}
            {noteEl}
            <div className="e2e-card"><h3>{t("totalToPay", "Total to pay")}</h3><div className="sum-row grand" style={{ border: 0, margin: 0, padding: 0 }}><span className="k">{t("total", "Total")}</span><span className="v">{formatMoney(shownTotal)}</span></div></div>
            {member && (() => {
              const enough = credit >= shownTotal;
              return (
                <button className="pay-opt" aria-pressed={payMethod === "credit"} disabled={!enough} style={enough ? undefined : { opacity: 0.6 }} onClick={() => setPayMethod("credit")}>
                  <span style={{ display: "flex", color: "var(--orange-dark)" }}><Icon name="stack" size={24} /></span>
                  <span className="pt"><b>{tx("Member credit")}</b><span>{enough ? tx("{amt} available. Paid now, and sent straight to the kitchen.", { amt: formatMoney(credit) }) : tx("Not enough credit: {amt} available.", { amt: formatMoney(credit) })}</span></span>
                  {enough && <span className="radio" />}
                </button>
              );
            })()}
            {info.membersOnly && member && credit < shownTotal && <p className="e2e-note" role="alert">{tx("Your credit is not enough for this order. Please top up at the counter.")}</p>}
            {!info.membersOnly && ([["card", "Card", "Debit or credit card.", "card"], ["paynow", "PayNow", "Pay with PayNow QR.", "stack"]] as const).map(([m, title, desc, ic]) => {
              const on = info.payments.online;
              return (
                <button key={m} className="pay-opt" aria-pressed={on && payMethod === m} disabled={!on} style={on ? undefined : { opacity: 0.5 }} onClick={() => setPayMethod(m)}>
                  <span style={{ display: "flex", color: "var(--orange-dark)" }}><Icon name={ic} size={24} /></span>
                  <span className="pt"><b>{title}</b><span>{on ? desc : "Not available yet"}</span></span>
                  {on && <span className="radio" />}
                </button>
              );
            })}
            {!info.membersOnly && <button className="pay-opt" aria-pressed={payMethod === "counter"} onClick={() => setPayMethod("counter")}><span style={{ display: "flex", color: "var(--orange-dark)" }}><Icon name="ticket" size={24} /></span><span className="pt"><b>{info.paymentTiming === "prepay" ? "Pay at the counter" : "Cash on pickup"}</b><span>{info.paymentTiming === "prepay" ? "Quote your number at the counter. We start your order once it is paid." : "Pay at the counter when you collect."}</span></span><span className="radio" /></button>}
            <button className={`e2e-cta ${canOrder && (!dine || !!spot) ? "" : "off"}`} disabled={!canOrder || (dine && !spot) || (!!info.membersOnly && credit < shownTotal)} onClick={() => void place()}><span>{payMethod === "counter" ? "Place order" : payMethod === "credit" ? tx("Pay with credit") : "Pay"} · {formatMoney(shownTotal)}</span><Icon name="arrowR" size={19} /></button>
          </>
        )}
      </div>
    </>
  ) : null;

  const body =
    screen === "rewards" ? rewardsScreen :
    screen === "account" ? accountScreen :
    screen === "bag" ? bagScreen :
    screen === "summary" ? summaryScreen :
    screen === "checkout" ? checkoutScreen :
    screen === "payment" ? paymentScreen :
    orderScreen;

  return (
    <>
      {body ?? (
        <div className="shop-msg"><p>{t("bagEmptyShort", "Your bag is empty.")}</p><button className="shop-primary" onClick={() => setScreen("order")}>{t("backToOrder", "Back to Order")}</button></div>
      )}
      {walletSheet}
      {langSheet}
      {picking && (
        <OptionSheet
          name={picking.name}
          description={picking.description}
          photoUrl={photo(picking)}
          baseCents={picking.priceCents}
          groups={picking.options!}
          onClose={() => setPicking(null)}
          onAdd={(sel) => { addLine(picking, sel); setPicking(null); }}
        />
      )}
      {nav}
    </>
  );
}

const COUNTRIES: Array<[string, string, string]> = [
  ["65", "SG", "Singapore"], ["60", "MY", "Malaysia"], ["62", "ID", "Indonesia"], ["66", "TH", "Thailand"], ["63", "PH", "Philippines"], ["84", "VN", "Vietnam"],
  ["852", "HK", "Hong Kong"], ["86", "CN", "China"], ["91", "IN", "India"], ["61", "AU", "Australia"], ["44", "GB", "United Kingdom"], ["1", "US", "United States / Canada"], ["81", "JP", "Japan"], ["82", "KR", "South Korea"],
  ["234", "NG", "Nigeria"], ["233", "GH", "Ghana"], ["254", "KE", "Kenya"], ["27", "ZA", "South Africa"], ["20", "EG", "Egypt"], ["971", "AE", "United Arab Emirates"], ["966", "SA", "Saudi Arabia"], ["90", "TR", "Turkey"],
  ["92", "PK", "Pakistan"], ["880", "BD", "Bangladesh"], ["94", "LK", "Sri Lanka"], ["977", "NP", "Nepal"], ["673", "BN", "Brunei"], ["855", "KH", "Cambodia"], ["95", "MM", "Myanmar"], ["856", "LA", "Laos"], ["886", "TW", "Taiwan"], ["853", "MO", "Macau"],
  ["64", "NZ", "New Zealand"], ["49", "DE", "Germany"], ["33", "FR", "France"], ["39", "IT", "Italy"], ["34", "ES", "Spain"], ["31", "NL", "Netherlands"], ["353", "IE", "Ireland"], ["7", "RU", "Russia"], ["55", "BR", "Brazil"], ["52", "MX", "Mexico"],
];

/** The prototype's Welcome screen: Google, Microsoft, email, phone (by text message) or guest. */
function Login({ info, welcome, loginError, onGuest, onDone }: { info: Info; welcome: number; loginError: string | null; onGuest: () => void; onDone: (token: string) => void }) {
  const [view, setView] = useState<"home" | "email" | "otp" | "phone" | "sms">("home");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [cc, setCc] = useState("65");
  const [local, setLocal] = useState("");
  const [sms, setSms] = useState<{ id: string; code: string; to: string; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(loginError);
  const [done, setDone] = useState(false);
  const post = (url: string, body: object) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const finish = (token: string) => {
    setDone(true);
    window.setTimeout(() => onDone(token), 900);
  };
  const { google, microsoft, phone: phoneOn } = info.auth;
  const provider = (p: "google" | "microsoft", on: boolean, label: string) => {
    if (!on) return setErr(tx("{label} sign-in isn't set up for this shop yet. Please use Email, or continue as guest.", { label }));
    location.href = `/api/shop/auth/oauth/${p}/start`;
  };

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post("/api/shop/auth/email/start", { email });
      const j = (await r.json().catch(() => ({}))) as { devCode?: string };
      if (!r.ok) setErr(r.status === 429 ? "Too many tries. Please wait a few minutes." : "That email doesn't look right.");
      else {
        setView("otp");
        if (j.devCode) setCode(j.devCode); // only outside production, where no email is sent yet
      }
    } catch {
      setErr(tx("No connection. Please try again."));
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post("/api/shop/auth/email/verify", { email, code, name: mode === "signup" ? name : "" });
      const j = (await r.json().catch(() => ({}))) as { token?: string };
      if (r.ok && j.token) finish(j.token);
      else setErr(tx("That code didn't work. Check it and try again, or ask for a new one."));
    } catch {
      setErr(tx("No connection. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  const fullPhone = `${cc}${local.replace(/\D/g, "").replace(/^0+/, "")}`;
  async function startSms() {
    setBusy(true);
    setErr(null);
    try {
      if (info.auth.phone?.open) {
        // Temporary open sign-in: the number is the key, with no text to send.
        const o = await post("/api/shop/auth/phone/open", { phone: fullPhone });
        const oj = (await o.json().catch(() => ({}))) as { token?: string };
        if (o.ok && oj.token) return finish(oj.token);
        return setErr(o.status === 429 ? "Too many tries. Please wait a few minutes." : tx("That number doesn't look right."));
      }
      const r = await post("/api/shop/auth/phone/start", { phone: fullPhone });
      const j = (await r.json().catch(() => ({}))) as { id?: string; code?: string; to?: string | null; expiresInSeconds?: number };
      if (r.ok && j.id) {
        setSms({ id: j.id, code: j.code!, to: j.to ?? "", left: j.expiresInSeconds ?? 300 });
        setView("sms");
      } else setErr(r.status === 429 ? "Too many tries. Please wait a few minutes." : tx("That number doesn't look right."));
    } catch {
      setErr(tx("No connection. Please try again."));
    } finally {
      setBusy(false);
    }
  }
  // While the text message screen is open: count down, and ask the server whether the text has arrived.
  useEffect(() => {
    if (view !== "sms" || !sms) return;
    let alive = true;
    const tick = window.setInterval(() => setSms((s) => (s && s.left > 0 ? { ...s, left: s.left - 1 } : s)), 1000);
    const poll = window.setInterval(async () => {
      const r = await fetch(`/api/shop/auth/phone/${sms.id}`).catch(() => null);
      if (!alive || !r?.ok) return;
      const j = (await r.json()) as { state: string; token?: string; secondsLeft?: number };
      if (j.state === "verified" && j.token) {
        alive = false;
        finish(j.token);
      } else if (j.state === "expired") setSms((s) => (s ? { ...s, left: 0 } : s));
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [view, sms?.id]);

  const back = <button className="e2e-back" onClick={() => { setView("home"); setErr(null); }}><Icon name="chevL" size={16} /> {tx("All sign-in options")}</button>;
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="e2e-scroll login-page">
      {info.brand.logoUrl && <img className="e2e-logo" src={info.brand.logoUrl} alt={info.name} />}
      {done ? (
        <>
          <div className="login-done"><Icon name="check" size={30} /></div>
          <h3 className="login-done-t">{mode === "signup" && view !== "sms" ? "Account created" : "Signed in"}</h3>
          <p className="e2e-sub">{tx("Taking you in…")}</p>
        </>
      ) : (
        <>
          <h2 className="e2e-title">{t("welcomeW", "Welcome")}</h2>
          <p className="e2e-sub">Sign in to order at {info.name} · {info.outletName}</p>
          {view === "home" && (
            <>
              {!info.membersOnly && (
              <div className="login-icons" role="group" aria-label={tx("Sign-in options")}>
                <button className="login-icon-btn" onClick={() => provider("google", google, "Google")} aria-label={tx("Continue with Google")}><span className="g-mark">G</span><span className="li-cap">Google</span></button>
                <button className="login-icon-btn" onClick={() => provider("microsoft", microsoft, "Microsoft")} aria-label={tx("Continue with Microsoft")}><span className="ms-grid"><i style={{ background: "#f25022" }} /><i style={{ background: "#7fba00" }} /><i style={{ background: "#00a4ef" }} /><i style={{ background: "#ffb900" }} /></span><span className="li-cap">Microsoft</span></button>
                <button className="login-icon-btn" onClick={() => { setErr(null); setView("email"); }} aria-label={tx("Continue with email")}><span className="li-mail"><Icon name="mail" size={26} /></span><span className="li-cap">{t("emailW", "Email")}</span></button>
              </div>
              )}
              <button className="login-btn" style={{ marginTop: 12 }} onClick={() => (phoneOn ? (setErr(null), setView("phone")) : setErr(tx("Phone sign-in isn't set up for this shop yet. Please use Email, or continue as guest.")))}><span className="lb-ic" style={{ color: "var(--orange-dark)" }}><Icon name="phone" size={24} /></span><span>{t("phoneNumT", "Phone number")}<span className="lb-sub">{info.auth.phone?.open ? tx("Enter your mobile number") : t("phoneSub", "Verify by sending an SMS from your phone")}</span></span></button>
              {err && <p className="login-err" role="alert">{err}</p>}
              {!info.membersOnly && (
              <button className="login-btn" style={{ marginTop: 12 }} onClick={onGuest}><span className="lb-ic" style={{ color: "var(--orange-dark)" }}><Icon name="bag" size={24} /></span><span>{t("guestCta", "Continue as guest")}<span className="lb-sub">{tx("Browse & order as guest — sign-up (or guest checkout) is asked at Order Summary")}</span></span></button>
              )}
            </>
          )}
          {view === "email" && (
            <>
              {back}
              <div className="e2e-card" style={{ marginTop: 2 }}>
                <h3>{mode === "signup" ? "Sign up with email" : "Login with email"}</h3>
                <div className="login-seg" role="group" aria-label={tx("Email login or sign up")}>
                  <button aria-pressed={mode === "login"} onClick={() => setMode("login")}>{t("signInW", "Sign in")}</button>
                  <button aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>{t("signUpBtn", "Sign up")}</button>
                </div>
                {mode === "signup" && <div className="e2e-field"><label htmlFor="em-name">{t("nameW", "Name")}</label><input className="e2e-input" id="em-name" value={name} maxLength={40} placeholder="Your name" autoComplete="name" onChange={(e) => setName(e.target.value)} /></div>}
                <div className="e2e-field"><label htmlFor="em-email">{t("emailW", "Email")}</label><input className="e2e-input" id="em-email" type="email" inputMode="email" value={email} maxLength={120} placeholder="you@example.com" autoComplete="email" onChange={(e) => setEmail(e.target.value)} /></div>
                {err && <p className="login-err" role="alert">{err}</p>}
                <button className="e2e-cta" disabled={busy || !email.includes("@")} onClick={() => void start()}><span>{busy ? "Sending…" : "Send OTP"}</span><Icon name="arrowR" size={19} /></button>
                <p className="e2e-note">{tx("We'll send a one-time code to your email so you can enter it back here.")}{mode === "signup" && welcome > 0 ? tx(" New members get {n} points.", { n: welcome }) : ""}</p>
              </div>
            </>
          )}
          {view === "otp" && (
            <>
              {back}
              <div className="e2e-card" style={{ marginTop: 2 }}>
                <h3>{t("enterOtp", "Enter your OTP")}</h3>
                <p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>Code sent to {email}</p>
                <div className="e2e-field"><label htmlFor="em-otp">{t("oneTimeCode", "One-time code")}</label><input className="e2e-input" id="em-otp" inputMode="numeric" maxLength={6} value={code} placeholder="6-digit code" autoComplete="one-time-code" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></div>
                {err && <p className="login-err" role="alert">{err}</p>}
                <button className="e2e-cta" disabled={busy || code.length !== 6} onClick={() => void verify()}><span>{busy ? "Checking…" : mode === "signup" ? "Verify & create account" : "Verify & sign in"}</span><Icon name="arrowR" size={19} /></button>
              </div>
            </>
          )}
          {view === "phone" && (
            <>
              {back}
              <div className="e2e-card" style={{ marginTop: 2 }}>
                <h3>{t("phoneNumT", "Phone number")}</h3>
                {!info.auth.phone?.open && <p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>{tx("We verify your number by having you send us a short text from it. No code is sent to you.")}</p>}
                <div className="e2e-field"><label htmlFor="ph-num">{t("mobileNum", "Mobile number")}</label>
                  <div className="phone-row">
                    <select className="cc-select" id="ph-cc" value={cc} aria-label="Country code" onChange={(e) => setCc(e.target.value)}>{COUNTRIES.map(([d, , n]) => <option key={n} value={d}>+{d} {n}</option>)}</select>
                    <input className="e2e-input" id="ph-num" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="9123 4567" value={local} onChange={(e) => setLocal(e.target.value)} />
                  </div>
                </div>
                {err && <p className="login-err" role="alert">{err}</p>}
                <button className="e2e-cta" disabled={busy || local.replace(/\D/g, "").length < 6} onClick={() => void startSms()}><span>{busy ? "Starting…" : "Continue"}</span><Icon name="arrowR" size={19} /></button>
              </div>
            </>
          )}
          {view === "sms" && sms && (
            <>
              {back}
              <div className="e2e-card" style={{ marginTop: 2 }}>
                <h3 style={{ textAlign: "center" }}>{tx("Verify by SMS")}</h3>
                <p className="sms-step">{tx("1. Using the number")} <b>+{fullPhone}</b></p>
                {sms.to ? <p className="sms-step">{tx("2. Send the message")} <span className="sms-code">{sms.code}</span> to <b>{sms.to}</b></p> : <p className="sms-step">{tx("Texting is not available right now. Please ask a member of staff to approve you.")}</p>}
                {sms.left > 0 ? (
                  <>
                    <p className="sms-exp">{tx("This code will expire in")} <span className="sms-count">{clock(sms.left)}</span></p>
                    {sms.to && <a className="e2e-cta" style={{ textDecoration: "none" }} href={`sms:${sms.to.replace(/\s/g, "")}?&body=${sms.code}`}><span>{tx("Send from this device")}</span></a>}
                    <p className="e2e-note">{tx("Waiting for your text… this page signs you in the moment it arrives.")}</p>
                    <p className="e2e-note">{tx("Text not arriving? Ask a member of staff to approve you.")}</p>
                    {info.auth.phone?.simulated && (
                      <button className="login-btn" style={{ justifyContent: "center", marginTop: 10 }} onClick={() => void post("/api/shop/auth/phone/simulate", { phone: fullPhone, code: sms.code })}><span>Developer: pretend the text arrived</span></button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="login-err" role="alert">{tx("That code has expired.")}</p>
                    <button className="e2e-cta" onClick={() => void startSms()}><span>{t("genNewCode", "Generate a new code")}</span><Icon name="arrowR" size={19} /></button>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Status({ orderId, info }: { orderId: string; info: Info }) {
  const [o, setO] = useState<OrderView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [working, setWorking] = useState(false);

  const load = async () => {
    try {
      const res = await fetch(`/api/shop/orders/${orderId}`);
      if (res.status === 404) return setProblem(tx("We can't find that order."));
      if (!res.ok) return setProblem(tx("Couldn't refresh. Retrying…"));
      setO((await res.json()) as OrderView);
      setProblem(null);
    } catch {
      setProblem(tx("No connection. Retrying…"));
    }
  };
  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) void load(); };
    run();
    const t = window.setInterval(run, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [orderId]);

  async function cancel() {
    setWorking(true);
    const r = await fetch(`/api/shop/orders/${orderId}/cancel`, { method: "POST" }).catch(() => null);
    setConfirmCancel(false);
    setWorking(false);
    if (r?.ok) await load();
    else setProblem(tx("This order can no longer be cancelled."));
  }
  async function pay(method: "card" | "paynow") {
    setWorking(true);
    const j = await fetch(`/api/shop/orders/${orderId}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method }) })
      .then((r) => r.json() as Promise<{ url?: string }>)
      .catch(() => ({}) as { url?: string });
    setWorking(false);
    if (j.url) location.href = j.url;
    else setProblem(tx("Online payment isn't available right now. You can pay at the counter."));
  }

  const goBack = () => { location.hash = "#/shop"; };
  const head = <div className="shop-headwrap"><h2 className="page-title" style={{ padding: "14px 16px 10px" }}>{t("orderStatusW", "Order status")}</h2></div>;
  if (!o) return <>{head}<div className="e2e-scroll shop-body"><button className="e2e-back" onClick={goBack}><Icon name="chevL" size={16} /> {tx("Back")}</button><p className="e2e-sub">{problem ?? "Loading your order…"}</p></div></>;
  const text = STATUS_TEXT[o.status];
  const step = STEPS.indexOf(o.status);
  const cancelled = o.status === "cancelled";
  const paid = o.paidCents >= o.totalCents;
  return (
    <>
      {head}
      <div className="e2e-scroll shop-body">
        <button className="e2e-back" onClick={goBack}><Icon name="chevL" size={16} /> {tx("Back")}</button>
        <p className="e2e-sub" style={{ marginTop: 2 }}>{cancelled ? tx("Order cancelled") : paid ? "Payment successful" : tx("Order sent")}</p>
        <div className="status-coll-label">{t("collectionNo", "Collection number")}</div>
        <div className="status-headline" aria-label={tx("Your number is {n}", { n: o.queueNumber })}>{o.queueNumber}</div>
        <p className="status-coll-hint">Your collection number is {o.queueNumber} — watch for it on the counter screen</p>
        <div className="status-order-row">
          <span className="status-order-line">{tx("Order")} <span className="status-id">{o.orderId}</span></span>
          <button className="copy-id-btn" onClick={() => { void navigator.clipboard?.writeText(o.orderId).then(() => setCopied(true)).catch(() => undefined); }}><Icon name="ticket" size={15} />{copied ? "ORDER ID copied" : "Copy ORDER ID"}</button>
        </div>
        {o.channelName && <p className="e2e-sub">{o.channelName}{o.spot ? ` · ${o.spot}` : ""}</p>}
        {cancelled ? (
          <div className="e2e-card" style={{ borderColor: "#f2c4b8", background: "#fdf0ec" }}><h3 style={{ color: "#b03a26" }}>{text.title}</h3><p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>{text.body(o)}</p></div>
        ) : (
          <div className="e2e-card">
            <div className="status-steps">
              {STEPS.map((s, idx) => {
                const cls = idx < step ? "done" : idx === step ? "now" : "";
                return (
                  <div key={s} className={`status-step ${cls}`}>
                    <span className="dot">{idx < step ? "✓" : idx + 1}</span>
                    <span><span className="st-t">{STATUS_TEXT[s].title.split(":")[0]}</span><br /><span className="st-d">{idx === step ? text.body(o) : idx < step ? t("done", "Done") : "—"}</span></span>
                  </div>
                );
              })}
            </div>
            <p className="e2e-note" style={{ marginTop: 2 }}>{tx("Status updates automatically.")}</p>
          </div>
        )}
        {!cancelled && o.canPayOnline && info.payments.online && (
          <div className="e2e-card">
            <h3>{tx("Pay now")}</h3>
            <p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>{formatMoney(o.totalCents - o.paidCents)} to pay. Or pay at the counter.</p>
            <button className="e2e-cta" disabled={working} onClick={() => void pay("card")}><span>{tx("Pay by card")}</span><Icon name="card" size={19} /></button>
            <button className="e2e-cta queue-btn" disabled={working} onClick={() => void pay("paynow")}><span>{tx("Pay with PayNow")}</span><Icon name="stack" size={19} /></button>
          </div>
        )}
        <div className="e2e-card">
          <h3>{t("itemsCardT", "Items")}</h3>
          {o.items.map((i, n) => (
            <div key={n} className="sum-row"><span className="k">{i.name} × {i.qty}{i.options.length > 0 && <small className="muted" style={{ display: "block" }}>{i.options.join(" · ")}</small>}</span><span className="v">{formatMoney(i.qty * i.unitCents)}</span></div>
          ))}
          <div className="sum-row grand"><span className="k">{t("total", "Total")}</span><span className="v">{formatMoney(o.totalCents)}</span></div>
        </div>
        {o.canCancel && (confirmCancel ? (
          <div className="e2e-card" style={{ borderColor: "#f2c4b8" }}>
            <h3>{tx("Cancel this order?")}</h3>
            <p className="e2e-sub" style={{ textAlign: "left", margin: 0 }}>{tx("Points or a coupon you used will be returned.")}</p>
            <button className="login-btn" disabled={working} style={{ justifyContent: "center", color: "#b03a26", borderColor: "#f2c4b8" }} onClick={() => void cancel()}><span>{tx("Yes, cancel my order")}</span></button>
            <button className="login-btn" style={{ justifyContent: "center", marginTop: 8 }} onClick={() => setConfirmCancel(false)}><span>{tx("Keep my order")}</span></button>
          </div>
        ) : (
          <button className="login-btn" style={{ justifyContent: "center", color: "#b03a26", borderColor: "#f2c4b8", marginTop: 10 }} onClick={() => setConfirmCancel(true)}><span>{t("cancelOrder", "Cancel order")}</span></button>
        ))}
        {problem && <div className="shop-note">{problem}</div>}
        <a className="login-btn" style={{ justifyContent: "center", marginTop: 10, textDecoration: "none" }} href="#/shop?tab=account">{tx("View in Account")}</a>
        <a className="e2e-cta" style={{ textDecoration: "none" }} href="#/shop" onClick={() => localStorage.removeItem(LS_LAST)}><span>{t("backToOrder", "Back to Order")}</span><Icon name="arrowR" size={19} /></a>
      </div>
    </>
  );
}
