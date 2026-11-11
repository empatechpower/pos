import type { BusinessConfig } from "./config.js";
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
    }
  | { type: "OrderAccepted" }
  /** A coupon or voucher the member used. The discount is capped at the items subtotal; the minimum spend is on items only. */
  | { type: "CouponApplied"; title: string; amountCents: Cents; minSpendCents: Cents }
  /** Points the member spent on this order (100 points = S$1). Reduces what is owed. */
  | { type: "PointsRedeemed"; points: number }
  | { type: "ItemAdded"; lineId: string; productId: string; name: string; /** includes the price of any options */ unitCents: Cents; qty: number; bcrs?: boolean; pointsExempt?: boolean; options?: ChosenOption[] }
  | { type: "ItemQtySet"; lineId: string; qty: number }
  | { type: "PaymentRecorded"; paymentId: string; method: PaymentMethod; amountCents: Cents; /** false = awaiting gateway confirmation */ confirmed: boolean }
  | { type: "PaymentConfirmed"; paymentId: string }
  | { type: "StageSet"; stage: Exclude<OrderStage, "open"> };

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
  productId: string;
  options?: ChosenOption[];
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
  spot?: string;
  queueNumber?: string;
  openedAt: number;
  lines: OrderLine[];
  payments: Array<{ paymentId: string; method: PaymentMethod; amountCents: Cents; confirmed: boolean }>;
  stage: OrderStage;
  /** Time the order was first fully paid (confirmed). */
  paidAt?: number;
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
      state = { orderId, fulfilment: e.fulfilment, channelId: e.channelId, channelName: e.channelName, serviceCharge: e.serviceCharge, source: e.source ?? "pos", customerName: e.customerName, customerPhone: e.customerPhone, memberId: e.memberId, spot: e.spot, queueNumber: e.queueNumber, openedAt: e.ts, lines: [], payments: [], stage: "open" };
      continue;
    }
    if (!state) continue; // events that arrived before the open are applied once it exists on the next replay
    switch (e.type) {
      case "ItemAdded": {
        if (state.lines.some((l) => l.lineId === e.lineId)) break;
        state.lines.push({ lineId: e.lineId, productId: e.productId, name: e.name, unitCents: e.unitCents, qty: e.qty, bcrs: e.bcrs, pointsExempt: e.pointsExempt, options: e.options });
        break;
      }
      case "ItemQtySet": {
        const l = state.lines.find((x) => x.lineId === e.lineId);
        if (l) l.qty = Math.max(0, e.qty);
        break;
      }
      case "PaymentRecorded": {
        if (state.payments.some((p) => p.paymentId === e.paymentId)) break;
        state.payments.push({ paymentId: e.paymentId, method: e.method, amountCents: e.amountCents, confirmed: e.confirmed });
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
      case "StageSet":
        state.stage = e.stage;
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
  return priceOrder({ lines: state.lines, fulfilment: state.fulfilment, serviceCharge: state.serviceCharge, points, coupon: state.coupon ?? null, config: config.pricing });
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
  // A customer's own order is held until staff accept it, so a stranger cannot send tickets to the kitchen.
  if (state.source === "online" && !state.acceptedAt) return false;
  if (config.paymentTiming === "prepay") return isFullyPaid(state, config);
  return true;
}
