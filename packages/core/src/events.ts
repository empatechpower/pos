import { staffDiscountCents, type StaffDiscount } from "./discounts.js";
import { CUSTOM_TENDER_ID, cleanTenderName, recordedTender } from "./tenders.js";
import type { BusinessConfig } from "./config.js";
import type { StoredBuild } from "./builder.js";
import type { Fulfilment } from "./catalog.js";
import type { ChosenOption } from "./options.js";
import { type Cents } from "./money.js";
import { feeCentsOf, priceOrder, type OrderFee, type PriceResult, type PricedLine } from "./pricing.js";

/**
 * Orders are an append-only log of events, not a mutable record. Events are created on any
 * device (offline included) with device-generated ids, then merged by union. Replaying the
 * same set of events always yields the same order, whatever the arrival order.
 */

export type PaymentMethod = "cash" | "card" | "paynow" | "credit" | "other";
export type OrderStage = "open" | "preparing" | "ready" | "completed" | "cancelled";

export type OrderEventBody =
  | {
      type: "OrderOpened";
      fulfilment: Fulfilment;
      spot?: string;
      /** How many guests sat down (dine-in). */
      pax?: number;
      queueNumber?: string;
      /** Which channel the order was sold through, frozen at the moment it was opened. */
      channelId?: string;
      channelName?: string;
      serviceCharge?: boolean;
      /** Whether the outlet charged tax when the order was opened, frozen like the service charge. Missing on older orders: the shop's setting applies. */
      taxOn?: boolean;
      /** The service charge rate when the order was opened (0.09 = 9%), frozen so a later change of the shop's rate never reprices it. Missing on older orders. */
      serviceRate?: number;
      /** "online" = placed by a customer in the ordering app; the shop must accept it before the kitchen sees it. */
      source?: "pos" | "online";
      customerName?: string;
      customerPhone?: string;
      /** The signed-in member who placed it (set by the server only, never by a client). */
      memberId?: string;
      /** A round on a table's Tab (table service): it is sent to the kitchen without payment; the Tab is paid down later. */
      onTab?: boolean;
      /** A scheduled pickup: when the customer collects (epoch ms), and when the kitchen starts (that time less the outlet's prep time). Missing = ASAP. */
      scheduledFor?: number;
      fireAt?: number;
    }
  | { type: "OrderAccepted" }
  /** The moment a scheduled order is released to the kitchen (the server writes it at `fireAt`). Until then it is confirmed but not fired. */
  | { type: "OrderFired" }
  /** A coupon or voucher the member used. The discount is capped at the items subtotal; the minimum spend is on items only. */
  | { type: "CouponApplied"; title: string; amountCents: Cents; minSpendCents: Cents }
  /** Points the member spent on this order (100 points = S$1). Reduces what is owed. */
  | { type: "PointsRedeemed"; points: number }
  | { type: "ItemAdded"; lineId: string; productId: string; name: string; /** The item's barcode or SKU when it had one, as the receipt prints it before the name. */ sku?: string; /** includes the price of any options */ unitCents: Cents; qty: number; /** Table service: 1 = Starter, 2 = Main, 3 = Dessert. The kitchen gets it when that course is fired. Missing = no course, goes out at once. */ course?: number; /** The seat it was ordered for (split by seat). */ seat?: number; /** Moved here from a table that was merged in: the kitchen already has it, so it is not printed again. */ carried?: boolean; /** Sold through another dining channel than the order's (its price came from that channel's pricebook). */ channelId?: string; channelName?: string; /** Whether that other channel carries the service charge (the line then follows it, not the order). */ serviceCharge?: boolean; /** Held back from the kitchen until it is fired by hand, whatever its course (an exception to the course order). */ hold?: boolean; bcrs?: boolean; pointsExempt?: boolean; taxInclusive?: boolean; taxGroup?: string; options?: ChosenOption[]; /** Build-your-own: the frozen structured build. */ build?: StoredBuild }
  | { type: "ItemQtySet"; lineId: string; qty: number }
  /** The kitchen is told to start this course (table service). Lines with a later course wait. */
  | { type: "CourseFired"; course: number; byName?: string }
  /** A fee staff added to the whole order (a percentage of the items, or a fixed amount), and taking it off again. */
  | { type: "FeeApplied"; feeId: string; kind: "percent" | "amount"; value: number; label: string; byName?: string }
  | { type: "FeeRemoved"; feeId: string; byName?: string }
  /** One held item is sent to the kitchen. */
  | { type: "LineFired"; lineId: string; byName?: string }
  /** The guest count changed after the order was opened. */
  | { type: "GuestsChanged"; pax: number; byName?: string }
  /** The guest check was printed or the bill was asked for. */
  | { type: "BillRequested"; byName?: string }
  /** A paid table was wiped down and is free for the next guests. */
  | { type: "TableCleared"; byName?: string }
  /** This table was merged into another order: its lines now live there and it is closed. */
  | { type: "OrderMerged"; into: string; intoSpot?: string; byName?: string }
  /** The bill was split into checks. Each check has a fixed total (they add up to the order total) and, by item or seat, the units it carries. */
  | { type: "SplitCreated"; method: "even" | "manual" | "item" | "seat"; checks: Array<{ id: string; totalCents: Cents; seat?: number; shares?: Array<{ lineId: string; qty: number }> }>; byName?: string }
  | { type: "SplitCleared"; byName?: string }
  | { type: "PaymentRecorded"; paymentId: string; method: PaymentMethod; /** The named tender it was taken as (tenders.ts: card, debit, check, gift card...), when the till only recorded it. */ tender?: string; /** The shop's own name for it, when it is one of its custom tenders (a delivery platform, a gift certificate). */ tenderName?: string; /** The trace or reference number the cashier copied from the card terminal or the customer's payment screen, for a payment the till only recorded. */ reference?: string; amountCents: Cents; /** false = awaiting gateway confirmation */ confirmed: boolean; /** The cashier's shift this was taken in (the drawer it belongs to). */ shiftId?: string; /** The check of a split bill this payment settles. */ checkId?: string; /** Who took it (the signed-in person at the till, or "PayNow (automatic)"). Reports by staff read this. */ byName?: string; /** A short note on how it was taken (for a PayNow payment: whether the bank's alert was matched by the order's reference or only by the amount). */ note?: string; /** Cash handed over, when it was more than the payment (so the receipt can show the change). */ tenderedCents?: Cents }
  | { type: "PaymentConfirmed"; paymentId: string }
  | { type: "StageSet"; stage: Exclude<OrderStage, "open"> }
  /** The customer moved to another table after ordering: the same order, same status, now at `to`. The old table and the time are kept. */
  | { type: "TableChanged"; from?: string; to: string }
  /** The commission the channel's platform actually took on this order (its own promotions can differ from the contract rate). The latest one wins. */
  | { type: "CommissionRecorded"; cents: Cents; note?: string }
  /**
   * Money given back against one payment. Always approved by a manager (their own sign-in, or their PIN entered on the cashier's till).
   * It is kept as a negative payment, so what the order has taken is always the net.
   */
  | { type: "RefundRecorded"; refundId: string; /** the payment it gives back */ paymentId: string; method: PaymentMethod; amountCents: Cents; reason: string; approvedBy: string; approvedByName: string; /** part of voiding the whole order */ voided?: boolean; /** The shift whose drawer the money came out of. */ shiftId?: string }
  /** The whole order called off after it was sent or paid: every payment is refunded alongside and the order is closed as cancelled. */
  | { type: "OrderVoided"; reason: string; approvedBy: string; approvedByName: string }
  /** A discount a staff member gave, on one line or the whole bill. `approvedByName` is the manager who OK'd it when it was beyond what a cashier may give alone. */
  | { type: "DiscountApplied"; discountId: string; scope: "line" | "bill"; lineId?: string; kind: "percent" | "amount"; value: number; reason: string; byName?: string; approvedBy?: string; approvedByName?: string }
  | { type: "DiscountRemoved"; discountId: string; byName?: string }
  /** A note on the whole order for the kitchen and the guest check ("allergy: nuts", "birthday"). The latest one wins; empty clears it. */
  | { type: "OrderNoted"; note: string; byName?: string }
  /** The payment was rounded by the tender's rule (cash to five cents): what that added to the total (negative when it took off). The latest one stands. */
  | { type: "RoundingApplied"; cents: number; tender?: string; byName?: string }
  /** Someone signed in at a till that held another person's order and carried it on. For the order's trail only; it changes nothing on the order. */
  | { type: "OrderTakenOver"; from: string; byName?: string }
  /** The order was handed to whoever came for it (a delivery rider, the customer): who took it, and any reference they gave (a rider's card or id, the platform's order number). */
  | { type: "OrderHandedOver"; to: string; ref?: string; byName?: string }
  /** Staff attached a member to the order at the till (empty = taken off again). The server checks the member exists before it keeps this. */
  | { type: "MemberAttached"; memberId: string; byName?: string }
  /** The kitchen finished these lines (a station pressed Done), and later the floor served or handed them over. */
  | { type: "LinesReady"; lineIds: string[]; station?: string; byName?: string }
  | { type: "LinesServed"; lineIds: string[]; byName?: string }
  /** Add/Remove Tax: staff took the tax off the whole order, or put it back. Only where the country's tax pack allows it; a manager approves. */
  | { type: "TaxRemovalSet"; removed: boolean; reason: string; byName?: string; approvedBy?: string; approvedByName?: string }
  /** The price of one line changed by hand (the list price is kept). Always manager-approved. */
  | { type: "LinePriceOverridden"; lineId: string; unitCents: Cents; reason: string; byName?: string; approvedBy?: string; approvedByName?: string };

export type OrderEvent = OrderEventBody & {
  /** Globally unique, generated on the device that created the event. */
  id: string;
  orderId: string;
  deviceId: string;
  /** Device clock, ms. Only used for ordering; never trusted for money. */
  ts: number;
  /** Per-device counter, tie-breaker when ts is equal. */
  seq: number;
};

export interface OrderLine extends PricedLine {
  lineId: string;
  /** The price before it was changed by hand, and who changed it and why. */
  listUnitCents?: Cents;
  override?: { reason: string; byName?: string; approvedByName?: string; at: number };
  productId: string;
  /** The item's barcode or SKU at the time of sale. */
  sku?: string;
  options?: ChosenOption[];
  build?: StoredBuild;
  course?: number;
  seat?: number;
  carried?: boolean;
  channelId?: string;
  channelName?: string;
  /** Held from the kitchen until fired by hand. */
  held?: boolean;
  /** When the kitchen finished it, and when it was served or collected. */
  readyAt?: number;
  servedAt?: number;
}

export interface OrderState {
  orderId: string;
  fulfilment: Fulfilment;
  channelId?: string;
  channelName?: string;
  /** Whether the channel charged service. Undefined on older orders: fall back to dine-in. */
  serviceCharge?: boolean;
  /** Whether the outlet charged tax when the order was opened. Undefined on older orders: the shop's setting applies. */
  taxOn?: boolean;
  /** The service charge rate the order was opened at. Undefined on older orders: the shop's rate applies. */
  serviceRate?: number;
  source: "pos" | "online";
  customerName?: string;
  customerPhone?: string;
  memberId?: string;
  coupon?: { title: string; amountCents: Cents; minSpendCents: Cents };
  /** Points spent on this order; they pay for part of the bill. */
  pointsRedeemed?: number;
  /** When staff accepted an online order. Always unset for POS orders, which need no acceptance. */
  acceptedAt?: number;
  /** A round on a Tab: not paid at ordering, never held back for payment, and its receipt is the Tab's. */
  onTab?: boolean;
  /** Scheduled pickup: when it is collected, when the kitchen should start, and when it was actually released to the kitchen. */
  scheduledFor?: number;
  fireAt?: number;
  firedAt?: number;
  spot?: string;
  /** How many guests sat down, when it was counted. */
  pax?: number;
  /** The actual commission recorded for this order, when one was entered. */
  commission?: { cents: Cents; note?: string; at: number };
  /** Money given back, oldest first. */
  refunds?: Array<{ refundId: string; paymentId: string; method: PaymentMethod; amountCents: Cents; reason: string; approvedBy: string; approvedByName: string; at: number; voided?: boolean }>;
  /** The note on the whole order (for the kitchen and the guest check). */
  note?: string;
  /** Discounts staff gave, oldest first. */
  discounts?: StaffDiscount[];
  /** Set when the whole order was voided. */
  voided?: { reason: string; approvedBy: string; approvedByName: string; at: number };
  /** What rounding at payment added to the total (negative when it took off). */
  roundingCents?: number;
  /** Who collected the order, when it was handed over at the counter (the first handover stands; a second is ignored). */
  handover?: { to: string; ref?: string; byName?: string; at: number };
  /** Set while the tax is taken off this order (Add/Remove Tax). */
  taxRemoved?: { reason: string; byName?: string; approvedByName?: string; at: number };
  /** Fees staff added to the whole order. */
  fees?: OrderFee[];
  /** Courses the kitchen has been told to start. */
  firedCourses?: number[];
  /** When items were last sent for this order (not counting lines moved in from a merged table). */
  lastSentAt?: number;
  /** When the guest check was printed / the bill asked for. */
  billAskedAt?: number;
  /** When staff marked the paid table as cleared. */
  clearedAt?: number;
  /** Set when this table was merged into another order. */
  mergedInto?: { orderId: string; spot?: string; at: number };
  /** The bill split into checks, when it is. */
  split?: { method: "even" | "manual" | "item" | "seat"; at: number; checks: Array<{ id: string; no: number; totalCents: Cents; seat?: number; shares?: Array<{ lineId: string; qty: number }> }> };
  /** Every table move after the order was placed, oldest first. */
  tableChanges?: Array<{ from?: string; to: string; at: number }>;
  queueNumber?: string;
  openedAt: number;
  lines: OrderLine[];
  payments: Array<{ paymentId: string; method: PaymentMethod; tender?: string; tenderName?: string; reference?: string; amountCents: Cents; confirmed: boolean; shiftId?: string; checkId?: string; tenderedCents?: Cents; byName?: string }>;
  stage: OrderStage;
  /** Time the order was first fully paid (confirmed). */
  paidAt?: number;
  /** When the kitchen first marked it ready. Used to learn how long orders really take. */
  readyAt?: number;
  /** When the order was first completed or cancelled. */
  closedAt?: number;
}

export const newId = (): string =>
  globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Deterministic order of events regardless of arrival order. */
export const compareEvents = (a: OrderEvent, b: OrderEvent): number =>
  a.ts - b.ts || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq || a.id.localeCompare(b.id);

/** Merge two event sets, de-duplicating by id. Safe to call repeatedly (idempotent). */
export function mergeEvents(a: readonly OrderEvent[], b: readonly OrderEvent[]): OrderEvent[] {
  const byId = new Map<string, OrderEvent>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort(compareEvents);
}

/** Rebuild one order from its events. Returns null until an OrderOpened event is present. */
export function reduceOrder(orderId: string, events: readonly OrderEvent[]): OrderState | null {
  const mine = mergeEvents(events.filter((e) => e.orderId === orderId), []);
  let state: OrderState | null = null;
  for (const e of mine) {
    if (e.type === "OrderOpened") {
      if (state) continue; // first open wins
      state = { orderId, fulfilment: e.fulfilment, channelId: e.channelId, channelName: e.channelName, serviceCharge: e.serviceCharge, ...(typeof e.taxOn === "boolean" ? { taxOn: e.taxOn } : {}), ...(typeof e.serviceRate === "number" && e.serviceRate >= 0 && e.serviceRate <= 0.5 ? { serviceRate: e.serviceRate } : {}), source: e.source ?? "pos", customerName: e.customerName, customerPhone: e.customerPhone, memberId: e.memberId, scheduledFor: e.scheduledFor, fireAt: e.fireAt, ...(e.onTab ? { onTab: true } : {}), spot: e.spot, ...(Number.isInteger(e.pax) && (e.pax as number) > 0 ? { pax: e.pax } : {}), queueNumber: e.queueNumber, openedAt: e.ts, lines: [], payments: [], stage: "open" };
      continue;
    }
    if (!state) continue; // events that arrived before the open are applied once it exists on the next replay
    switch (e.type) {
      case "ItemAdded": {
        if (state.lines.some((l) => l.lineId === e.lineId)) break;
        state.lines.push({ lineId: e.lineId, productId: e.productId, name: e.name, ...(typeof e.sku === "string" && e.sku ? { sku: e.sku.slice(0, 40) } : {}), ...(e.channelId && typeof e.serviceCharge === "boolean" ? { serviceCharge: e.serviceCharge } : {}), unitCents: e.unitCents, qty: e.qty, bcrs: e.bcrs, pointsExempt: e.pointsExempt, ...(e.taxInclusive !== undefined ? { taxInclusive: e.taxInclusive } : {}), ...(e.taxGroup ? { taxGroup: e.taxGroup } : {}), ...(e.build ? { build: e.build } : {}), ...(e.course ? { course: e.course } : {}), ...(e.seat ? { seat: e.seat } : {}), ...(e.carried ? { carried: true } : {}), ...(e.channelId ? { channelId: e.channelId, ...(e.channelName ? { channelName: e.channelName } : {}) } : {}), ...(e.hold ? { held: true } : {}), options: e.options });
        if (!e.carried && !e.hold) state.lastSentAt = e.ts;
        break;
      }
      case "ItemQtySet": {
        const l = state.lines.find((x) => x.lineId === e.lineId);
        if (l) l.qty = Math.max(0, e.qty);
        break;
      }
      case "PaymentRecorded": {
        if (state.payments.some((p) => p.paymentId === e.paymentId)) break;
        state.payments.push({ paymentId: e.paymentId, method: e.method, ...(recordedTender(e.tender) ? { tender: e.tender } : e.tender && CUSTOM_TENDER_ID.test(e.tender) && cleanTenderName(e.tenderName) ? { tender: e.tender, tenderName: cleanTenderName(e.tenderName) } : {}), ...(typeof e.reference === "string" && e.reference.trim() ? { reference: e.reference.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 40) } : {}), amountCents: e.amountCents, confirmed: e.confirmed, ...(e.shiftId ? { shiftId: e.shiftId } : {}), ...(e.checkId ? { checkId: e.checkId } : {}), ...(e.byName ? { byName: String(e.byName).slice(0, 60) } : {}), ...(e.tenderedCents && e.tenderedCents > e.amountCents ? { tenderedCents: Math.round(e.tenderedCents) } : {}) });
        break;
      }
      case "PaymentConfirmed": {
        const p = state.payments.find((x) => x.paymentId === e.paymentId);
        if (p) p.confirmed = true;
        break;
      }
      case "CouponApplied":
        state.coupon ??= { title: e.title, amountCents: e.amountCents, minSpendCents: e.minSpendCents }; // once only
        break;
      case "PointsRedeemed":
        state.pointsRedeemed ??= Math.max(0, Math.floor(e.points)); // once only
        break;
      case "OrderAccepted":
        state.acceptedAt ??= e.ts;
        break;
      case "OrderFired":
        state.firedAt ??= e.ts;
        break;
      case "RefundRecorded": {
        if (state.refunds?.some((r) => r.refundId === e.refundId)) break;
        const amountCents = Math.max(0, Math.round(e.amountCents));
        (state.refunds ??= []).push({ refundId: e.refundId, paymentId: e.paymentId, method: e.method, amountCents, reason: e.reason.slice(0, 200), approvedBy: e.approvedBy, approvedByName: e.approvedByName, at: e.ts, ...(e.voided ? { voided: true } : {}) });
        const orig = state.payments.find((x) => x.paymentId === e.paymentId);
        state.payments.push({ paymentId: `refund:${e.refundId}`, method: e.method, amountCents: -amountCents, confirmed: true, ...(orig?.checkId ? { checkId: orig.checkId } : {}) });
        break;
      }
      case "OrderVoided":
        state.voided ??= { reason: e.reason.slice(0, 200), approvedBy: e.approvedBy, approvedByName: e.approvedByName, at: e.ts };
        state.stage = "cancelled";
        state.closedAt ??= e.ts;
        break;
      case "DiscountApplied":
        if (state.discounts?.some((d) => d.id === e.discountId)) break;
        (state.discounts ??= []).push({ id: e.discountId, scope: e.scope, ...(e.lineId ? { lineId: e.lineId } : {}), kind: e.kind, value: e.value, reason: e.reason.slice(0, 120), ...(e.byName ? { byName: e.byName } : {}), ...(e.approvedByName ? { approvedByName: e.approvedByName } : {}), at: e.ts });
        break;
      case "OrderNoted": {
        const note = e.note.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        if (note) state.note = note; else delete state.note;
        break;
      }
      case "TaxRemovalSet":
        if (e.removed) state.taxRemoved = { reason: String(e.reason ?? "").slice(0, 120), ...(e.byName ? { byName: e.byName } : {}), ...(e.approvedByName ? { approvedByName: e.approvedByName } : {}), at: e.ts };
        else delete state.taxRemoved;
        break;
      case "DiscountRemoved":
        if (state.discounts) state.discounts = state.discounts.filter((d) => d.id !== e.discountId);
        break;
      case "LinePriceOverridden": {
        const l = state.lines.find((x) => x.lineId === e.lineId);
        if (!l || e.unitCents < 0) break;
        l.listUnitCents ??= l.unitCents;
        l.unitCents = Math.round(e.unitCents);
        l.override = { reason: e.reason.slice(0, 120), ...(e.byName ? { byName: e.byName } : {}), ...(e.approvedByName ? { approvedByName: e.approvedByName } : {}), at: e.ts };
        break;
      }
      case "CourseFired":
        if (Number.isInteger(e.course) && e.course >= 1 && !(state.firedCourses ?? []).includes(e.course)) state.firedCourses = [...(state.firedCourses ?? []), e.course].sort((a, b) => a - b);
        break;
      case "FeeApplied":
        if (state.fees?.some((f) => f.id === e.feeId) || !(e.value > 0) || (e.kind === "percent" && e.value > 100)) break;
        (state.fees ??= []).push({ id: e.feeId, kind: e.kind, value: e.kind === "percent" ? e.value : Math.round(e.value), label: String(e.label ?? "Service fee").slice(0, 40) });
        break;
      case "FeeRemoved":
        if (state.fees) state.fees = state.fees.filter((f) => f.id !== e.feeId);
        break;
      case "LineFired": {
        const l = state.lines.find((x) => x.lineId === e.lineId);
        if (l?.held) { delete l.held; state.lastSentAt = e.ts; }
        break;
      }
      case "GuestsChanged":
        if (Number.isInteger(e.pax) && e.pax > 0 && e.pax < 100) state.pax = e.pax;
        break;
      case "BillRequested":
        state.billAskedAt = e.ts;
        break;
      case "TableCleared":
        state.clearedAt = e.ts;
        break;
      case "OrderMerged":
        if (state.mergedInto) break;
        state.mergedInto = { orderId: e.into, ...(e.intoSpot ? { spot: e.intoSpot } : {}), at: e.ts };
        state.stage = "cancelled";
        state.closedAt ??= e.ts;
        break;
      case "SplitCreated":
        if (state.split || !e.checks?.length) break;
        state.split = { method: e.method, at: e.ts, checks: e.checks.map((c, i) => ({ id: c.id, no: i + 1, totalCents: Math.max(0, Math.round(c.totalCents)), ...(c.seat ? { seat: c.seat } : {}), ...(c.shares ? { shares: c.shares } : {}) })) };
        break;
      case "SplitCleared":
        delete state.split;
        break;
      case "CommissionRecorded":
        state.commission = { cents: Math.max(0, Math.round(e.cents)), ...(e.note ? { note: e.note.slice(0, 120) } : {}), at: e.ts };
        break;
      case "TableChanged":
        if (state.stage === "completed" || state.stage === "cancelled") break;
        (state.tableChanges ??= []).push({ ...(state.spot ? { from: state.spot } : {}), to: e.to, at: e.ts });
        state.spot = e.to;
        break;
      case "OrderHandedOver": {
        const to = String(e.to ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (to && !state.handover) state.handover = { to, ...(typeof e.ref === "string" && e.ref.trim() ? { ref: e.ref.trim().slice(0, 60) } : {}), ...(e.byName ? { byName: String(e.byName).slice(0, 60) } : {}), at: e.ts };
        break;
      }
      case "RoundingApplied":
        if (Number.isInteger(e.cents) && Math.abs(e.cents) < 100) { if (e.cents) state.roundingCents = e.cents; else delete state.roundingCents; }
        break;
      case "MemberAttached":
        if (typeof e.memberId === "string" && e.memberId) state.memberId = e.memberId.slice(0, 64); else delete state.memberId;
        break;
      case "LinesReady":
        for (const l of state.lines) if (Array.isArray(e.lineIds) && e.lineIds.includes(l.lineId)) l.readyAt ??= e.ts;
        break;
      case "LinesServed":
        for (const l of state.lines) if (Array.isArray(e.lineIds) && e.lineIds.includes(l.lineId)) { l.readyAt ??= e.ts; l.servedAt ??= e.ts; }
        break;
      case "StageSet":
        state.stage = e.stage;
        // The whole order marked ready (or handed over) covers every line the kitchen had by then; a course fired later starts afresh.
        if (e.stage === "ready" || e.stage === "completed") for (const l of state.lines) if (l.qty > 0 && lineFired(state, l)) { l.readyAt ??= e.ts; if (e.stage === "completed") l.servedAt ??= e.ts; }
        if (e.stage === "ready") state.readyAt ??= e.ts;
        if (e.stage === "completed" || e.stage === "cancelled") state.closedAt ??= e.ts;
        break;
    }
    if (!state.paidAt && isFullyPaid(state, undefined)) state.paidAt = e.ts;
  }
  return state;
}

/** Group a mixed event log into orders (newest first). */
export function reduceAll(events: readonly OrderEvent[]): OrderState[] {
  const ids = [...new Set(events.map((e) => e.orderId))];
  return ids
    .map((id) => reduceOrder(id, events))
    .filter((o): o is OrderState => o !== null)
    .sort((a, b) => b.openedAt - a.openedAt);
}

/** The shop's pricing rules with what the order froze when it opened: whether tax was charged, and the service charge rate. */
function frozenPricing(state: Pick<OrderState, "taxOn" | "serviceRate">, p: BusinessConfig["pricing"]): BusinessConfig["pricing"] {
  const tax = state.taxOn !== undefined && state.taxOn !== p.gstOn, rate = state.serviceRate !== undefined && state.serviceRate !== p.serviceRate;
  return tax || rate ? { ...p, ...(tax ? { gstOn: state.taxOn! } : {}), ...(rate ? { serviceRate: state.serviceRate! } : {}) } : p;
}

export function orderTotals(state: OrderState, config: BusinessConfig): PriceResult {
  const points = state.pointsRedeemed ? { balance: state.pointsRedeemed, requested: state.pointsRedeemed } : null;
  const input = { lines: state.lines, fulfilment: state.fulfilment, serviceCharge: state.serviceCharge, points, coupon: state.coupon ?? null, discountCents: staffDiscountCents(state.lines, state.discounts ?? []).totalCents, ...(state.taxRemoved ? { taxRemoved: true } : {}), ...(state.roundingCents ? { roundingCents: state.roundingCents } : {}), config: frozenPricing(state, config.pricing) };
  const plain = priceOrder(input);
  // A fee on the whole order: a percentage is of the items left after discounts.
  const fee = state.fees?.length ? feeCentsOf(state.fees, plain.subtotal - plain.couponDiscount - plain.discountCents) : 0;
  return fee ? priceOrder({ ...input, feeCents: fee }) : plain;
}

export const confirmedPaid = (state: OrderState): Cents =>
  state.payments.filter((p) => p.confirmed).reduce((n, p) => n + p.amountCents, 0);

export function isFullyPaid(state: OrderState, config: BusinessConfig | undefined): boolean {
  if (state.lines.every((l) => l.qty === 0) || state.lines.length === 0) return false;
  if (!config) return confirmedPaid(state) > 0; // used only to stamp paidAt during replay
  return confirmedPaid(state) >= orderTotals(state, config).total;
}

/**
 * When may the kitchen see an order? This is where payment timing changes behaviour:
 *  prepay   -> only once paid;  postpay/deferred -> as soon as there are items.
 */
export function visibleToKitchen(state: OrderState, config: BusinessConfig): boolean {
  if (!config.modules.kitchen) return false;
  if (state.stage === "cancelled" || state.lines.length === 0) return false;
  // A scheduled order is confirmed but not fired: the kitchen does not see it until the server releases it (its slot less the prep time).
  if (state.fireAt !== undefined && state.firedAt === undefined) return false;
  // A customer's own order is held until staff accept it, so a stranger cannot send tickets to the kitchen.
  if (state.source === "online" && !state.acceptedAt) return false;
  if (config.paymentTiming === "prepay" && !state.onTab) return isFullyPaid(state, config);
  return true;
}

/** Whether a line has been released to the kitchen: lines with no course always are; a course's lines wait for it to be fired. */
export const lineFired = (state: OrderState, l: { course?: number; held?: boolean }): boolean => !l.held && (!l.course || (state.firedCourses ?? []).includes(l.course));

/** The lowest course that has lines and has not been fired. */
export function nextCourse(state: OrderState): number | undefined {
  const fired = state.firedCourses ?? [];
  return state.lines.filter((l) => l.qty > 0 && l.course && !fired.includes(l.course)).map((l) => l.course as number).sort((a, b) => a - b)[0];
}

/** What a check of a split bill has taken, and what is still owed on it. */
export function checkStanding(state: OrderState, checkId: string): { totalCents: Cents; paidCents: Cents; dueCents: Cents } | null {
  const c = state.split?.checks.find((x) => x.id === checkId);
  if (!c) return null;
  const paid = state.payments.filter((p) => p.checkId === checkId && p.confirmed).reduce((n, p) => n + p.amountCents, 0);
  return { totalCents: c.totalCents, paidCents: paid, dueCents: Math.max(0, c.totalCents - paid) };
}

/**
 * What the kitchen still has to make on an order, what is made and waiting to go out, and what has gone. Only lines the kitchen has been
 * given count: a held line or a course not yet fired is none of these. A cancelled or voided order has nothing to make.
 */
export function kitchenLines(state: OrderState): { toMake: OrderLine[]; ready: OrderLine[]; served: OrderLine[] } {
  const live = state.voided || state.stage === "cancelled" ? [] : state.lines.filter((l) => l.qty > 0 && lineFired(state, l));
  return { toMake: live.filter((l) => !l.readyAt), ready: live.filter((l) => l.readyAt && !l.servedAt), served: live.filter((l) => l.servedAt) };
}

export const COURSE_NAMES: Record<number, string> = { 1: "Starter", 2: "Main", 3: "Dessert" };
