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
  checkStanding,
  nextCourse,
  reduceOrder,
  COURSE_NAMES,
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
import { allEvents, deviceId, getDeviceCode, record } from "../db";
import { useOrders } from "../hooks";
import { OptionSheet } from "./OptionSheet";
import { getBalance, spend } from "../wallet";
import { syncNow } from "../sync";
import { useShift, useShiftRequired } from "../shift";
import { ShiftBar } from "./ShiftBar";
import { DiscountSheet, type DiscountChoice } from "./DiscountSheet";
import { NoteSheet } from "./NoteSheet";
import "../till/till.css";
import { effUnit, type BagLine, type BillDiscount, type HeldOrder } from "../till/types";
import { TicketPanel } from "../till/TicketPanel";
import { TillMenu } from "../till/TillMenu";
import { ActionStrip, type Action } from "../till/ActionStrip";
import { PayPanel, type Tender, type TenderOption } from "../till/PayPanel";
import { Modal } from "../till/Modal";
import { CustomerDialog, DiningDialog, DoneDialog, GuestsDialog, HeldDialog, QuantityDialog, TillSettings } from "../till/Dialogs";
import { TEXT_SCALE, loadPrefs, setLayout, usePrefs } from "../prefs";
import { arrange, loadTillSettings, saveTill, useTillSettings, ACTION_POOL } from "../till/tillSettings";
import { queryParams } from "../nav";
import { isTraining } from "../training";
import { loadFloor, tableNames, useFloor } from "../floor";
import { TableMap } from "../till/TableMap";
import { ChecksBoard, SplitDialog } from "../till/Split";
import { askForBill, courseProgress, fireNextCourse, isSeatedOrder, mergeTables, tableInfo, transferTable } from "../till/tableOps";
import { RefundPanel } from "./RefundPanel";

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
  // The order being built stays on the device: a lock, a reload or a different cashier signing in finds it where it was.
  const [saved] = useState(() => { try { return JSON.parse(localStorage.getItem(isTraining() ? "pos.bag.practice" : "pos.bag") ?? "null") as { bag: BagLine[]; billDiscounts: BillDiscount[]; orderNote: string; orderId?: string } | null; } catch { return null; } });
  const [bag, setBag] = useState<BagLine[]>(() => saved?.bag ?? []);
  const [billDiscounts, setBillDiscounts] = useState<BillDiscount[]>(() => saved?.billDiscounts ?? []);
  const [sheet, setSheet] = useState<null | { scope: "line"; key: string } | { scope: "bill" }>(null);
  const [orderNote, setOrderNote] = useState(() => saved?.orderNote ?? "");
  /** The open order on screen, when this is a table's bill that was already sent (the sent lines are locked; new ones are added to it). */
  const [orderId, setOrderId] = useState<string | null>(() => saved?.orderId ?? null);
  const [view, setView] = useState<"order" | "tables" | "checks">(() => (queryParams().get("view") === "tables" ? "tables" : "order"));
  const [payCheckId, setPayCheckId] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<null | { scope: "line"; key: string } | { scope: "order" }>(null);
  useEffect(() => { try { localStorage.setItem(isTraining() ? "pos.bag.practice" : "pos.bag", JSON.stringify({ bag, billDiscounts, orderNote, orderId })); } catch { /* storage full: the order simply is not kept */ } }, [bag, billDiscounts, orderNote, orderId]);
  const channels = catalog.channels.filter((c) => c.active);
  const [chosenChannel, setChosenChannel] = useState<string>(channels[0]?.id ?? "");
  // If the chosen channel was removed or switched off while the app was open, use the first one.
  const channel = channels.find((c) => c.id === chosenChannel) ?? channels[0]!;
  const channelId = channel.id;
  const fulfilment = fulfilmentOf(channel.kind);
  const floor = useFloor();
  const [spot, setSpot] = useState("");
  const prefs = usePrefs();
  const till = useTillSettings();
  useEffect(() => { void loadPrefs(); void loadFloor(); void loadTillSettings(); }, [useStaff()?.code]);
  const [editLayoutAt, setEditLayoutAt] = useState(0);
  const [pax, setPax] = useState(1);
  const [payView, setPayView] = useState(false);
  const [dialog, setDialog] = useState<null | "dining" | "guests" | "qty" | "held" | "customer" | "settings" | "tabs" | "shift" | "table" | "line" | "seat">(null);
  const [lineKey, setLineKey] = useState<string | null>(null);
  const [pendingQty, setPendingQty] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [done, setDone] = useState<null | { queue?: string; change: number; total: number }>(null);
  const heldKey = isTraining() ? "pos.held.practice" : "pos.held";
  const [held, setHeld] = useState<HeldOrder[]>(() => { try { return JSON.parse(localStorage.getItem(heldKey) ?? "[]") as HeldOrder[]; } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(heldKey, JSON.stringify(held)); } catch { /* not kept */ } }, [held]);
  const [flash, setFlash] = useState<string | null>(null);
  const staff = useStaff();
  const [balance, setBalance] = useState<number | null>(null);
  const [paying, setPaying] = useState(false);
  const shift = useShift();
  const shiftRequired = useShiftRequired();
  const training = isTraining();
  const mustOpenShift = shiftRequired && !shift && !training; // the shop wants a shift open before any payment
  const payLock = useRef(false); // set synchronously, so a fast double-tap cannot start two charges

  // Direct PayNow QR: the order goes to the server first, then the server issues a QR for what is owed and confirms it from the bank's alert.
  const [qrReady, setQrReady] = useState(false);
  const [qrPay, setQrPay] = useState<null | { orderId: string; keep?: boolean; paymentId: string; img: string; expiresAt: number; amountCents: number; name: string; paid: boolean }>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!staff || !online || training) { setQrReady(false); return; }
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

  async function askQr(orderId: string, keep = false): Promise<boolean> {
    let r = await staffFetch("/api/payments/paynow/qr", { method: "POST", body: { orderId } });
    // The order may still be on its way to the server: send it again and retry once.
    if ("res" in r && r.res.status === 404) { await syncNow(); r = await staffFetch("/api/payments/paynow/qr", { method: "POST", body: { orderId } }); }
    if (!("res" in r) || !r.res.ok) { notify("Could not get a PayNow QR. Check the connection and the PayNow settings."); return false; }
    const j = (await r.res.json()) as { paymentId: string; payload: string; expiresAt: number; amountCents: number; displayName: string };
    setQrPay({ orderId, keep, paymentId: j.paymentId, img: await QRCode.toDataURL(j.payload, { margin: 4, width: 520 }), expiresAt: j.expiresAt, amountCents: j.amountCents, name: j.displayName, paid: false });
    return true;
  }
  async function payWithQr() {
    if (!bag.length || qrBusy || payLock.current) return;
    payLock.current = true; setQrBusy(true);
    const oid = orderId ?? newId();
    const keep = !!orderId; // a table's bill stays open if the QR is abandoned
    await place(null, oid);
    await syncNow();
    await askQr(oid, keep);
    setPayView(false);
    payLock.current = false; setQrBusy(false);
  }
  /** The customer is not paying by QR after all: cancel the order, or take cash instead. */
  async function closeQr(how: "cancel" | "cash" | "paynow" | "done") {
    if (!qrPay) return;
    if (how === "paynow" && !window.confirm(`Have you seen ${formatMoney(qrPay.amountCents)} arrive in the bank account?`)) return;
    if (how === "cancel" && !qrPay.keep) await record(qrPay.orderId, { type: "StageSet", stage: "cancelled" });
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
        if (l.sent) return [l];
        const e = menu.find((m) => m.id === l.item.id);
        const r = e ? resolveOptions(e.options, l.selection) : null;
        return e && r?.ok ? [{ ...l, item: e, options: r.options, unitCents: e.priceCents + r.extraCents }] : [];
      });
      if (next.length < cur.length) notify(`${cur.length - next.length} item(s) removed: not sold in ${channel.name}.`);
      return next.length === cur.length && next.every((l, i) => l.unitCents === cur[i]!.unitCents && l.item.pricebookId === cur[i]!.item.pricebookId) ? cur : next;
    });
  }, [menu]);

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
    const q = pendingQty;
    setPendingQty(1);
    setBag((cur) => {
      const found = cur.find((l) => l.key === key);
      return found ? cur.map((l) => (l === found ? { ...l, qty: l.qty + q } : l)) : [...cur, { key, item, qty: q, selection, options: r.options, unitCents: item.priceCents + r.extraCents }];
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

  /** The open order on screen, as the log knows it, and what is still owed on it (nothing has been paid on a new order). */
  const linked = orderId ? orders.find((o) => o.orderId === orderId) ?? null : null;
  const paidSoFar = linked ? confirmedPaid(linked) : 0;
  const due = Math.max(0, priced.total - paidSoFar);
  const checkDue = linked && payCheckId ? checkStanding(linked, payCheckId) : null;

  /**
   * Put what is on screen into the local log. A new order is opened; a table's open order gets only the lines not yet sent (the sent ones are
   * already there), plus any change to guests, the note, or discounts. Nothing here needs the network.
   */
  async function place(payment: { method: PaymentMethod; confirmed: boolean; amountCents?: number; checkId?: string } | null, existingOrderId?: string): Promise<{ queue?: string; orderId: string } | undefined> {
    if (!bag.length) return undefined;
    const id = orderId ?? existingOrderId ?? newId();
    let queueNumber = linked?.queueNumber;
    if (!orderId) {
      const code = getDeviceCode();
      const todays = orders.filter((o) => o.openedAt >= startOfDay()).map((o) => o.queueNumber ?? "");
      queueNumber = config.modules.queue ? formatQueueNumber(code, nextQueueCounter(code, todays)) : undefined;
      await record(id, {
        type: "OrderOpened",
        fulfilment,
        channelId,
        channelName: channel.name,
        serviceCharge: channel.serviceCharge,
        spot: channel.kind === "dine_in" ? spot : undefined,
        ...(channel.kind === "dine_in" && pax > 0 ? { pax } : {}),
        queueNumber,
      });
    } else if (linked && channel.kind === "dine_in" && pax > 0 && pax !== linked.pax) {
      await record(id, { type: "GuestsChanged", pax, ...(staff ? { byName: staff.name } : {}) });
    }
    const fresh = bag.filter((l) => !l.sent);
    const lineIds = new Map(bag.map((l) => [l.key, l.sent?.lineId ?? newId()]));
    for (const l of fresh) {
      await record(id, {
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
        ...(l.course ? { course: l.course } : {}),
        ...(l.seat ? { seat: l.seat } : {}),
        options: l.options.length || l.note ? [...l.options, ...(l.note ? [{ group: "Special request", name: `Note: ${l.note}`, qty: 1, priceCents: 0 }] : [])] : undefined,
      });
    }
    const note = orderNote.trim();
    if (note !== (linked?.note ?? "")) await record(id, { type: "OrderNoted", note, ...(staff ? { byName: staff.name } : {}) });
    // Prices changed by hand and discounts given, each with who gave it and who approved it. (Ones already on the order are not written twice.)
    const who = (a?: { id: string; name: string }) => ({ ...(staff ? { byName: staff.name } : {}), ...(a ? { approvedBy: a.id, approvedByName: a.name } : {}) });
    for (const l of bag) {
      const lid = lineIds.get(l.key)!;
      if (l.override) await record(id, { type: "LinePriceOverridden", lineId: lid, unitCents: l.override.unitCents, reason: l.override.reason, ...who(l.override.approver) });
      for (const d of l.discounts ?? []) if (!d.existing) await record(id, { type: "DiscountApplied", discountId: d.id, scope: "line", lineId: lid, kind: d.kind, value: d.value, reason: d.reason, ...who(d.approver) });
    }
    for (const d of billDiscounts) if (!d.existing) await record(id, { type: "DiscountApplied", discountId: d.id, scope: "bill", kind: d.kind, value: d.value, reason: d.reason, ...who(d.approver) });
    for (const d of linked?.discounts ?? []) {
      const kept = d.scope === "bill" ? billDiscounts.some((x) => x.id === d.id) : bag.some((b) => b.discounts?.some((x) => x.id === d.id));
      if (!kept) await record(id, { type: "DiscountRemoved", discountId: d.id, ...(staff ? { byName: staff.name } : {}) });
    }
    // Table service: the first Send fires only the lowest course; a later course waits for Fire Course.
    if (channel.kind === "dine_in" && floor.courses && !(linked?.firedCourses?.length)) {
      const courses = [...new Set([...(linked?.lines.filter((q) => q.qty > 0 && q.course).map((q) => q.course as number) ?? []), ...fresh.filter((l) => l.course).map((l) => l.course as number)])].sort((a, b) => a - b);
      if (courses.length) await record(id, { type: "CourseFired", course: courses[0]!, ...(staff ? { byName: staff.name } : {}) });
    }
    if (payment) {
      const paymentId = newId();
      await record(id, { type: "PaymentRecorded", paymentId, method: payment.method, amountCents: payment.amountCents ?? due, confirmed: payment.confirmed, ...(payment.checkId ? { checkId: payment.checkId } : {}) });
      if (!payment.confirmed) {
        // MOCK gateway: stands in for the YeahPay callback until real credentials exist.
        window.setTimeout(() => void record(id, { type: "PaymentConfirmed", paymentId }), 1500);
      }
    }
    setBag([]);
    setBillDiscounts([]);
    setOrderNote("");
    setPax(1);
    setOrderId(null);
    return { queue: queueNumber, orderId: id };
  }

  /**
   * Charge prepaid credit first, then record the order. The order id doubles as the idempotency
   * key, so a retry after a dropped connection never charges the customer twice.
   */
  async function payWithCredit() {
    if (!bag.length || !customerId || payLock.current) return;
    if (training) return notify("Member credit is not charged in training mode.");
    payLock.current = true;
    setPaying(true);
    const oid = orderId ?? newId();
    const owed = due;
    const r = await spend(customerId, owed, `order:${oid}:${paidSoFar}`, oid, deviceId());
    payLock.current = false;
    setPaying(false);
    if (r.ok) {
      setBalance(r.balanceCents);
      const placed = await place({ method: "credit", confirmed: true }, oid);
      setPayView(false);
      setDone({ queue: placed?.queue, change: 0, total: owed });
    } else if (r.reason === "insufficient_funds") {
      setBalance(r.balanceCents);
      notify(`Not enough credit: ${formatMoney(r.balanceCents)} available, ${formatMoney(owed)} needed.`);
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

  // ---- the order on screen: holding, recalling, opening a table's bill ----
  const dineChannel = channels.find((c) => c.kind === "dine_in");
  /** Table service: postpay shops with a dine-in channel get the Table Map, open bills and courses. */
  const tableService = !prepay && !!dineChannel;
  const unsent = bag.some((l) => !l.sent) || (!orderId && bag.length > 0);
  const resetOrder = () => { setBag([]); setBillDiscounts([]); setOrderNote(""); setPax(1); setPendingQty(1); setPayView(false); setSheetOpen(false); setOrderId(null); setPayCheckId(null); };
  /** Put what is on screen aside as a draft (a table's bill with unsent items stays with the table). */
  const parkCurrent = () => {
    if (!unsent) return false;
    setHeld((h) => [...h, { id: newId(), savedAt: Date.now(), bag, billDiscounts, orderNote, channelId, spot, pax, customerId, ...(orderId ? { orderId } : {}) }]);
    return true;
  };
  const holdCurrent = () => {
    if (!bag.length) return;
    if (parkCurrent()) notify("Order held. Find it under Held orders.");
    resetOrder();
  };
  const recall = (id: string) => {
    const h = held.find((x) => x.id === id);
    if (!h) return;
    // Whatever is on screen is held first, so nothing is lost.
    const mine = unsent ? [{ id: newId(), savedAt: Date.now(), bag, billDiscounts, orderNote, channelId, spot, pax, customerId, ...(orderId ? { orderId } : {}) } as HeldOrder] : [];
    setHeld((cur) => [...cur.filter((x) => x.id !== id), ...mine]);
    setBag(h.bag); setBillDiscounts(h.billDiscounts); setOrderNote(h.orderNote); setChosenChannel(h.channelId); setSpot(h.spot); setPax(h.pax); setCustomerId(h.customerId); setOrderId(h.orderId ?? null); setPayView(false); setFlash(null); setView("order");
  };
  const heldTotal = (h: HeldOrder) => priceOrder({ lines: h.bag.map((b) => ({ name: b.item.name, unitCents: effUnit(b), qty: b.qty, pointsExempt: b.item.pointsExempt, bcrs: !!b.item.bcrs, taxInclusive: b.item.taxInclusive, taxGroup: b.item.taxGroup })), fulfilment: fulfilmentOf((channels.find((c) => c.id === h.channelId) ?? channel).kind), serviceCharge: (channels.find((c) => c.id === h.channelId) ?? channel).serviceCharge, config: config.pricing }).total;
  const cancelOrder = () => {
    if (orderId) {
      if (bag.some((l) => !l.sent) && window.confirm("Remove the items that have not been sent yet?")) setBag((cur) => cur.filter((l) => l.sent));
      else if (!bag.some((l) => !l.sent)) notify("This order was already sent. To cancel it, a manager voids it from Orders.");
      return;
    }
    if (bag.length && window.confirm("Cancel this order and start again?")) resetOrder();
  };
  /** Start a fresh order (the one on screen is parked if it has unsent items). */
  const newOrder = () => { parkCurrent(); resetOrder(); setView("order"); };

  /** Put a table's sent bill on screen. Its sent lines are locked; anything added is sent to the same order. */
  function loadOrder(o: OrderState) {
    const lines: BagLine[] = o.lines.filter((l) => l.qty > 0).map((l) => {
      const m = menu.find((x) => x.id === l.productId);
      const item = { ...(m ?? ({ id: l.productId, name: l.name, priceCents: l.unitCents, pricebookId: "" } as unknown as MenuEntry)), name: l.name, bcrs: l.bcrs, pointsExempt: l.pointsExempt, taxInclusive: l.taxInclusive, taxGroup: l.taxGroup } as MenuEntry;
      return {
        key: `sent:${l.lineId}`, item, qty: l.qty, selection: [], options: l.options ?? [], unitCents: l.unitCents, sent: { lineId: l.lineId },
        ...(l.course ? { course: l.course } : {}), ...(l.seat ? { seat: l.seat } : {}),
        discounts: (o.discounts ?? []).filter((d) => d.scope === "line" && d.lineId === l.lineId).map((d) => ({ id: d.id, kind: d.kind, value: d.value, reason: d.reason, existing: true })),
      };
    });
    setBag(lines);
    setBillDiscounts((o.discounts ?? []).filter((d) => d.scope === "bill").map((d) => ({ id: d.id, kind: d.kind, value: d.value, reason: d.reason, existing: true })));
    setOrderNote(o.note ?? "");
    setOrderId(o.orderId);
    if (o.channelId) setChosenChannel(o.channelId);
    setSpot(o.spot ?? ""); setPax(o.pax ?? 1); setPayView(false); setPayCheckId(null); setPendingQty(1);
    setView(o.split ? "checks" : "order");
  }
  /** Tap a table: its bill opens; a table with only a draft reopens the draft; a free one starts a new order there. */
  function openTable(name: string) {
    const info = tableInfo(name, orders, held, config, floor, Date.now());
    if (info.order && info.order.orderId === orderId) { setView(info.order.split ? "checks" : "order"); return; }
    if (info.draft && info.draft.id) { recall(info.draft.id); return; }
    parkCurrent(); resetOrder();
    if (info.order) return loadOrder(info.order);
    if (dineChannel) setChosenChannel(dineChannel.id);
    setSpot(name); setPax(1); setView("order"); setDialog("guests");
  }
  function startTab(name: string) {
    const existing = tableInfo(name, orders, held, config, floor, Date.now());
    if (existing.state !== "available") return openTable(name);
    parkCurrent(); resetOrder();
    if (dineChannel) setChosenChannel(dineChannel.id);
    setSpot(name); setPax(1); setView("order");
  }
  // An order opened from the Orders screen arrives here: its bill goes on the till, with sent lines locked.
  useEffect(() => {
    const id = localStorage.getItem("pos.openOrder");
    if (!id) return;
    const o = orders.find((x) => x.orderId === id);
    if (!o) return;
    localStorage.removeItem("pos.openOrder");
    parkCurrent(); resetOrder(); loadOrder(o);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);
  useEffect(() => { if (queryParams().get("dialog") === "shift") setDialog("shift"); }, []);
  function goTables() {
    // The bill on screen goes back to the map: unsent items stay with the table as a draft.
    parkCurrent(); resetOrder(); setView("tables");
  }
  const changeTable = async (name: string) => {
    const info = tableInfo(name, orders, held, config, floor, Date.now());
    if (info.state !== "available") return notify(`${name} already has an order. Use Merge tables on the Table Map.`);
    if (linked) await transferTable(linked, name);
    setSpot(name);
    setDialog(null);
  };

  // ---- split bill: the order is sent first if it has not been, then divided into checks ----
  async function createSplit(method: "even" | "manual" | "item" | "seat", plan: import("@pos/core").CheckPlan[]) {
    setSplitOpen(false);
    let id = orderId;
    if (!id || bag.some((l) => !l.sent)) {
      const placed = await place(null, id ?? undefined);
      if (!placed) return;
      id = placed.orderId;
    }
    await record(id, { type: "SplitCreated", method, checks: plan.map((c) => ({ id: newId(), totalCents: c.totalCents, ...(c.seat ? { seat: c.seat } : {}), ...(c.shares ? { shares: c.shares } : {}) })), ...(staff ? { byName: staff.name } : {}) });
    const st = reduceOrder(id, await allEvents());
    if (st) loadOrder(st);
    setView("checks");
  }
  /** Record a payment against one check. Cash may part-pay it; the order closes when every check is paid. */
  async function payCheck(t: Tender, received: number) {
    if (!linked || !payCheckId || !checkDue) return;
    if (mustOpenShift) return notify("Open your shift first.");
    if (payLock.current) return;
    payLock.current = true;
    const owed = checkDue.dueCents;
    const applied = t === "cash" ? Math.min(received, owed) : owed;
    try {
      const paymentId = newId();
      if (t === "credit") {
        if (!customerId) return notify("Enter a customer to use credit.");
        const r = await spend(customerId, owed, `check:${paymentId}`, linked.orderId, deviceId());
        if (!r.ok) return notify(r.reason === "insufficient_funds" ? `Not enough credit: ${formatMoney(r.balanceCents)} available.` : failText(r));
        setBalance(r.balanceCents);
        await record(linked.orderId, { type: "PaymentRecorded", paymentId, method: "credit", amountCents: owed, confirmed: true, checkId: payCheckId });
      } else {
        const method: PaymentMethod = t === "cash" ? "cash" : "paynow";
        await record(linked.orderId, { type: "PaymentRecorded", paymentId, method, amountCents: applied, confirmed: t === "cash", checkId: payCheckId });
        if (t !== "cash") window.setTimeout(() => void record(linked.orderId, { type: "PaymentConfirmed", paymentId }), 1500);
      }
      const total = orderTotals(linked, config).total;
      const settled = paidSoFar + applied >= total;
      const change = t === "cash" ? Math.max(0, received - owed) : 0;
      setPayView(false); setPayCheckId(null);
      if (settled) { resetOrder(); setView("order"); setDone({ queue: linked.queueNumber, change, total }); }
      else { setView("checks"); notify(applied < owed ? `Part payment of ${formatMoney(applied)} taken. ${formatMoney(owed - applied)} still due on this check.` : "Check paid."); }
    } finally { payLock.current = false; }
  }
  const clearSplit = async () => {
    if (!linked?.split) return;
    if (paidSoFar > 0) return notify("Payments have been taken. Use Refund Payments first, then clear the split.");
    if (!window.confirm("Clear the split? The bill goes back to one check.")) return;
    await record(linked.orderId, { type: "SplitCleared", ...(staff ? { byName: staff.name } : {}) });
    setView("order");
  };

  const allTenders: TenderOption[] = [
    { id: "cash", label: "Cash" },
    { id: "credit", label: "Member credit", disabled: !!creditBlocked || paying, why: creditBlocked || undefined },
    { id: "qr", label: "PayNow QR", disabled: !qrReady || qrBusy || !!payCheckId, why: payCheckId ? "A QR pays the whole bill: use Cash or credit on a check." : !qrReady ? "PayNow is not set up. A manager does it in Devices." : undefined },
    ...(training ? [{ id: "mock" as Tender, label: "Card (practice)" }] : []),
  ];
  const arrangedTenders = arrange(allTenders, till.tenders);
  const tenders = arrangedTenders.length ? arrangedTenders : allTenders;
  async function payDone(t: Tender, received: number) {
    if (payCheckId) return void payCheck(t, received);
    if (mustOpenShift) return notify("Open your shift first.");
    const owed = due;
    if (t === "cash") { const p = await place({ method: "cash", confirmed: true }); setPayView(false); setDone({ queue: p?.queue, change: Math.max(0, received - owed), total: owed }); }
    else if (t === "credit") await payWithCredit();
    else if (t === "qr") await payWithQr();
    else { const p = await place({ method: "paynow", confirmed: false }); setPayView(false); setDone({ queue: p?.queue, change: 0, total: owed }); }
  }
  const sendOrder = async () => {
    const dineIn = channel.kind === "dine_in";
    const placed = await place(null);
    notify(placed?.queue ? `Order sent · queue number ${placed.queue}` : "Order sent");
    if (dineIn && tableService) setView("tables");
  };

  const line = lineKey ? bag.find((b) => b.key === lineKey) : undefined;
  const qtyOf = (id: string) => bag.filter((l) => l.item.id === id).reduce((n, l) => n + l.qty, 0);
  const itemCount = bag.reduce((n, l) => n + l.qty, 0);
  const dineIn = channel.kind === "dine_in";
  const fire = linked ? courseProgress(linked) : null;
  const allActions: Action[] = [
    { id: "cancel", label: "Cancel Order", icon: "✕", onClick: cancelOrder, disabled: !bag.length },
    { id: "hold", label: "Hold Order", icon: "‖", onClick: holdCurrent, disabled: !unsent },
    { id: "send", label: "Send Order", icon: "▶", onClick: () => void sendOrder(), disabled: !bag.some((l) => !l.sent) || prepay, title: prepay ? "This shop is paid up front: use Pay" : undefined },
    { id: "qty", label: "Quantity", icon: "#", onClick: () => setDialog("qty"), badge: pendingQty > 1 ? pendingQty : undefined },
    ...(tableService ? [{ id: "tables", label: "Table Map", icon: "▦", onClick: goTables }] : []),
    ...(tableService && floor.courses && fire ? [{ id: "fire", label: `Fire Course (${fire.index} of ${fire.of})`, icon: "🔥", onClick: () => void fireNextCourse(linked!, staff?.name).then(() => notify(`${COURSE_NAMES[fire.course] ?? "Course"} fired.`)) }] : []),
    { id: "discount", label: "Discount Order", icon: "%", onClick: () => setSheet({ scope: "bill" }), disabled: !staff || !bag.length, title: !staff ? "Sign in to give a discount" : undefined },
    { id: "dining", label: "Dining Option", icon: "⑂", onClick: () => (orderId ? notify("This order was already sent. The dining option can no longer change.") : setDialog("dining")) },
    { id: "note", label: "Order Note", icon: "✎", onClick: () => setNoteFor({ scope: "order" }), disabled: !bag.length },
    { id: "guests", label: "Guest Count", icon: "👥", onClick: () => setDialog("guests"), disabled: !dineIn },
    ...(tableService && linked ? [{ id: "bill", label: "Guest Check", icon: "🧾", onClick: () => void askForBill(linked, staff?.name).then(() => notify("Guest check requested: the table shows Bill asked.")) }] : []),
    { id: "held", label: "Held Orders", icon: "☰", onClick: () => setDialog("held"), badge: held.length || undefined },
    { id: "member", label: "Member", icon: "👤", onClick: () => setDialog("customer") },
    { id: "drawer", label: "Open Cash Drawer", icon: "▭", onClick: () => void openDrawer(), disabled: !staff || !online || training },
    ...(!prepay ? [{ id: "tabs", label: "Open Tabs", icon: "▤", onClick: () => setDialog("tabs" as const), badge: openTabs.length || undefined }] : []),
  ];
  // The manager's choice of which buttons show, and in what order (the pool's natural order is the starting point).
  const poolRank = (id: string) => ACTION_POOL.findIndex((x) => x.id === id);
  const actions = arrange([...allActions].sort((a, b) => poolRank(a.id) - poolRank(b.id)), till.actions);

  const row = (k: string, v: string, neg = false) => <div className="row"><span>{k}</span><span>{neg ? "−" : ""}{v}</span></div>;
  const totals = (
    <div className="t-totals">
      <div>
        {row("Sub Total", formatMoney(priced.subtotal))}
        {row("Discounts", formatMoney(priced.discountCents), priced.discountCents > 0)}
        {priced.service > 0 && row(`Service charge (${Math.round(config.pricing.serviceRate * 100)}%)`, formatMoney(priced.service))}
        {priced.gst > 0 && row("GST", formatMoney(priced.gst))}
        {priced.bcrs > 0 && row("BCRS deposit", formatMoney(priced.bcrs))}
        {billDiscounts.map((d) => <div className="row" key={d.id}><small>{d.kind === "percent" ? `${d.value}% off bill` : `${formatMoney(d.value)} off bill`} · {d.reason}</small><button className="t-link" onClick={() => setBillDiscounts((cur) => cur.filter((x) => x.id !== d.id))}>remove</button></div>)}
      </div>
      <div className="major">
        <div className="row total"><span>TOTAL</span><strong>{formatMoney(priced.total)}</strong></div>
        {paidSoFar > 0 && <div className="row"><span>{linked?.split ? "Paid on checks" : "Paid"}</span><span>{formatMoney(paidSoFar)}</span></div>}
        <div className="row bal"><span>Balance Due</span><strong>{formatMoney(due)}</strong></div>
      </div>
    </div>
  );
  const chips = (
    <>
      <button className={mustOpenShift ? "warn" : ""} onClick={() => setDialog("shift")}>{shift ? `Drawer ${shift.drawer}` : mustOpenShift ? "Open your shift" : "Shift"}</button>
      {dineIn && <button onClick={() => (tableService ? setDialog("table") : setDialog("table"))}>{spot || "Choose table"}</button>}
      {dineIn && <button onClick={() => setDialog("guests")}>{pax} guest{pax === 1 ? "" : "s"}</button>}
      <button onClick={() => setDialog("customer")}>{customerId ? `👤 ···· ${customerId.slice(-4)}${balance !== null ? ` · ${formatMoney(balance)}` : ""}` : "👤 Member"}</button>
      <button onClick={() => setDialog("settings")} aria-label="My till settings">⚙</button>
    </>
  );
  const strip = <ActionStrip actions={actions} payLabel={`Pay ${formatMoney(priced.total)}`} onPay={() => { setSheetOpen(false); if (linked?.split) setView("checks"); else setPayView(true); }} payDisabled={!bag.length} />;

  return (
    <div className={`till ${prefs.menuSide === "left" ? "menu-left" : ""}`} style={{ "--t-scale": TEXT_SCALE[prefs.textSize] } as React.CSSProperties}>
      {view === "tables" ? (
        <div className="t-fullview">
          <TableMap
            floor={floor} config={config} orders={orders} held={held} courses={floor.courses} canTransfer={tableService}
            onOpen={openTable} onNewTab={startTab}
            onTransfer={(o, to) => transferTable(o, to, staff?.name)}
            onMerge={(from, into) => mergeTables(from, into, staff?.name)}
            onFire={async (o) => { if (await fireNextCourse(o, staff?.name)) notify("Course fired."); }}
            onBill={async (o) => { await askForBill(o, staff?.name); notify("Guest check requested."); }}
            onBack={() => setView("order")}
          />
        </div>
      ) : view === "checks" && linked?.split ? (
        <div className="t-fullview">
          <ChecksBoard
            order={linked} canAdd={paidSoFar <= 0}
            onPay={(id) => { setPayCheckId(id); setPayView(true); setView("order"); }}
            onPrint={() => notify("Check printing comes with the receipt format step.")}
            onRefund={() => setRefundOpen(true)} onClear={() => void clearSplit()} onAdd={() => setSplitOpen(true)}
            onClose={() => setView("order")} onHold={() => { setView("tables"); resetOrder(); }}
          />
        </div>
      ) : null}
      {view === "order" && (
      <>
      <TicketPanel
        channelName={channel.name} title={linked ? (linked.spot ?? "Order") : spot && tableService ? spot : "New order"} open={sheetOpen} onCloseSheet={() => setSheetOpen(false)}
        subline={[dineIn ? spot : "", dineIn && pax > 0 ? `${pax} guest${pax === 1 ? "" : "s"}` : "", staff?.name ?? ""].filter(Boolean).join(" · ")}
        shiftChip={chips} bag={bag} flash={flash}
        onDining={() => (orderId ? notify("This order was already sent. The dining option can no longer change.") : setDialog("dining"))} onNew={newOrder}
        onQty={(k, d) => change(k, d)} onEdit={(k) => { setLineKey(k); setDialog("line"); }} onRemove={(k) => { if (bag.find((l) => l.key === k)?.sent) return notify("Already sent to the kitchen. A manager voids it from Orders."); setBag((cur) => cur.filter((l) => l.key !== k)); }}
        totals={totals} strip={strip}
        extra={orderNote ? <p className="t-muted" style={{ margin: ".3em .9em" }}><b>Order note:</b> {orderNote}</p> : undefined}
      />
      <div className="t-main">
        {payView && bag.length ? (
          <PayPanel
            totalCents={payCheckId && checkDue ? checkDue.dueCents : due}
            title={payCheckId && linked?.split ? `Check #${String(linked.split.checks.find((c) => c.id === payCheckId)?.no ?? 0).padStart(2, "0")} · ${spot}` : `${channel.name}${dineIn ? ` · ${spot}` : ""}`}
            tenders={tenders} busy={paying || qrBusy} partial={!!payCheckId}
            onBack={() => { setPayView(false); if (payCheckId) { setPayCheckId(null); setView("checks"); } }}
            onDone={(t, r) => void payDone(t, r)}
            onSplit={!payCheckId && floor.splitBill && config.modules.splitBill && dineIn && !linked?.split ? () => setSplitOpen(true) : undefined}
          />
        ) : (
          <TillMenu
            editing={staff ? { layout: prefs.layout ?? till.layout, hasOwn: !!prefs.layout, canEditShop: staff.role !== "cashier", startRequest: editLayoutAt, onSaveMine: (l) => setLayout(l), onResetMine: () => setLayout(null), onSaveShop: (l) => saveTill({ layout: l }) } : undefined}
            menu={menu} qtyOf={qtyOf} onAdd={(m) => (m.soldOut ? undefined : add(m))} onDiscount={() => (staff && bag.length ? setSheet({ scope: "bill" }) : notify(staff ? "Add an item first." : "Sign in to give a discount."))} />
        )}
      </div>
      <button className="t-mobilebar" onClick={() => setSheetOpen(true)}><span>View order · {itemCount} item{itemCount === 1 ? "" : "s"}</span><strong>{formatMoney(priced.total)} ↑</strong></button>
      </>
      )}

      {dialog === "dining" && <DiningDialog channels={channels.map((c) => ({ id: c.id, name: c.name }))} current={channelId} onPick={(id) => setChosenChannel(id)} onClose={() => setDialog(null)} />}
      {dialog === "guests" && <GuestsDialog current={pax} onSave={(n) => { setPax(n); if (linked && n !== linked.pax) void record(linked.orderId, { type: "GuestsChanged", pax: n, ...(staff ? { byName: staff.name } : {}) }); }} onClose={() => setDialog(null)} />}
      {dialog === "qty" && <QuantityDialog current={pendingQty} onSave={setPendingQty} onClose={() => setDialog(null)} />}
      {dialog === "held" && <HeldDialog held={held} onRecall={recall} onDrop={(id) => setHeld((h) => h.filter((x) => x.id !== id))} onClose={() => setDialog(null)} formatTotal={heldTotal} />}
      {dialog === "customer" && <CustomerDialog current={customerId} balance={balance} onSave={setCustomerId} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <TillSettings onClose={() => setDialog(null)} onEditLayout={staff ? () => { setDialog(null); setView("order"); setEditLayoutAt((n) => n + 1); } : undefined} />}
      {dialog === "shift" && <Modal title="Shift and drawer" wide onClose={() => setDialog(null)}><ShiftBar /></Modal>}
      {dialog === "table" && (
        <Modal title="Table" onClose={() => setDialog(null)}>
          {tableNames(floor).map((t) => { const i = tableInfo(t, orders, held, config, floor, Date.now()); return <button key={t} className={`t-radio ${spot === t ? "on" : ""}`} disabled={i.state !== "available" && spot !== t} onClick={() => (linked ? void changeTable(t) : (setSpot(t), setDialog(null)))}><i>{spot === t ? "◉" : "○"}</i> {t}{i.state !== "available" && spot !== t ? " · in use" : ""}</button>; })}
        </Modal>
      )}
      {dialog === "line" && line && (
        <Modal title={line.item.name} onClose={() => setDialog(null)}>
          <div className="t-sheetlist">
            {line.sent && <p className="t-muted">Already sent to the kitchen. It can be discounted; to take it off, a manager voids it from Orders.</p>}
            {!line.sent && line.item.options?.length ? <button onClick={() => { setDialog(null); setEditing(line); }}>Edit choices</button> : null}
            {!line.sent && <button onClick={() => { setDialog(null); setNoteFor({ scope: "line", key: line.key }); }}>{line.note ? "Edit note" : "Add a note for the kitchen"}</button>}
            {!line.sent && dineIn && floor.courses && <div className="t-chiprow"><span>Course</span>{[0, 1, 2, 3].map((c) => <button key={c} className={(line.course ?? 0) === c ? "on" : ""} onClick={() => setBag((cur) => cur.map((x) => (x.key === line.key ? { ...x, course: c || undefined } : x)))}>{c ? COURSE_NAMES[c] : "None"}</button>)}</div>}
            {!line.sent && dineIn && <div className="t-chiprow"><span>Seat</span>{[1, 2, 3, 4, 5, 6].map((c) => <button key={c} className={(line.seat ?? 1) === c ? "on" : ""} onClick={() => setBag((cur) => cur.map((x) => (x.key === line.key ? { ...x, seat: c === 1 ? undefined : c } : x)))}>{c}</button>)}</div>}
            {staff && <button onClick={() => { setDialog(null); setSheet({ scope: "line", key: line.key }); }}>Discount or change the price</button>}
            {line.discounts?.map((d) => <button key={d.id} onClick={() => setBag((cur) => cur.map((x) => (x.key === line.key ? { ...x, discounts: (x.discounts ?? []).filter((y) => y.id !== d.id) } : x)))}>Remove discount · {d.kind === "percent" ? `${d.value}%` : formatMoney(d.value)} ({d.reason})</button>)}
            {line.override && <button onClick={() => setBag((cur) => cur.map((x) => (x.key === line.key ? { ...x, override: undefined } : x)))}>Undo the price change</button>}
            {!line.sent && <button className="danger" onClick={() => { setBag((cur) => cur.filter((x) => x.key !== line.key)); setDialog(null); }}>Remove item</button>}
          </div>
        </Modal>
      )}
      {dialog === "tabs" && !prepay && (
        <Modal title="Open tabs" wide onClose={() => setDialog(null)}>
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
        </Modal>
      )}
      {splitOpen && (
        <SplitDialog
          totalCents={linked ? orderTotals(linked, config).total : priced.total}
          lines={(linked && !bag.some((l) => !l.sent) ? linked.lines.filter((l) => l.qty > 0).map((l) => ({ lineId: l.lineId, name: l.name, qty: l.qty, unitCents: l.unitCents, seat: l.seat })) : bag.map((l) => ({ lineId: l.sent?.lineId ?? l.key, name: l.item.name, qty: l.qty, unitCents: effUnit(l), seat: l.seat })))}
          onCreate={(m, plan) => void createSplit(m, plan)} onClose={() => setSplitOpen(false)}
        />
      )}
      {refundOpen && linked && <Modal title="Refund payments" wide onClose={() => setRefundOpen(false)}><RefundPanel order={linked} onDone={() => setRefundOpen(false)} /></Modal>}
      {done && <DoneDialog queue={done.queue} changeCents={done.change} totalCents={done.total} onClose={() => setDone(null)} />}
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
