import { staffDiscountCents, type StaffDiscount } from "./discounts.js";
import type { BusinessConfig } from "./config.js";
import type { StoredBuild } from "./builder.js";
import type { Fulfilment } from "./catalog.js";
import type { ChosenOption } from "./options.js";
import { type Cents } from "./money.js";
import { priceOrder, type PriceResult, type PricedLine } from "./pricing.js";

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
  | { type: "ItemAdded"; lineId: string; productId: string; name: string; /** includes the price of any options */ unitCents: Cents; qty: number; /** Table service: 1 = Starter, 2 = Main, 3 = Dessert. The kitchen gets it when that course is fired. Missing = no course, goes out at once. */ course?: number; /** The seat it was ordered for (split by seat). */ seat?: number; /** Moved here from a table that was merged in: the kitchen already has it, so it is not printed again. */ carried?: boolean; bcrs?: boolean; pointsExempt?: boolean; taxInclusive?: boolean; taxGroup?: string; options?: ChosenOption[]; /** Build-your-own: the frozen structured build. */ build?: StoredBuild }
  | { type: "ItemQtySet"; lineId: string; qty: number }
  /** The kitchen is told to start this course (table service). Lines with a later course wait. */
  | { type: "CourseFired"; course: number; byName?: string }
  /** The guest count changed after the order was opened. */
  | { type: "GuestsChanged"; pax: number; byName?: string }
  /** The guest check was printed or the bill was asked for. */
  | { type: "BillRequested"; byName?: string }
  /** This table was merged into another order: its lines now live there and it is closed. */
  | { type: "OrderMerged"; into: string; intoSpot?: string; byName?: string }
  /** The bill was split into checks. Each check has a fixed total (they add up to the order total) and, by item or seat, the units it carries. */
  | { type: "SplitCreated"; method: "even" | "manual" | "item" | "seat"; checks: Array<{ id: string; totalCents: Cents; seat?: number; shares?: Array<{ lineId: string; qty: number }> }>; byName?: string }
  | { type: "SplitCleared"; byName?: string }
  | { type: "PaymentRecorded"; paymentId: string; method: PaymentMethod; amountCents: Cents; /** false = awaiting gateway confirmation */ confirmed: boolean; /** The cashier's shift this was taken in (the drawer it belongs to). */ shiftId?: string; /** The check of a split bill this payment settles. */ checkId?: string }
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
  options?: ChosenOption[];
  build?: StoredBuild;
  course?: number;
  seat?: number;
  carried?: boolean;
}

export interface OrderState {
  orderId: string;
  fulfilment: Fulfilment;
  channelId?: string;
  channelName?: string;
  /** Whether the channel charged service. Undefined on older orders: fall back to dine-in. */
  serviceCharge?: boolean;
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
  /** Courses the kitchen has been told to start. */
  firedCourses?: number[];
  /** When items were last sent for this order (not counting lines moved in from a merged table). */
  lastSentAt?: number;
  /** When the guest check was printed / the bill asked for. */
  billAskedAt?: number;
  /** Set when this table was merged into another order. */
  mergedInto?: { orderId: string; spot?: string; at: number };
  /** The bill split into checks, when it is. */
  split?: { method: "even" | "manual" | "item" | "seat"; at: number; checks: Array<{ id: string; no: number; totalCents: Cents; seat?: number; shares?: Array<{ lineId: string; qty: number }> }> };
  /** Every table move after the order was placed, oldest first. */
  tableChanges?: Array<{ from?: string; to: string; at: number }>;
  queueNumber?: string;
  openedAt: number;
  lines: OrderLine[];
  payments: Array<{ paymentId: string; method: PaymentMethod; amountCents: Cents; confirmed: boolean; shiftId?: string; checkId?: string }>;
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
      state = { orderId, fulfilment: e.fulfilment, channelId: e.channelId, channelName: e.channelName, serviceCharge: e.serviceCharge, source: e.source ?? "pos", customerName: e.customerName, customerPhone: e.customerPhone, memberId: e.memberId, scheduledFor: e.scheduledFor, fireAt: e.fireAt, ...(e.onTab ? { onTab: true } : {}), spot: e.spot, ...(Number.isInteger(e.pax) && (e.pax as number) > 0 ? { pax: e.pax } : {}), queueNumber: e.queueNumber, openedAt: e.ts, lines: [], payments: [], stage: "open" };
      continue;
    }
    if (!state) continue; // events that arrived before the open are applied once it exists on the next replay
    switch (e.type) {
      case "ItemAdded": {
        if (state.lines.some((l) => l.lineId === e.lineId)) break;
        state.lines.push({ lineId: e.lineId, productId: e.productId, name: e.name, unitCents: e.unitCents, qty: e.qty, bcrs: e.bcrs, pointsExempt: e.pointsExempt, ...(e.taxInclusive !== undefined ? { taxInclusive: e.taxInclusive } : {}), ...(e.taxGroup ? { taxGroup: e.taxGroup } : {}), ...(e.build ? { build: e.build } : {}), ...(e.course ? { course: e.course } : {}), ...(e.seat ? { seat: e.seat } : {}), ...(e.carried ? { carried: true } : {}), options: e.options });
        if (!e.carried) state.lastSentAt = e.ts;
        break;
      }
      case "ItemQtySet": {
        const l = state.lines.find((x) => x.lineId === e.lineId);
        if (l) l.qty = Math.max(0, e.qty);
        break;
      }
      case "PaymentRecorded": {
        if (state.payments.some((p) => p.paymentId === e.paymentId)) break;
        state.payments.push({ paymentId: e.paymentId, method: e.method, amountCents: e.amountCents, confirmed: e.confirmed, ...(e.shiftId ? { shiftId: e.shiftId } : {}), ...(e.checkId ? { checkId: e.checkId } : {}) });
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
      case "GuestsChanged":
        if (Number.isInteger(e.pax) && e.pax > 0 && e.pax < 100) state.pax = e.pax;
        break;
      case "BillRequested":
        state.billAskedAt = e.ts;
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
      case "StageSet":
        state.stage = e.stage;
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

export function orderTotals(state: OrderState, config: BusinessConfig): PriceResult {
  const points = state.pointsRedeemed ? { balance: state.pointsRedeemed, requested: state.pointsRedeemed } : null;
  return priceOrder({ lines: state.lines, fulfilment: state.fulfilment, serviceCharge: state.serviceCharge, points, coupon: state.coupon ?? null, discountCents: staffDiscountCents(state.lines, state.discounts ?? []).totalCents, config: config.pricing });
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
export const lineFired = (state: OrderState, l: { course?: number }): boolean => !l.course || (state.firedCourses ?? []).includes(l.course);

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

export const COURSE_NAMES: Record<number, string> = { 1: "Starter", 2: "Main", 3: "Dessert" };
