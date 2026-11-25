import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  basePriceFor,
  RECORDED_TENDERS,
  recordedTender,
  comboSaving,
  isCombo,
  priceRange,
  resolveOptions,
  staffDiscountCents,
  feeCentsOf,
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
import { effUnit, type BagLine, type BillDiscount, type HeldOrder, type TaxOff, type TillFee } from "../till/types";
import { TicketPanel } from "../till/TicketPanel";
import { ReportsDialog } from "../till/ReportsDialog";
import { TillMenu } from "../till/TillMenu";
import { ActionStrip, type Action } from "../till/ActionStrip";
import { PayPanel, type Tender, type TenderOption } from "../till/PayPanel";
import { Modal } from "../till/Modal";
import { ManageItem } from "../till/ManageItem";
import { CustomerDialog, DiningDialog, DoneDialog, ExtraItemDialog, FeeDialog, GuestsDialog, HeldDialog, QuantityDialog, TaxDialog, TillSettings, loadMember, type MemberSummary } from "../till/Dialogs";
import { TEXT_SCALE, loadPrefs, setLayout, usePrefs } from "../prefs";
import { arrange, arrangeAll, loadTillSettings, saveTill, useTillSettings, ACTION_POOL } from "../till/tillSettings";
import { onRouteChange, queryParams } from "../nav";
import { isTraining } from "../training";
import { loadFloor, saveFloor, tableNames, useFloor } from "../floor";
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
  /** The till header (the bare <header>), which the order screen places inside the prototype's ".app". */
  header?: ReactNode;
}

export function Pos({ config, catalog, online, customerId, setCustomerId, header }: PosProps) {
  const orders = useOrders();
  // The order being built stays on the device: a lock, a reload or a different cashier signing in finds it where it was.
  const [saved] = useState(() => { try { return JSON.parse(localStorage.getItem(isTraining() ? "pos.bag.practice" : "pos.bag") ?? "null") as { bag: BagLine[]; billDiscounts: BillDiscount[]; orderNote: string; orderId?: string; fees?: TillFee[]; taxOff?: TaxOff | null } | null; } catch { return null; } });
  const [bag, setBag] = useState<BagLine[]>(() => saved?.bag ?? []);
  const [billDiscounts, setBillDiscounts] = useState<BillDiscount[]>(() => saved?.billDiscounts ?? []);
  const [sheet, setSheet] = useState<null | { scope: "line"; key: string } | { scope: "bill" }>(null);
  const [orderNote, setOrderNote] = useState(() => saved?.orderNote ?? "");
  /** Fees on the whole order (a service fee, say). */
  const [fees, setFees] = useState<TillFee[]>(() => saved?.fees ?? []);
  /** Add/Remove Tax: the tax is taken off this order (only where the country's tax pack allows it). */
  const [taxOff, setTaxOff] = useState<TaxOff | null>(() => saved?.taxOff ?? null);
  /** The open order on screen, when this is a table's bill that was already sent (the sent lines are locked; new ones are added to it). */
  const [orderId, setOrderId] = useState<string | null>(() => saved?.orderId ?? null);
  const [view, setView] = useState<"order" | "tables" | "checks">(() => (queryParams().get("view") === "tables" ? "tables" : "order"));
  const [payCheckId, setPayCheckId] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<null | { scope: "line"; key: string } | { scope: "order" }>(null);
  useEffect(() => { try { localStorage.setItem(isTraining() ? "pos.bag.practice" : "pos.bag", JSON.stringify({ bag, billDiscounts, orderNote, orderId, fees, taxOff })); } catch { /* storage full: the order simply is not kept */ } }, [bag, billDiscounts, orderNote, orderId, fees, taxOff]);
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
  const [managing, setManaging] = useState<MenuEntry | null>(null);
  const [pax, setPax] = useState(1);
  const [payView, setPayView] = useState(false);
  const [dialog, setDialog] = useState<null | "dining" | "guests" | "qty" | "held" | "customer" | "settings" | "tabs" | "shift" | "table" | "line" | "seat" | "fee" | "extra" | "reports" | "tax">(null);
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
  /** The member attached to this order (their points and last orders), and whether their points pay for part of it. */
  const [memberInfo, setMemberInfo] = useState<MemberSummary | null>(null);
  const [usePoints, setUsePoints] = useState(false);
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
    if (!customerId || !online || !staff) { setMemberInfo(null); setUsePoints(false); }
    else void loadMember(customerId).then((m) => { if (alive) { setMemberInfo(m); if (!m) setUsePoints(false); } });
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
        if (l.sent || l.extra) return [l];
        const e = (l.channelId ? menuFor(catalog, { outletId: config.outletName, channelId: l.channelId }) : menu).find((m) => m.id === l.item.id);
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
  // Opening the member panel reads their credit, points and orders afresh.
  useEffect(() => { if (dialog === "customer" && customerId && online && staff) void loadMember(customerId).then((m) => m && setMemberInfo(m)); }, [dialog]); // eslint-disable-line react-hooks/exhaustive-deps
  const openedOrder = orderId ? orders.find((o) => o.orderId === orderId) : undefined;
  const openedTax = openedOrder?.taxOn;
  // Points already spent on this order stay as they are; otherwise the attached member's points are used when staff asked for them.
  const pointsIn = openedOrder?.pointsRedeemed ? { balance: openedOrder.pointsRedeemed, requested: openedOrder.pointsRedeemed } : usePoints && memberInfo?.rewards.pointsEnabled && !openedOrder?.split ? { balance: memberInfo.member.points, requested: null } : null;
  const priceInput = {
    lines: bag.map((b) => ({ name: b.item.name, unitCents: effUnit(b), qty: b.qty, pointsExempt: b.item.pointsExempt, bcrs: !!b.item.bcrs, taxInclusive: b.item.taxInclusive, taxGroup: b.item.taxGroup })),
    fulfilment,
    serviceCharge: channel.serviceCharge,
    discountCents: staffDiscountCents(bag.map((b) => ({ lineId: b.key, unitCents: effUnit(b), qty: b.qty })), staffDiscounts).totalCents,
    ...(taxOff ? { taxRemoved: true } : {}),
    points: pointsIn,
    // An order already opened keeps the tax answer it was opened with, even if the outlet's setting has changed since.
    config: openedTax === undefined || openedTax === config.pricing.gstOn ? config.pricing : { ...config.pricing, gstOn: openedTax },
  };
  // A fee on the whole order: a percentage is of the items left after discounts.
  const unfeed = priceOrder(priceInput);
  const feeCents = fees.length ? feeCentsOf(fees, unfeed.subtotal - unfeed.couponDiscount - unfeed.discountCents) : 0;
  const priced = feeCents ? priceOrder({ ...priceInput, feeCents }) : unfeed;

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

  /** A member is attached, so items with a member price sell at it. */
  const isMember = !!memberInfo && customerId === memberInfo.member.id;
  const unitOf = (item: MenuEntry, extraCents: number) => ({ unitCents: basePriceFor(item, isMember) + extraCents, ...(isMember && item.memberPriceCents !== undefined ? { memberPriced: true } : { memberPriced: undefined }) });
  // Attaching or removing the member reprices what has not been sent yet. A price set by hand stays as it was set.
  useEffect(() => {
    setBag((cur) => {
      let touched = false;
      const next = cur.map((l) => {
        if (l.sent || l.extra || l.item.memberPriceCents === undefined) return l;
        const r = resolveOptions(l.item.options, l.selection);
        if (!r.ok) return l;
        const u = unitOf(l.item, r.extraCents);
        if (u.unitCents === l.unitCents && !!u.memberPriced === !!l.memberPriced) return l;
        touched = true;
        return { ...l, ...u };
      });
      return touched ? next : cur;
    });
  }, [isMember]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Sell one line through another dining channel: it takes that channel's price (options included). A price set by hand is dropped. */
  const setLineChannel = (old: BagLine, chId: string) => {
    const e = menuFor(catalog, { outletId: config.outletName, channelId: chId }).find((x) => x.id === old.item.id);
    const r = e ? resolveOptions(e.options, old.selection) : null;
    if (!e || !r?.ok) return;
    const back = chId === channelId;
    const name = channels.find((c) => c.id === chId)?.name;
    setBag((cur) => cur.map((x) => (x.key === old.key ? { ...x, item: e, options: r.options, ...unitOf(e, r.extraCents), override: undefined, ...(back ? { channelId: undefined, channelName: undefined } : { channelId: chId, channelName: name }) } : x)));
    if (old.override) notify("The price you set was taken off, because the channel changed.");
  };
  /** Put an item in the bag with its chosen options (none for a plain item). */
  const addWith = (item: MenuEntry, selection: ChosenOptionInput[]) => {
    const r = resolveOptions(item.options, selection);
    if (!r.ok) return;
    const key = `${item.id}#${r.key}`;
    const q = pendingQty;
    setPendingQty(1);
    setBag((cur) => {
      const found = cur.find((l) => l.key === key);
      return found ? cur.map((l) => (l === found ? { ...l, qty: l.qty + q } : l)) : [...cur, { key, item, qty: q, selection, options: r.options, ...unitOf(item, r.extraCents) }];
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
      return cur.map((x) => (x.key === old.key ? { ...x, key, selection, options: r.options, ...unitOf(x.item, r.extraCents), ...(dropped ? { override: undefined } : {}) } : x));
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
  /** Points this payment still has to take from the member (none once the order already carries them). */
  const pointsToTake = !openedOrder?.pointsRedeemed && pointsIn ? priced.pointsUsed : 0;
  const checkDue = linked && payCheckId ? checkStanding(linked, payCheckId) : null;

  /**
   * Put what is on screen into the local log. A new order is opened; a table's open order gets only the lines not yet sent (the sent ones are
   * already there), plus any change to guests, the note, or discounts. Nothing here needs the network.
   */
  async function place(payment: { method: PaymentMethod; tender?: string; confirmed: boolean; amountCents?: number; checkId?: string; tenderedCents?: number } | null, existingOrderId?: string): Promise<{ queue?: string; orderId: string } | undefined> {
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
        taxOn: config.pricing.gstOn,
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
        ...(l.channelId && l.channelId !== channelId ? { channelId: l.channelId, ...(l.channelName ? { channelName: l.channelName } : {}) } : {}),
        ...(l.hold ? { hold: true } : {}),
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
    for (const f of fees) if (!f.existing) await record(id, { type: "FeeApplied", feeId: f.id, kind: f.kind, value: f.value, label: f.label, ...(staff ? { byName: staff.name } : {}) });
    if (taxOff && !taxOff.existing) await record(id, { type: "TaxRemovalSet", removed: true, reason: taxOff.reason, ...(staff ? { byName: staff.name, approvedBy: staff.code, approvedByName: staff.name } : {}) });
    if (!taxOff && linked?.taxRemoved) await record(id, { type: "TaxRemovalSet", removed: false, reason: "", ...(staff ? { byName: staff.name } : {}) });
    for (const f of linked?.fees ?? []) if (!fees.some((x) => x.id === f.id)) await record(id, { type: "FeeRemoved", feeId: f.id, ...(staff ? { byName: staff.name } : {}) });
    for (const d of linked?.discounts ?? []) {
      const kept = d.scope === "bill" ? billDiscounts.some((x) => x.id === d.id) : bag.some((b) => b.discounts?.some((x) => x.id === d.id));
      if (!kept) await record(id, { type: "DiscountRemoved", discountId: d.id, ...(staff ? { byName: staff.name } : {}) });
    }
    // Table service: the first Send fires only the lowest course; a later course waits for Fire Course.
    if (channel.kind === "dine_in" && floor.courses && !(linked?.firedCourses?.length)) {
      const courses = [...new Set([...(linked?.lines.filter((q) => q.qty > 0 && q.course).map((q) => q.course as number) ?? []), ...fresh.filter((l) => l.course).map((l) => l.course as number)])].sort((a, b) => a - b);
      if (courses.length) await record(id, { type: "CourseFired", course: courses[0]!, ...(staff ? { byName: staff.name } : {}) });
    }
    // The member the order belongs to: written once, and again only if it changed.
    const memberNow = memberInfo && customerId === memberInfo.member.id ? memberInfo.member.id : "";
    if (memberNow !== (linked?.memberId ?? "")) await record(id, { type: "MemberAttached", memberId: memberNow, ...(staff ? { byName: staff.name } : {}) });
    // Points already taken from the member (payDone did that first) are written onto the order, so its total says the same as the till.
    if (payment && pointsToTake > 0) await record(id, { type: "PointsRedeemed", points: pointsToTake });
    if (payment) {
      const paymentId = newId();
      await record(id, { type: "PaymentRecorded", paymentId, method: payment.method, ...(payment.tender ? { tender: payment.tender } : {}), amountCents: payment.amountCents ?? due, confirmed: payment.confirmed, ...(payment.checkId ? { checkId: payment.checkId } : {}), ...(payment.tenderedCents ? { tenderedCents: payment.tenderedCents } : {}) });
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
    // The member belongs to the order that just went, not to whoever is served next.
    if (memberInfo) { setCustomerId(""); setUsePoints(false); }
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
  const resetOrder = () => { setBag([]); setBillDiscounts([]); setFees([]); setTaxOff(null); setUsePoints(false); setOrderNote(""); setPax(1); setPendingQty(1); setPayView(false); setSheetOpen(false); setOrderId(null); setPayCheckId(null); };
  /** Put what is on screen aside as a draft (a table's bill with unsent items stays with the table). */
  const parkCurrent = () => {
    if (!unsent) return false;
    setHeld((h) => [...h, { id: newId(), savedAt: Date.now(), bag, billDiscounts, orderNote, channelId, spot, pax, customerId, ...(orderId ? { orderId } : {}), ...(fees.length ? { fees } : {}), ...(taxOff ? { taxOff } : {}) }]);
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
    const mine = unsent ? [{ id: newId(), savedAt: Date.now(), bag, billDiscounts, orderNote, channelId, spot, pax, customerId, ...(orderId ? { orderId } : {}), ...(fees.length ? { fees } : {}), ...(taxOff ? { taxOff } : {}) } as HeldOrder] : [];
    setHeld((cur) => [...cur.filter((x) => x.id !== id), ...mine]);
    setBag(h.bag); setBillDiscounts(h.billDiscounts); setOrderNote(h.orderNote); setChosenChannel(h.channelId); setSpot(h.spot); setPax(h.pax); setCustomerId(h.customerId); setOrderId(h.orderId ?? null); setFees(h.fees ?? []); setTaxOff(h.taxOff ?? null); setPayView(false); setFlash(null); setView("order");
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
        ...(l.course ? { course: l.course } : {}), ...(l.seat ? { seat: l.seat } : {}), ...(l.channelId ? { channelId: l.channelId, ...(l.channelName ? { channelName: l.channelName } : {}) } : {}), ...(l.held ? { hold: true } : {}),
        discounts: (o.discounts ?? []).filter((d) => d.scope === "line" && d.lineId === l.lineId).map((d) => ({ id: d.id, kind: d.kind, value: d.value, reason: d.reason, existing: true })),
      };
    });
    setBag(lines);
    setBillDiscounts((o.discounts ?? []).filter((d) => d.scope === "bill").map((d) => ({ id: d.id, kind: d.kind, value: d.value, reason: d.reason, existing: true })));
    setOrderNote(o.note ?? "");
    setFees((o.fees ?? []).map((f) => ({ ...f, existing: true })));
    setTaxOff(o.taxRemoved ? { reason: o.taxRemoved.reason, existing: true } : null);
    if (o.memberId) setCustomerId(o.memberId); // the order's own member comes back with it
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
  // The header's Drawer, Reports and Table Map buttons work by address (/pos?dialog=shift): act on it at first load, and whenever it changes while the till is open.
  const navTables = useRef<() => void>(() => undefined);
  useEffect(() => {
    const act = (first: boolean) => {
      const q = queryParams(), d = q.get("dialog");
      if (d === "shift" || d === "reports") setDialog(d);
      if (!first && q.get("view") === "tables") navTables.current();
    };
    act(true);
    return onRouteChange(() => act(false));
  }, []);
  function goTables() {
    // The bill on screen goes back to the map: unsent items stay with the table as a draft.
    parkCurrent(); resetOrder(); setView("tables");
  }
  navTables.current = goTables;
  const changeTable = async (name: string) => {
    const info = tableInfo(name, orders, held, config, floor, Date.now());
    if (info.state !== "available") return notify(`${name} already has an order. Use Merge tables on the Table Map.`);
    if (linked) await transferTable(linked, name);
    setSpot(name);
    setDialog(null);
  };

  /** Print the guest check (the whole bill, or one check). The table shows Bill asked. The order must have reached the server. */
  async function printGuestCheck(checkId?: string) {
    if (!linked) return;
    if (training) return notify("Nothing prints in training mode.");
    await askForBill(linked, staff?.name);
    await syncNow();
    const r = await staffFetch(`/api/orders/${linked.orderId}/guest-check`, { method: "POST", body: checkId ? { checkId } : {} });
    if (!("res" in r)) return notify(r.problem);
    if (r.res.ok) return notify(checkId ? "Check sent to the printer." : "Guest check sent to the printer.");
    const code = ((await r.res.json().catch(() => ({}))) as { error?: string }).error;
    notify(code === "no_printer_for_this" ? "No receipt printer is set up. Ask a manager." : code === "order_not_found" ? "The server does not have this order yet. Wait for it to sync, then try again." : "Could not print the check.");
  }

  /** Every check of a split bill, one after the other. */
  async function printAllChecks() {
    for (const c of linked?.split?.checks ?? []) await printGuestCheck(c.id);
  }

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
      } else if (recordedTender(t)) {
        await record(linked.orderId, { type: "PaymentRecorded", paymentId, method: recordedTender(t)!.method, tender: t, amountCents: owed, confirmed: true, checkId: payCheckId });
      } else {
        const method: PaymentMethod = t === "cash" ? "cash" : "paynow";
        await record(linked.orderId, { type: "PaymentRecorded", paymentId, method, amountCents: applied, confirmed: t === "cash", checkId: payCheckId, ...(t === "cash" && received > applied ? { tenderedCents: received } : {}) });
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
    // Recorded tenders: taken on a card terminal or by hand, and confirmed by the cashier.
    ...RECORDED_TENDERS.map((t) => ({ id: t.id as Tender, label: t.label, ...(t.optional ? { optional: true } : {}) })),
    ...(training ? [{ id: "mock" as Tender, label: "Card (practice)" }] : []),
  ];
  const arrangedTenders = arrange(allTenders, till.tenders);
  const tenders = arrangedTenders.length ? arrangedTenders : allTenders;
  async function payDone(t: Tender, received: number) {
    if (payCheckId) return void payCheck(t, received);
    if (mustOpenShift) return notify("Open your shift first.");
    const owed = due;
    // Points are taken from the member first. If that fails, nothing is recorded and the order stays as it is.
    const oid = orderId ?? newId();
    if (pointsToTake > 0) {
      if (t === "credit" || t === "qr") return notify("With points, take the rest in cash or by card.");
      const r = await staffFetch(`/api/members/${memberInfo!.member.id}/redeem`, { body: { points: pointsToTake, orderId: oid } });
      if (!("res" in r)) return notify(r.problem);
      if (!r.res.ok) { void loadMember(customerId).then(setMemberInfo); return notify(r.res.status === 409 ? "The member does not have enough points any more. Their balance has been refreshed." : "The points could not be used. Check the connection and try again."); }
    }
    if (t === "cash") { const p = await place({ method: "cash", confirmed: true, tenderedCents: received }, oid); setPayView(false); setDone({ queue: p?.queue, change: Math.max(0, received - owed), total: owed }); }
    else if (t === "credit") await payWithCredit();
    else if (t === "qr") await payWithQr();
    else if (recordedTender(t)) { const p = await place({ method: recordedTender(t)!.method, tender: t, confirmed: true }, oid); setPayView(false); setDone({ queue: p?.queue, change: 0, total: owed }); }
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
    { id: "fee", label: "Service Fee", icon: "＋", onClick: () => setDialog("fee"), disabled: !staff || !bag.length, title: !staff ? "Sign in to add a fee" : undefined },
    { id: "extra", label: "Add Extra Item", icon: "＋", onClick: () => setDialog("extra"), disabled: !staff || staff.role === "cashier" || !!linked?.split, title: !staff ? "Sign in first" : staff.role === "cashier" ? "A manager adds extra items" : undefined },
    { id: "discount", label: "Discount Order", icon: "%", onClick: () => setSheet({ scope: "bill" }), disabled: !staff || !bag.length, title: !staff ? "Sign in to give a discount" : undefined },
    // Add/Remove Tax shows only where the country's tax pack lets staff take the tax off, and the shop charges tax at all.
    ...(config.pricing.taxRemovable && config.pricing.gstOn ? [{ id: "tax", label: taxOff ? "Add Tax" : "Remove Tax", icon: "§", onClick: () => setDialog("tax" as const), disabled: !staff || staff.role === "cashier" || !bag.length || !!linked?.split, title: !staff ? "Sign in first" : staff.role === "cashier" ? "A manager takes the tax off" : undefined }] : []),
    { id: "dining", label: "Dining Option", icon: "⑂", onClick: () => (orderId ? notify("This order was already sent. The dining option can no longer change.") : setDialog("dining")) },
    { id: "note", label: "Order Note", icon: "✎", onClick: () => setNoteFor({ scope: "order" }), disabled: !bag.length },
    { id: "guests", label: "Guest Count", icon: "👥", onClick: () => setDialog("guests"), disabled: !dineIn },
    ...(tableService && linked ? [{ id: "bill", label: "Guest Check", icon: "🧾", onClick: () => void printGuestCheck() }] : []),
    { id: "held", label: "Held Orders", icon: "☰", onClick: () => setDialog("held"), badge: held.length || undefined },
    { id: "member", label: "Member", icon: "👤", onClick: () => setDialog("customer") },
    { id: "drawer", label: "Open Cash Drawer", icon: "▭", onClick: () => void openDrawer(), disabled: !staff || !online || training },
    ...(!prepay ? [{ id: "tabs", label: "Open Tabs", icon: "▤", onClick: () => setDialog("tabs" as const), badge: openTabs.length || undefined }] : []),
  ];
  // The manager's choice of which buttons show, and in what order (the pool's natural order is the starting point).
  const poolRank = (id: string) => ACTION_POOL.findIndex((x) => x.id === id);
  const actions = arrange([...allActions].sort((a, b) => poolRank(a.id) - poolRank(b.id)), till.actions);

  const row = (k: string, v: string, neg = false) => <div className="row"><span>{k}</span><span>{neg ? "−" : ""}{v}</span></div>;
  // The markup and class names are the prototype's own (totalsHTML).
  const totals = (
    <div className="totals">
      <div className="totals-details">
        {row("Sub Total", formatMoney(priced.subtotal))}
        {row("Discounts", formatMoney(priced.discountCents), priced.discountCents > 0)}
        {priced.fee > 0 && row("Service fee", formatMoney(priced.fee))}
        {priced.service > 0 && row(`Service charge (${Math.round(config.pricing.serviceRate * 100)}%)`, formatMoney(priced.service))}
        {priced.pointsDiscount > 0 && row(`Points (${priced.pointsUsed})`, `−${formatMoney(priced.pointsDiscount)}`)}
        {priced.gst > 0 && row(config.pricing.taxName ?? "GST", formatMoney(priced.gst))}
        {priced.taxRemoved && <div className="row"><span>{priced.taxRemoved.name} removed{priced.taxRemoved.offTotal ? ` · −${formatMoney(priced.taxRemoved.offTotal)}` : ""} · {taxOff?.reason}</span>{!linked?.split && staff && staff.role !== "cashier" && <span className="unlink" role="button" tabIndex={0} onClick={() => setTaxOff(null)}>add back</span>}</div>}
        {priced.rounding ? row("Rounding", `${priced.rounding < 0 ? "−" : ""}${formatMoney(Math.abs(priced.rounding))}`) : null}
        {priced.bcrs > 0 && row("BCRS deposits", formatMoney(priced.bcrs))}
        {fees.map((f) => <div className="row" key={f.id}><span>{f.label} · {f.kind === "percent" ? `${f.value}%` : formatMoney(f.value)}</span><span className="unlink" role="button" tabIndex={0} onClick={() => setFees((cur) => cur.filter((x) => x.id !== f.id))}>remove</span></div>)}
        {billDiscounts.map((d) => <div className="row" key={d.id}><span>{d.kind === "percent" ? `${d.value}% off bill` : `${formatMoney(d.value)} off bill`} · {d.reason}</span><span className="unlink" role="button" tabIndex={0} onClick={() => setBillDiscounts((cur) => cur.filter((x) => x.id !== d.id))}>remove</span></div>)}
      </div>
      <div className="totals-major">
        <div className="row total"><span>TOTAL</span><strong>{formatMoney(priced.total)}</strong></div>
        {paidSoFar > 0 && <div className="row"><span>{linked?.split ? "Paid on checks" : "Paid"}</span><span>{formatMoney(paidSoFar)}</span></div>}
        <div className="row balance"><span>Balance Due</span><strong>{formatMoney(due)}</strong></div>
      </div>
    </div>
  );
  /** The number this order will get when it is sent, shown in its title like the prototype's "Order #0001". */
  const nextQueue = !orderId && config.modules.queue ? formatQueueNumber(getDeviceCode(), nextQueueCounter(getDeviceCode(), orders.filter((o) => o.openedAt >= startOfDay()).map((o) => o.queueNumber ?? ""))) : undefined;
  const chips = (
    <>
      {mustOpenShift && <button className="selected" onClick={() => setDialog("shift")}>Open your shift</button>}
      {dineIn && <button onClick={() => setDialog("table")}>{spot || "Select table"}</button>}
      {dineIn && <button onClick={() => setDialog("guests")}>{pax} guest{pax === 1 ? "" : "s"}</button>}
      <button className={customerId ? "selected" : ""} aria-label="Attach member" onClick={() => setDialog("customer")}>{customerId ? `👤 ${memberInfo ? memberInfo.member.name?.split(" ")[0] || `···· ${(memberInfo.member.phone ?? "").slice(-4)}` : `···· ${customerId.slice(-4)}`}${balance !== null ? ` · ${formatMoney(balance)}` : ""}${memberInfo?.rewards.pointsEnabled ? ` · ${memberInfo.member.points} pts` : ""}` : "👤 Member"}</button>
    </>
  );
  const strip = <ActionStrip actions={actions} everything={arrangeAll([...allActions].sort((a, b) => poolRank(a.id) - poolRank(b.id)), till.actions)} pref={till.actions} canArrange={staff?.role === "manager" || staff?.role === "owner"} onArrange={(next) => void saveTill({ actions: next })} payLabel={`Pay ${formatMoney(priced.total)}`} onPay={() => { setSheetOpen(false); if (linked?.split) setView("checks"); else setPayView(true); }} payDisabled={!bag.length} />;

  return (
    <>
    {view !== "order" && header && <div className="proto protohead">{header}</div>}
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
            staffName={staff?.name} canArrange={staff?.role === "manager" || staff?.role === "owner"} onSaveFloor={saveFloor}
          />
        </div>
      ) : view === "checks" && linked?.split ? (
        <div className="t-fullview">
          <ChecksBoard
            order={linked} canAdd={paidSoFar <= 0}
            onPay={(id) => { setPayCheckId(id); setPayView(true); setView("order"); }}
            onPrint={(id) => void (id ? printGuestCheck(id) : printAllChecks())}
            onRefund={() => setRefundOpen(true)} onClear={() => void clearSplit()} onAdd={() => setSplitOpen(true)}
            onClose={() => setView("order")} onHold={() => { setView("tables"); resetOrder(); }}
          />
        </div>
      ) : null}
      {view === "order" && (
      <div className="proto">
      <div className={`app ${prefs.menuSide === "left" ? "menu-left" : ""}`}>
      {header}
      <main className="workspace">
      <TicketPanel
        kitchen={linked ? Object.fromEntries(linked.lines.filter((l) => l.readyAt).map((l) => [l.lineId, l.servedAt ? "served" as const : "ready" as const])) : undefined}
        lineRemove={till.lineRemove}
        channelName={channel.name} title={linked ? (linked.queueNumber ? `Order ${linked.queueNumber}` : linked.spot ?? "Order") : nextQueue ? `Order ${nextQueue}` : "New order"} open={sheetOpen} onCloseSheet={() => setSheetOpen(false)}
        subline={[dineIn ? spot : "", staff?.name ?? ""].filter(Boolean).join(" · ")}
        shiftChip={chips} bag={bag} flash={flash}
        onDining={() => (orderId ? notify("This order was already sent. The dining option can no longer change.") : setDialog("dining"))} onNew={newOrder}
        onQty={(k, d) => change(k, d)} onEdit={(k) => { setLineKey(k); setDialog("line"); }} onRemove={(k) => { if (bag.find((l) => l.key === k)?.sent) return notify("Already sent to the kitchen. A manager voids it from Orders."); setBag((cur) => cur.filter((l) => l.key !== k)); }}
        totals={totals} strip={strip}
        extra={orderNote ? <p className="ordernote"><b>Order note:</b> {orderNote}</p> : undefined}
      />
        {payView && bag.length ? (
          <PayPanel
            totalCents={payCheckId && checkDue ? checkDue.dueCents : due}
            title={payCheckId && linked?.split ? `Check #${String(linked.split.checks.find((c) => c.id === payCheckId)?.no ?? 0).padStart(2, "0")}` : linked?.queueNumber ? `Order ${linked.queueNumber}` : nextQueue ? `Order ${nextQueue}` : channel.name}
            venue={`${config.name}${dineIn && spot ? ` · ${spot}` : ""}`}
            tenders={tenders} busy={paying || qrBusy} partial={!!payCheckId}
            onBack={() => { setPayView(false); if (payCheckId) { setPayCheckId(null); setView("checks"); } }}
            onDone={(t, r) => void payDone(t, r)}
            onSplit={!payCheckId && floor.splitBill && config.modules.splitBill && dineIn && !linked?.split ? () => setSplitOpen(true) : undefined}
          />
        ) : (
          <TillMenu
            editing={staff ? { layout: prefs.layout ?? till.layout, hasOwn: !!prefs.layout, canEditShop: staff.role !== "cashier", startRequest: editLayoutAt, onSaveMine: (l) => setLayout(l), onResetMine: () => setLayout(null), onSaveShop: (l) => saveTill({ layout: l }), ...(staff.role !== "cashier" ? { onManageItem: (m: MenuEntry) => setManaging(m) } : {}) } : undefined}
            onFn={(id) => { if (!bag.length) return notify("The order is empty."); if (id === "cancel") cancelOrder(); else if (id === "hold") holdCurrent(); else if (prepay) notify("This shop is paid up front: use Pay."); else void sendOrder(); }}
            menu={menu} qtyOf={qtyOf} onAdd={(m) => (m.soldOut ? undefined : add(m))} onDiscount={() => (staff && bag.length ? setSheet({ scope: "bill" }) : notify(staff ? "Add an item first." : "Sign in to give a discount."))} />
        )}
      </main>
      <button className="mobilebar" onClick={() => setSheetOpen(true)}><span>View order · {itemCount} item{itemCount === 1 ? "" : "s"}</span><strong>{formatMoney(priced.total)} ↑</strong></button>
      </div>
      </div>
      )}

      {dialog === "dining" && <DiningDialog channels={channels.map((c) => ({ id: c.id, name: c.name }))} current={channelId} onPick={(id) => setChosenChannel(id)} onClose={() => setDialog(null)} />}
      {dialog === "guests" && <GuestsDialog current={pax} onSave={(n) => { setPax(n); if (linked && n !== linked.pax) void record(linked.orderId, { type: "GuestsChanged", pax: n, ...(staff ? { byName: staff.name } : {}) }); }} onClose={() => setDialog(null)} />}
      {dialog === "qty" && <QuantityDialog current={pendingQty} onSave={setPendingQty} onClose={() => setDialog(null)} />}
      {dialog === "held" && <HeldDialog held={held} onRecall={recall} onDrop={(id) => setHeld((h) => h.filter((x) => x.id !== id))} onClose={() => setDialog(null)} formatTotal={heldTotal} />}
      {dialog === "customer" && <CustomerDialog current={customerId} info={memberInfo} usePoints={usePoints} pointsWorthCents={usePoints ? priced.pointsDiscount : priceOrder({ ...priceInput, points: memberInfo?.rewards.pointsEnabled ? { balance: memberInfo.member.points, requested: null } : null }).pointsDiscount} onUsePoints={setUsePoints} onSave={(id) => { setCustomerId(id); setUsePoints(false); }} onClose={() => setDialog(null)} />}
      {dialog === "extra" && (
        <ExtraItemDialog onClose={() => setDialog(null)} onAdd={(name, cents, qty) => {
          const id = `extra:${newId()}`;
          const item = { id, name, category: "Extra", priceCents: cents, pricebookId: "" } as unknown as MenuEntry;
          setBag((cur) => [...cur, { key: `${id}#`, item, qty, selection: [], options: [], unitCents: cents, extra: true }]);
        }} />
      )}
      {managing && <ManageItem item={managing} catalog={catalog} outletId={config.outletName} channels={channels.map((c) => ({ id: c.id, name: c.name }))} onClose={() => setManaging(null)} />}
      {dialog === "tax" && <TaxDialog name={config.pricing.taxName ?? "GST"} current={taxOff} onSet={setTaxOff} onClose={() => setDialog(null)} />}
      {dialog === "fee" && <FeeDialog fees={fees} onAdd={(kind, value, label) => setFees((cur) => [...cur, { id: newId(), kind, value, label }])} onRemove={(id) => setFees((cur) => cur.filter((f) => f.id !== id))} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <TillSettings onClose={() => setDialog(null)} onEditLayout={staff ? () => { setDialog(null); setView("order"); setEditLayoutAt((n) => n + 1); } : undefined} />}
      {dialog === "shift" && <Modal title="Shift and drawer" wide onClose={() => setDialog(null)}><ShiftBar /></Modal>}
      {dialog === "reports" && <ReportsDialog orders={orders} config={config} categoryOf={(id) => catalog.products.find((x) => x.id === id)?.category ?? ""} manager={!!staff && staff.role !== "cashier"} onShift={() => setDialog("shift")} onClose={() => setDialog(null)} />}
      {dialog === "table" && (
        <Modal title="Table" onClose={() => setDialog(null)}>
          {tableNames(floor).map((t) => { const i = tableInfo(t, orders, held, config, floor, Date.now()); return <button key={t} className={`t-radio ${spot === t ? "on" : ""}`} disabled={i.state !== "available" && spot !== t} onClick={() => (linked ? void changeTable(t) : (setSpot(t), setDialog(null)))}><i>{spot === t ? "◉" : "○"}</i> {t}{i.state !== "available" && spot !== t ? " · in use" : ""}</button>; })}
        </Modal>
      )}
      {dialog === "line" && line && (() => {
        const patch = (fn: (x: BagLine) => BagLine) => setBag((cur) => cur.map((x) => (x.key === line.key ? fn(x) : x)));
        const desc = (catalog.products.find((x) => x.id === line.item.id)?.description ?? "").trim();
        return (
        <Modal title={line.item.name} onClose={() => setDialog(null)}>
          {desc && <p className="t-muted">{desc}</p>}
          {line.options.length > 0 && (
            <>
              <h3 className="t-h3">Modifiers</h3>
              <div className="t-modlist" aria-label="Modifiers">
                {line.options.map((o, i) => <div className="t-row2" key={i}><span>{optionLines([o])[0]}</span><span>{o.priceCents ? `+${formatMoney(o.priceCents * (o.qty || 1))}` : ""}</span></div>)}
              </div>
            </>
          )}
          {line.sent && <p className="t-muted">Already sent to the kitchen. It can be discounted; to take it off, a manager voids it from Orders.</p>}
          {!line.sent && (
            <div className="t-row2"><span>Quantity</span><div className="t-stepper2"><button aria-label="Fewer" disabled={line.qty <= 1} onClick={() => change(line.key, -1)}>−</button><strong>{line.qty}</strong><button aria-label="More" onClick={() => change(line.key, 1)}>+</button></div></div>
          )}
          {!line.sent && channels.length > 1 && (
            <>
              <h3 className="t-h3">Item channel</h3>
              <div className="t-choices">
                {channels.map((c) => {
                  const sold = menuFor(catalog, { outletId: config.outletName, channelId: c.id }).some((x) => x.id === line.item.id);
                  return <button key={c.id} className={(line.channelId ?? channelId) === c.id ? "on" : ""} disabled={!sold} title={sold ? undefined : `Not sold in ${c.name}`} onClick={() => setLineChannel(line, c.id)}>{c.name}</button>;
                })}
              </div>
            </>
          )}
          {!line.sent && dineIn && floor.courses && (
            <>
              <h3 className="t-h3">Course</h3>
              <div className="t-choices">{[0, 1, 2, 3].map((c) => <button key={c} className={(line.course ?? 0) === c ? "on" : ""} onClick={() => patch((x) => ({ ...x, course: c || undefined }))}>{c ? COURSE_NAMES[c] : "None"}</button>)}</div>
            </>
          )}
          {!line.sent && dineIn && (
            <>
              <h3 className="t-h3">Seat</h3>
              <div className="t-choices">{[1, 2, 3, 4, 5, 6].map((c) => <button key={c} className={(line.seat ?? 1) === c ? "on" : ""} onClick={() => patch((x) => ({ ...x, seat: c === 1 ? undefined : c }))}>Seat {c}</button>)}</div>
              <h3 className="t-h3">Kitchen status</h3>
              <div className="t-choices">
                <button className={!line.hold ? "on" : ""} onClick={() => patch((x) => ({ ...x, hold: undefined }))}>Fire</button>
                <button className={line.hold ? "on" : ""} onClick={() => patch((x) => ({ ...x, hold: true }))}>Hold</button>
              </div>
            </>
          )}
          {line.sent && line.hold && linked && (
            <div className="t-choices" style={{ marginTop: ".8em" }}><button onClick={() => void record(linked.orderId, { type: "LineFired", lineId: line.sent!.lineId, ...(staff ? { byName: staff.name } : {}) }).then(() => { patch((x) => ({ ...x, hold: undefined })); notify(`${line.item.name} sent to the kitchen.`); setDialog(null); })}>Fire this item to the kitchen now</button></div>
          )}
          <div className="t-sheetlist" style={{ marginTop: ".8em" }}>
            {!line.sent && line.item.options?.length ? <button onClick={() => { setDialog(null); setEditing(line); }}>Edit modifiers</button> : null}
            {!line.sent && <button onClick={() => { setDialog(null); setNoteFor({ scope: "line", key: line.key }); }}>{line.note ? "Edit note" : "Add a note for the kitchen"}</button>}
            {staff && <button onClick={() => { setDialog(null); setSheet({ scope: "line", key: line.key }); }}>Discount or change the price</button>}
            {line.discounts?.map((d) => <button key={d.id} onClick={() => patch((x) => ({ ...x, discounts: (x.discounts ?? []).filter((y) => y.id !== d.id) }))}>Remove discount · {d.kind === "percent" ? `${d.value}%` : formatMoney(d.value)} ({d.reason})</button>)}
            {line.override && <button onClick={() => patch((x) => ({ ...x, override: undefined }))}>Undo the price change</button>}
          </div>
          <div className="t-dact">
            {!line.sent && <button className="t-ghost danger" onClick={() => { setBag((cur) => cur.filter((x) => x.key !== line.key)); setDialog(null); }}>Remove item</button>}
            <button className="t-primary" onClick={() => setDialog(null)}>Done · {formatMoney(effUnit(line) * line.qty)}</button>
          </div>
        </Modal>
        );
      })()}
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
        // After it times out we keep looking for its payment for two more minutes (the server does the same), or until a new QR is made.
        const late = left > 0 ? 0 : Math.max(0, Math.ceil((qrPay.expiresAt + 120_000 - clock) / 1000));
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
                  {left > 0 ? <img src={qrPay.img} alt="PayNow QR" width={260} height={260} /> : <p style={{ margin: "60px 0" }}><b>This QR has timed out.</b></p>}
                  <p className="muted">{left > 0 ? `Waiting for the bank · valid ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : late > 0 ? `Still checking for a payment for ${Math.floor(late / 60)}:${String(late % 60).padStart(2, "0")} more. If the customer has not paid, tap New QR.` : "No payment found. Tap New QR if the customer still wants to pay."}</p>
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
          cta="Save changes" till
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
          cta="Add to order" till
          onClose={() => setPicking(null)}
          onAdd={(sel) => {
            addWith(picking, sel);
            setPicking(null);
          }}
        />
      )}
    </div>
    </>
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
