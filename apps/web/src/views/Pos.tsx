import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  confirmedPaid,
  formatMoney,
  formatQueueNumber,
  newId,
  nextQueueCounter,
  orderTotals,
  splitEqual,
  priceOrder,
  fulfilmentOf,
  menuFor,
  optionLines,
  comboSaving,
  isCombo,
  priceRange,
  resolveOptions,
  staffDiscountCents,
  type StaffDiscount,
  type BusinessConfig,
  type ChosenOption,
  type ChosenOptionInput,
  type Catalog,
  type MenuEntry,
  type PaymentMethod,
  type OrderState,
} from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { deviceId, getDeviceCode, record } from "../db";
import { useOrders } from "../hooks";
import { OptionSheet } from "./OptionSheet";
import { getBalance, spend } from "../wallet";
import { syncNow } from "../sync";
import { useShift, useShiftRequired } from "../shift";
import { ShiftBar } from "./ShiftBar";
import { DiscountSheet, type DiscountChoice } from "./DiscountSheet";
import { NoteSheet } from "./NoteSheet";

interface BagLine {
  /** The item and its chosen options: the same item with different options is a different line. */
  key: string;
  item: MenuEntry;
  qty: number;
  selection: ChosenOptionInput[];
  options: ChosenOption[];
  /** One unit, options included. */
  unitCents: number;
  /** A price set by hand for this line (the list price stays in `unitCents`), and discounts given on it. */
  override?: { unitCents: number; reason: string; approver?: { id: string; name: string } };
  discounts?: Array<{ id: string; kind: "percent" | "amount"; value: number; reason: string; approver?: { id: string; name: string } }>;
  /** A note for the kitchen on this item ("no ice"). */
  note?: string;
}
type BillDiscount = { id: string; kind: "percent" | "amount"; value: number; reason: string; approver?: { id: string; name: string } };
const effUnit = (b: BagLine) => b.override?.unitCents ?? b.unitCents;

const TABLES = ["Table 5", "Table 12", "Table 18", "Bar Tab 2", "Bar Tab 4"];
const startOfDay = () => new Date().setHours(0, 0, 0, 0);

interface PosProps {
  config: BusinessConfig;
  catalog: Catalog;
  online: boolean;
  customerId: string;
  setCustomerId: (id: string) => void;
}

export function Pos({ config, catalog, online, customerId, setCustomerId }: PosProps) {
  const orders = useOrders();
  const [bag, setBag] = useState<BagLine[]>([]);
  const [billDiscounts, setBillDiscounts] = useState<BillDiscount[]>([]);
  const [sheet, setSheet] = useState<null | { scope: "line"; key: string } | { scope: "bill" }>(null);
  const [orderNote, setOrderNote] = useState("");
  const [noteFor, setNoteFor] = useState<null | { scope: "line"; key: string } | { scope: "order" }>(null);
  const [category, setCategory] = useState("All");
  const channels = catalog.channels.filter((c) => c.active);
  const [chosenChannel, setChosenChannel] = useState<string>(channels[0]?.id ?? "");
  // If the chosen channel was removed or switched off while the app was open, use the first one.
  const channel = channels.find((c) => c.id === chosenChannel) ?? channels[0]!;
  const channelId = channel.id;
  const fulfilment = fulfilmentOf(channel.kind);
  const [spot, setSpot] = useState(TABLES[1]!);
  const [flash, setFlash] = useState<string | null>(null);
  const staff = useStaff();
  const [balance, setBalance] = useState<number | null>(null);
  const [paying, setPaying] = useState(false);
  const shift = useShift();
  const shiftRequired = useShiftRequired();
  const mustOpenShift = shiftRequired && !shift; // the shop wants a shift open before any payment
  const payLock = useRef(false); // set synchronously, so a fast double-tap cannot start two charges

  // Direct PayNow QR: the order goes to the server first, then the server issues a QR for what is owed and confirms it from the bank's alert.
  const [qrReady, setQrReady] = useState(false);
  const [qrPay, setQrPay] = useState<null | { orderId: string; paymentId: string; img: string; expiresAt: number; amountCents: number; name: string; paid: boolean }>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!staff || !online) { setQrReady(false); return; }
    let alive = true;
    void staffFetch("/api/settings/paynow").then(async (r) => { if (alive && "res" in r && r.res.ok) setQrReady(!!((await r.res.json()) as { config: unknown }).config); });
    return () => { alive = false; };
  }, [staff, online]);
  useEffect(() => {
    if (!qrPay || qrPay.paid) return;
    const tick = window.setInterval(() => setClock(Date.now()), 1000);
    const poll = window.setInterval(async () => {
      const res = await fetch(`/api/payments/paynow/status/${qrPay.paymentId}`).catch(() => null);
      if (res?.ok && ((await res.json()) as { state: string }).state === "PAID") { setQrPay((q) => (q ? { ...q, paid: true } : q)); void syncNow(); }
    }, 2000);
    return () => { window.clearInterval(tick); window.clearInterval(poll); };
  }, [qrPay?.paymentId, qrPay?.paid]);

  async function askQr(orderId: string): Promise<boolean> {
    let r = await staffFetch("/api/payments/paynow/qr", { method: "POST", body: { orderId } });
    // The order may still be on its way to the server: send it again and retry once.
    if ("res" in r && r.res.status === 404) { await syncNow(); r = await staffFetch("/api/payments/paynow/qr", { method: "POST", body: { orderId } }); }
    if (!("res" in r) || !r.res.ok) { notify("Could not get a PayNow QR. Check the connection and the PayNow settings."); return false; }
    const j = (await r.res.json()) as { paymentId: string; payload: string; expiresAt: number; amountCents: number; displayName: string };
    setQrPay({ orderId, paymentId: j.paymentId, img: await QRCode.toDataURL(j.payload, { margin: 4, width: 520 }), expiresAt: j.expiresAt, amountCents: j.amountCents, name: j.displayName, paid: false });
    return true;
  }
  async function payWithQr() {
    if (!bag.length || qrBusy || payLock.current) return;
    payLock.current = true; setQrBusy(true);
    const orderId = newId();
    await place(null, orderId);
    await syncNow();
    await askQr(orderId);
    payLock.current = false; setQrBusy(false);
  }
  /** The customer is not paying by QR after all: cancel the order, or take cash instead. */
  async function closeQr(how: "cancel" | "cash" | "paynow" | "done") {
    if (!qrPay) return;
    if (how === "paynow" && !window.confirm(`Have you seen ${formatMoney(qrPay.amountCents)} arrive in the bank account?`)) return;
    if (how === "cancel") await record(qrPay.orderId, { type: "StageSet", stage: "cancelled" });
    if (how === "paynow") await record(qrPay.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "paynow", amountCents: qrPay.amountCents, confirmed: true });
    if (how === "cash") await record(qrPay.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "cash", amountCents: qrPay.amountCents, confirmed: true });
    setQrPay(null);
    if (how !== "done") void syncNow();
  }

  useEffect(() => {
    let alive = true;
    if (!customerId || !online || !staff) setBalance(null);
    else void getBalance(customerId).then((b) => alive && setBalance(b));
    return () => {
      alive = false;
    };
  }, [customerId, online, staff]);

  const notify = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 4000);
  };

  // Prices come from the catalog for this outlet + channel, resolved on the device (works offline).
  const menu = useMemo(() => menuFor(catalog, { outletId: config.outletName, channelId }), [catalog, config.outletName, channelId]);

  // Switching channel (or a price change arriving) reprices the bag; items the channel doesn't sell are dropped.
  useEffect(() => {
    setBag((cur) => {
      const next = cur.flatMap((l) => {
        const e = menu.find((m) => m.id === l.item.id);
        const r = e ? resolveOptions(e.options, l.selection) : null;
        return e && r?.ok ? [{ ...l, item: e, options: r.options, unitCents: e.priceCents + r.extraCents }] : [];
      });
      if (next.length < cur.length) notify(`${cur.length - next.length} item(s) removed: not sold in ${channel.name}.`);
      return next.length === cur.length && next.every((l, i) => l.unitCents === cur[i]!.unitCents && l.item.pricebookId === cur[i]!.item.pricebookId) ? cur : next;
    });
  }, [menu]);

  const categories = useMemo(() => ["All", ...new Set(menu.map((m) => m.category))], [menu]);
  const shown = menu.filter((m) => category === "All" || m.category === category);

  // Discounts staff gave: on a line (tied to its bag key) or on the whole bill.
  const staffDiscounts: StaffDiscount[] = [
    ...bag.flatMap((b) => (b.discounts ?? []).map((d): StaffDiscount => ({ id: d.id, scope: "line", lineId: b.key, kind: d.kind, value: d.value, reason: d.reason, at: 0 }))),
    ...billDiscounts.map((d): StaffDiscount => ({ id: d.id, scope: "bill", kind: d.kind, value: d.value, reason: d.reason, at: 0 })),
  ];
  const priced = priceOrder({
    lines: bag.map((b) => ({ name: b.item.name, unitCents: effUnit(b), qty: b.qty, pointsExempt: b.item.pointsExempt, bcrs: !!b.item.bcrs, taxInclusive: b.item.taxInclusive, taxGroup: b.item.taxGroup })),
    fulfilment,
    serviceCharge: channel.serviceCharge,
    discountCents: staffDiscountCents(bag.map((b) => ({ lineId: b.key, unitCents: effUnit(b), qty: b.qty })), staffDiscounts).totalCents,
    config: config.pricing,
  });

  /** A discount or price change the staff member chose (and a manager approved when needed). */
  function applyChoice(c: DiscountChoice) {
    const target = sheet;
    setSheet(null);
    if (!target) return;
    const mk = { id: newId(), reason: c.reason, ...(c.approver ? { approver: c.approver } : {}) };
    if (c.kind === "price") {
      if (target.scope === "line") { const o = { unitCents: c.value, reason: c.reason, ...(c.approver ? { approver: c.approver } : {}) }; setBag((cur) => cur.map((l) => (l.key === target.key ? { ...l, override: o } : l))); }
      return;
    }
    const d = { ...mk, kind: c.kind, value: c.value };
    if (target.scope === "bill") setBillDiscounts((cur) => [...cur, d]);
    else setBag((cur) => cur.map((l) => (l.key === target.key ? { ...l, discounts: [...(l.discounts ?? []), d] } : l)));
  }

  const [picking, setPicking] = useState<MenuEntry | null>(null);
  /** The bag line whose choices are being changed (hot to iced, an extra added). */
  const [editing, setEditing] = useState<BagLine | null>(null);

  /** Put an item in the bag with its chosen options (none for a plain item). */
  const addWith = (item: MenuEntry, selection: ChosenOptionInput[]) => {
    const r = resolveOptions(item.options, selection);
    if (!r.ok) return;
    const key = `${item.id}#${r.key}`;
    setBag((cur) => {
      const found = cur.find((l) => l.key === key);
      return found ? cur.map((l) => (l === found ? { ...l, qty: l.qty + 1 } : l)) : [...cur, { key, item, qty: 1, selection, options: r.options, unitCents: item.priceCents + r.extraCents }];
    });
  };
  /**
   * Change the choices on a line already in the bag. It keeps its quantity, note and discounts, takes the new price, and joins another line
   * if it now matches one. A price set by hand is dropped (the extras changed, so the manager's price no longer fits).
   */
  const changeChoices = (old: BagLine, selection: ChosenOptionInput[]) => {
    const r = resolveOptions(old.item.options, selection);
    if (!r.ok) return;
    const key = `${old.item.id}#${r.key}`;
    const dropped = !!old.override && r.key !== old.key.split("#").slice(1).join("#");
    setBag((cur) => {
      const rest = cur.filter((x) => x.key !== old.key);
      const same = rest.find((x) => x.key === key);
      if (same) return rest.map((x) => (x.key === key ? { ...x, qty: x.qty + old.qty } : x));
      return cur.map((x) => (x.key === old.key ? { ...x, key, selection, options: r.options, unitCents: x.item.priceCents + r.extraCents, ...(dropped ? { override: undefined } : {}) } : x));
    });
    if (dropped) notify("The price you set no longer fits the new choices, so it was taken off.");
  };
  // An item with options (hot or cold, extras...) asks first; a plain one goes straight in.
  const add = (item: MenuEntry) => (item.options?.length ? setPicking(item) : addWith(item, []));
  const change = (key: string, d: number) => setBag((cur) => cur.map((l) => (l.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  /** Create the order in the local log. Nothing here needs the network. */
  async function place(payment: { method: PaymentMethod; confirmed: boolean } | null, existingOrderId?: string) {
    if (!bag.length) return;
    const orderId = existingOrderId ?? newId();
    const code = getDeviceCode();
    const todays = orders.filter((o) => o.openedAt >= startOfDay()).map((o) => o.queueNumber ?? "");
    const queueNumber = config.modules.queue ? formatQueueNumber(code, nextQueueCounter(code, todays)) : undefined;

    await record(orderId, {
      type: "OrderOpened",
      fulfilment,
      channelId,
      channelName: channel.name,
      serviceCharge: channel.serviceCharge,
      spot: channel.kind === "dine_in" ? spot : undefined,
      queueNumber,
    });
    const lineIds = new Map(bag.map((l) => [l.key, newId()]));
    for (const l of bag) {
      await record(orderId, {
        type: "ItemAdded",
        lineId: lineIds.get(l.key)!,
        productId: l.item.id,
        name: l.item.name,
        unitCents: l.unitCents,
        qty: l.qty,
        pointsExempt: l.item.pointsExempt,
        bcrs: !!l.item.bcrs,
        ...(l.item.taxInclusive !== undefined ? { taxInclusive: l.item.taxInclusive } : {}),
        ...(l.item.taxGroup ? { taxGroup: l.item.taxGroup } : {}),
        options: l.options.length || l.note ? [...l.options, ...(l.note ? [{ group: "Special request", name: `Note: ${l.note}`, qty: 1, priceCents: 0 }] : [])] : undefined,
      });
    }
    if (orderNote.trim()) await record(orderId, { type: "OrderNoted", note: orderNote.trim(), ...(staff ? { byName: staff.name } : {}) });
    // Prices changed by hand and discounts given, each with who gave it and who approved it.
    const who = (a?: { id: string; name: string }) => ({ ...(staff ? { byName: staff.name } : {}), ...(a ? { approvedBy: a.id, approvedByName: a.name } : {}) });
    for (const l of bag) {
      if (l.override) await record(orderId, { type: "LinePriceOverridden", lineId: lineIds.get(l.key)!, unitCents: l.override.unitCents, reason: l.override.reason, ...who(l.override.approver) });
      for (const d of l.discounts ?? []) await record(orderId, { type: "DiscountApplied", discountId: d.id, scope: "line", lineId: lineIds.get(l.key)!, kind: d.kind, value: d.value, reason: d.reason, ...who(d.approver) });
    }
    for (const d of billDiscounts) await record(orderId, { type: "DiscountApplied", discountId: d.id, scope: "bill", kind: d.kind, value: d.value, reason: d.reason, ...who(d.approver) });
    if (payment) {
      const paymentId = newId();
      await record(orderId, { type: "PaymentRecorded", paymentId, method: payment.method, amountCents: priced.total, confirmed: payment.confirmed });
      if (!payment.confirmed) {
        // MOCK gateway: stands in for the YeahPay callback until real credentials exist.
        window.setTimeout(() => void record(orderId, { type: "PaymentConfirmed", paymentId }), 1500);
      }
    }
    setBag([]);
    setBillDiscounts([]);
    setOrderNote("");
    notify(queueNumber ? `Order placed · queue number ${queueNumber}` : "Order placed");
  }

  /**
   * Charge prepaid credit first, then record the order. The order id doubles as the idempotency
   * key, so a retry after a dropped connection never charges the customer twice.
   */
  async function payWithCredit() {
    if (!bag.length || !customerId || payLock.current) return;
    payLock.current = true;
    setPaying(true);
    const orderId = newId();
    const r = await spend(customerId, priced.total, `order:${orderId}`, orderId, deviceId());
    payLock.current = false;
    setPaying(false);
    if (r.ok) {
      setBalance(r.balanceCents);
      await place({ method: "credit", confirmed: true }, orderId);
    } else if (r.reason === "insufficient_funds") {
      setBalance(r.balanceCents);
      notify(`Not enough credit: ${formatMoney(r.balanceCents)} available, ${formatMoney(priced.total)} needed.`);
    } else {
      notify(failText(r));
    }
  }

  /** Settle an open tab from credit. The payment id is the idempotency key. */
  async function settleTabWithCredit(o: OrderState, amountCents: number) {
    if (!customerId || payLock.current) return;
    payLock.current = true;
    setPaying(true);
    const paymentId = newId();
    const r = await spend(customerId, amountCents, `tab:${paymentId}`, o.orderId, deviceId());
    payLock.current = false;
    setPaying(false);
    if (r.ok) {
      setBalance(r.balanceCents);
      await record(o.orderId, { type: "PaymentRecorded", paymentId, method: "credit", amountCents, confirmed: true });
    } else if (r.reason === "insufficient_funds") {
      notify(`Not enough credit: ${formatMoney(r.balanceCents)} available.`);
    } else {
      notify(failText(r));
    }
  }

  const creditBlocked = !staff ? "Staff sign-in required" : !customerId ? "Enter a customer to use credit" : !online ? "Credit needs a connection" : "";

  /** Open tab being split: how many people are still to pay, and a custom amount being typed. */
  const [split, setSplit] = useState<{ orderId: string; n: number; custom: string } | null>(null);
  const payShare = async (o: OrderState, cents: number, method: "cash" | "credit") => {
    if (cents <= 0) return;
    if (method === "credit") await settleTabWithCredit(o, cents);
    else await record(o.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "cash", amountCents: cents, confirmed: true });
    setSplit((cur) => (cur && cur.orderId === o.orderId ? { ...cur, n: Math.max(1, cur.n - 1), custom: "" } : cur));
  };

  const openTabs = orders.filter((o) => o.stage !== "cancelled" && o.stage !== "completed" && !isSettled(o, config));
  const prepay = config.paymentTiming === "prepay";

  async function openDrawer() {
    const r = await staffFetch("/api/print/drawer", { body: { reason: "no sale" } });
    notify("res" in r && r.res.ok ? "Drawer opening." : "res" in r && r.res.status === 409 ? "No receipt printer has the cash drawer switched on. Ask a manager." : "Could not open the drawer.");
  }

  return (
    <div className="pos">
      <section className="menu">
        <div className="chips">
          {categories.map((c) => (
            <button key={c} className={`chip ${c === category ? "on" : ""}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="grid">
          {shown.map((m) => (
            <button key={m.id} className="item" disabled={m.soldOut} onClick={() => add(m)}>
              <span className="n">{m.name}</span>
              <span className="p">{m.soldOut ? "Sold out" : (() => {
                if (isCombo(m.options)) { const save = comboSaving(m.priceCents, m.options, (id) => menu.find((x) => x.id === id)?.priceCents ?? null); return `Combo ${formatMoney(m.priceCents)}${save > 0 ? ` · save ${formatMoney(save)}` : ""}`; }
                const [lo, hi] = priceRange(m.priceCents, m.options);
                return lo === hi ? formatMoney(lo) : `from ${formatMoney(lo)}`;
              })()}</span>
            </button>
          ))}
        </div>
      </section>

      {noteFor && (() => {
        const line = noteFor.scope === "line" ? bag.find((b) => b.key === noteFor.key) : undefined;
        if (noteFor.scope === "line" && !line) return null;
        return <NoteSheet title={line ? `Note · ${line.item.name}` : "Note for the whole order"} initial={line ? line.note ?? "" : orderNote} max={line ? 140 : 200} onClose={() => setNoteFor(null)} onSave={(t) => { if (line) setBag((cur) => cur.map((x) => (x.key === line.key ? { ...x, note: t || undefined } : x))); else setOrderNote(t); setNoteFor(null); }} />;
      })()}
      {sheet && (() => {
        const line = sheet.scope === "line" ? bag.find((b) => b.key === sheet.key) : undefined;
        if (sheet.scope === "line" && !line) return null;
        return <DiscountSheet target={line ? { scope: "line", name: line.item.name, unitCents: effUnit(line), qty: line.qty } : { scope: "bill", name: "bill", subtotalCents: priced.subtotal - priced.discountCents }} onApply={applyChoice} onClose={() => setSheet(null)} />;
      })()}
      {qrPay && (() => {
        const left = Math.max(0, Math.ceil((qrPay.expiresAt - clock) / 1000));
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", zIndex: 50 }}>
            <div style={{ background: "var(--bg, #fff)", color: "var(--fg, #111)", borderRadius: 14, padding: 20, width: "min(92vw, 420px)", textAlign: "center" }}>
              {qrPay.paid ? (
                <>
                  <h2>Paid {formatMoney(qrPay.amountCents)}</h2>
                  <p className="muted">The bank has confirmed it.</p>
                  <button className="primary" onClick={() => void closeQr("done")}>Done</button>
                </>
              ) : (
                <>
                  <h3>Scan to pay {formatMoney(qrPay.amountCents)}</h3>
                  <p className="muted">{qrPay.name}</p>
                  {left > 0 ? <img src={qrPay.img} alt="PayNow QR" width={260} height={260} /> : <p style={{ margin: "60px 0" }}><b>This QR has expired.</b></p>}
                  <p className="muted">{left > 0 ? `Waiting for the bank · valid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Make a new one if the customer still wants to pay."}</p>
                  <div className="row" style={{ justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
                    {left === 0 && <button className="primary sm" onClick={() => void askQr(qrPay.orderId)}>New QR</button>}
                    <button className="primary sm" onClick={() => void closeQr("paynow")}>Confirm PayNow received</button>
                    <button className="secondary sm" onClick={() => void closeQr("cash")}>Paid in cash</button>
                    <button className="secondary sm" onClick={() => void closeQr("cancel")}>Cancel order</button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}
      <aside className="bag">
        <ShiftBar />
        {flash && <div className="flash">{flash}</div>}
        <div className="seg">
          {channels.map((c) => (
            <button key={c.id} className={channelId === c.id ? "on" : ""} onClick={() => setChosenChannel(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
        {channel.kind === "dine_in" && (
          <select className="spot" value={spot} onChange={(e) => setSpot(e.target.value)}>
            {TABLES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        )}

        {staff && online && (
          <button className="secondary sm" type="button" onClick={() => void openDrawer()}>Open drawer</button>
        )}

        <label className="cust">
          <span>Customer</span>
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value.trim())} placeholder="phone / member code" inputMode="tel" />
          {customerId && <b className="balchip">{balance === null ? "—" : formatMoney(balance)}</b>}
        </label>

        <div className="lines">
          {bag.length === 0 && <p className="muted">Tap items to start an order.</p>}
          {bag.map((l) => (
            <div className="line" key={l.key}>
              <span className="nm">{l.item.name}{l.options.length > 0 && <small className="optline">{optionLines(l.options).join(" · ")}</small>}
                {l.override && <small className="optline">Price {formatMoney(l.unitCents)} → {formatMoney(l.override.unitCents)} · {l.override.reason} <button className="link" onClick={() => setBag((cur) => cur.map((x) => (x.key === l.key ? { ...x, override: undefined } : x)))}>undo</button></small>}
                {(l.discounts ?? []).map((d) => <small className="optline" key={d.id}>{d.kind === "percent" ? `${d.value}% off` : `${formatMoney(d.value)} off`} · {d.reason} <button className="link" onClick={() => setBag((cur) => cur.map((x) => (x.key === l.key ? { ...x, discounts: (x.discounts ?? []).filter((y) => y.id !== d.id) } : x)))}>remove</button></small>)}
                {l.note && <small className="optline"><b>Note: {l.note}</b></small>}
                {l.item.options?.length ? <button className="link" onClick={() => setEditing(l)}>Edit choices</button> : null}
                <button className="link" onClick={() => setNoteFor({ scope: "line", key: l.key })}>{l.note ? "Edit note" : "Note"}</button>
                {staff && <button className="link" onClick={() => setSheet({ scope: "line", key: l.key })}>Discount / price</button>}
              </span>
              <span className="step">
                <button onClick={() => change(l.key, -1)}>−</button>
                <b>{l.qty}</b>
                <button onClick={() => change(l.key, +1)}>+</button>
              </span>
              <span className="amt">{formatMoney(effUnit(l) * l.qty)}</span>
            </div>
          ))}
        </div>

        {bag.length > 0 && <button className="secondary sm" type="button" onClick={() => setNoteFor({ scope: "order" })}>{orderNote ? "Edit order note" : "Order note"}</button>}
        {orderNote && <p className="muted" style={{ margin: "4px 0" }}><b>Order note:</b> {orderNote}</p>}
        {staff && bag.length > 0 && <button className="secondary sm" type="button" onClick={() => setSheet({ scope: "bill" })}>Discount whole bill</button>}
        <dl className="totals">
          <div><dt>Subtotal</dt><dd>{formatMoney(priced.subtotal)}</dd></div>
          {priced.discountCents > 0 && <div><dt>Discount</dt><dd>-{formatMoney(priced.discountCents)}</dd></div>}
          {billDiscounts.map((d) => <div key={d.id}><dt><small>{d.kind === "percent" ? `${d.value}% off bill` : `${formatMoney(d.value)} off bill`} · {d.reason}</small></dt><dd><button className="link" onClick={() => setBillDiscounts((cur) => cur.filter((x) => x.id !== d.id))}>remove</button></dd></div>)}
          {priced.service > 0 && <div><dt>Service charge ({Math.round(config.pricing.serviceRate * 100)}%)</dt><dd>{formatMoney(priced.service)}</dd></div>}
          {priced.gst > 0 && <div><dt>GST</dt><dd>{formatMoney(priced.gst)}</dd></div>}
          {priced.bcrs > 0 && <div><dt>BCRS deposit</dt><dd>{formatMoney(priced.bcrs)}</dd></div>}
          <div className="grand"><dt>Total</dt><dd>{formatMoney(priced.total)}</dd></div>
        </dl>

        {prepay ? (
          <div className="pay">
            <button className="primary" disabled={!bag.length || mustOpenShift} title={mustOpenShift ? "Open your shift first" : undefined} onClick={() => void place({ method: "cash", confirmed: true })}>
              Cash · {formatMoney(priced.total)}
            </button>
            <button className="primary" disabled={!bag.length || !!creditBlocked || paying || mustOpenShift} title={mustOpenShift ? "Open your shift first" : creditBlocked} onClick={() => void payWithCredit()}>
              {paying ? "Charging…" : `Pay with credit · ${formatMoney(priced.total)}`}
            </button>
            {qrReady && (
            <button className="secondary" disabled={!bag.length || !online || qrBusy || mustOpenShift} onClick={() => void payWithQr()}>
              PayNow QR · {formatMoney(priced.total)}
            </button>
            )}
            <button
              className="secondary"
              disabled={!bag.length || !online || mustOpenShift}
              title={online ? "Mock gateway – confirms after 1.5s" : "Online payments need a connection"}
              onClick={() => void place({ method: "paynow", confirmed: false })}
            >
              PayNow / Card (mock) {online ? "" : "· needs network"}
            </button>
          </div>
        ) : (
          <div className="pay">
            <button className="primary" disabled={!bag.length} onClick={() => void place(null)}>
              {config.paymentTiming === "postpay" ? "Send to kitchen · open tab" : "Place order · pay later"}
            </button>
          </div>
        )}
      </aside>

      {!prepay && openTabs.length > 0 && (
        <section className="tabs">
          <h3>Open tabs</h3>
          {openTabs.map((o) => {
            const t = orderTotals(o, config);
            return (
              <div className="tab" key={o.orderId}>
                <div>
                  <b>{o.spot ?? o.channelName ?? (o.fulfilment === "takeaway" ? "Take away" : "Delivery")}</b>
                  <span className="muted"> · {o.queueNumber ?? "—"} · {o.lines.reduce((n, l) => n + l.qty, 0)} items</span>
                </div>
                <div className="tabr">
                  <span>{formatMoney(t.total - confirmedPaid(o))}</span>
                  <button
                    className="primary sm"
                    onClick={() =>
                      void record(o.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "cash", amountCents: t.total - confirmedPaid(o), confirmed: true })
                    }
                  >
                    Settle cash
                  </button>
                  <button
                    className="secondary sm"
                    disabled={!!creditBlocked || paying}
                    title={creditBlocked}
                    onClick={() => void settleTabWithCredit(o, t.total - confirmedPaid(o))}
                  >
                    Use credit
                  </button>
                  <button className="secondary sm" onClick={() => setSplit(split?.orderId === o.orderId ? null : { orderId: o.orderId, n: 2, custom: "" })}>
                    Split
                  </button>
                </div>
                {split?.orderId === o.orderId && (() => {
                  const remaining = t.total - confirmedPaid(o);
                  const shares = splitEqual(remaining, Array.from({ length: split.n }, (_, i) => `p${i}`), "p0");
                  const next = shares.p0 ?? 0; // the first share carries any extra cents
                  const custom = Math.round(parseFloat(split.custom || "0") * 100);
                  return (
                    <div className="split">
                      <div className="split-row">
                        <span>People still to pay</span>
                        <span className="step">
                          <button aria-label="Fewer people" onClick={() => setSplit({ ...split, n: Math.max(1, split.n - 1) })}>−</button>
                          <b>{split.n}</b>
                          <button aria-label="More people" onClick={() => setSplit({ ...split, n: Math.min(10, split.n + 1) })}>+</button>
                        </span>
                      </div>
                      <div className="split-row">
                        <span>Next share <b>{formatMoney(next)}</b> <small className="muted">of {formatMoney(remaining)} left</small></span>
                        <span>
                          <button className="primary sm" onClick={() => void payShare(o, next, "cash")}>Cash</button>{" "}
                          <button className="secondary sm" disabled={!!creditBlocked || paying} title={creditBlocked} onClick={() => void payShare(o, next, "credit")}>Credit</button>
                        </span>
                      </div>
                      <div className="split-row">
                        <span>Or an amount <input className="split-amt" inputMode="decimal" placeholder="0.00" value={split.custom} onChange={(e) => setSplit({ ...split, custom: e.target.value })} /></span>
                        <span>
                          <button className="primary sm" disabled={!(custom > 0 && custom <= remaining)} onClick={() => void payShare(o, custom, "cash")}>Cash</button>{" "}
                          <button className="secondary sm" disabled={!(custom > 0 && custom <= remaining) || !!creditBlocked || paying} onClick={() => void payShare(o, custom, "credit")}>Credit</button>
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </section>
      )}
      {editing && (
        <OptionSheet
          name={editing.item.name}
          description={editing.item.description}
          baseCents={editing.item.priceCents}
          groups={editing.item.options!}
          initial={editing.selection}
          cta="Save changes"
          onClose={() => setEditing(null)}
          onAdd={(sel) => {
            changeChoices(editing, sel);
            setEditing(null);
          }}
        />
      )}
      {picking && (
        <OptionSheet
          name={picking.name}
          description={picking.description}
          photoUrl={picking.imageVersion ? `/api/products/${picking.id}/image?v=${picking.imageVersion}` : null}
          baseCents={picking.priceCents}
          groups={picking.options!}
          cta="Add to order"
          onClose={() => setPicking(null)}
          onAdd={(sel) => {
            addWith(picking, sel);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

const failText = (r: { reason: string }) =>
  r.reason === "signin_required"
    ? "Your session has ended. Sign in again. The customer was not charged."
    : r.reason === "credit_frozen"
      ? "Member credit is frozen, so it can't be spent. Take cash instead. The customer was not charged."
    : r.reason === "not_allowed"
      ? "This account isn't allowed to take credit payments."
      : "Could not reach the server. The customer was not charged.";

function isSettled(o: OrderState, config: BusinessConfig) {
  const total = orderTotals(o, config).total;
  return o.lines.length > 0 && confirmedPaid(o) >= total;
}
