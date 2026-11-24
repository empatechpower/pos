import { confirmedPaid, formatMoney, lineFired, newId, nextCourse, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";
import { record } from "../db";
import type { FloorSettings } from "../floor";
import type { HeldOrder } from "./types";

/** A bar tab is an order whose "table" is a name starting with Tab: "Tab Alice", "Tab 7". */
export const isBarTab = (spot?: string): boolean => !!spot && /^tab\b/i.test(spot);
export const tabLabel = (spot: string): string => spot.replace(/^tab\s*/i, "") || spot;

/** Whether an order is still sitting at its table: sent, not paid up, not closed or merged away. */
export function isSeatedOrder(o: OrderState, config: BusinessConfig): boolean {
  if (o.stage === "cancelled" || o.stage === "completed" || o.mergedInto || o.voided || o.onTab || !o.spot || o.fulfilment !== "dine_in") return false;
  if (o.lines.filter((l) => l.qty > 0).length === 0) return false;
  return confirmedPaid(o) < orderTotals(o, config).total;
}

export type TableState = "available" | "seated" | "ordered" | "bill" | "paid" | "overdue";

/** How long a paid table is shown as "Paid · to clear" before it is taken to be free anyway. */
export const PAID_HOLD_MS = 3 * 3_600_000;
/** A table whose guests have paid and left it uncleared: its last order is fully paid and nobody has marked the table cleared. */
export function paidAwaitingClear(name: string, orders: OrderState[], config: BusinessConfig, now: number): OrderState | undefined {
  return orders
    .filter((o) => o.spot === name && o.fulfilment === "dine_in" && !o.clearedAt && !o.mergedInto && !o.voided && !o.onTab && o.stage !== "cancelled" && o.lines.some((l) => l.qty > 0) && (o.paidAt ?? 0) > now - PAID_HOLD_MS && confirmedPaid(o) >= orderTotals(o, config).total)
    .sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0))[0];
}
export const clearTable = (o: OrderState, byName?: string) => record(o.orderId, { type: "TableCleared", ...(byName ? { byName } : {}) });
export interface TableInfo {
  name: string;
  state: TableState;
  order?: OrderState;
  draft?: HeldOrder;
  /** Since seated, and since the last order was sent (epoch ms). */
  seatedAt?: number;
  lastSentAt?: number;
  totalCents?: number;
  /** 0 on time; 1-3 the longer it has been stale (the ring gets louder). */
  level: 0 | 1 | 2 | 3;
  guests?: number;
  /** For a "paid" table: the order that was paid, so it can be marked cleared. */
  paidOrder?: OrderState;
}

/** What is going on at one table or tab, from the open orders and the drafts held for it. */
export function tableInfo(name: string, orders: OrderState[], held: HeldOrder[], config: BusinessConfig, floor: FloorSettings, now: number): TableInfo {
  const order = orders.filter((o) => o.spot === name && isSeatedOrder(o, config)).sort((a, b) => a.openedAt - b.openedAt)[0];
  const draft = held.find((h) => h.spot === name && !h.orderId);
  const limit = Math.max(1, floor.overdueMinutes) * 60_000;
  const stale = (since: number): 0 | 1 | 2 | 3 => (now - since > limit ? (Math.min(3, Math.floor((now - since) / limit)) as 1 | 2 | 3) : 0);
  if (order) {
    const last = order.lastSentAt ?? order.openedAt;
    const level = order.billAskedAt ? 0 : stale(last);
    return { name, order, state: order.billAskedAt ? "bill" : level ? "overdue" : "ordered", seatedAt: order.openedAt, lastSentAt: last, totalCents: orderTotals(order, config).total, level, ...(order.pax ? { guests: order.pax } : {}) };
  }
  if (draft) {
    const level = stale(draft.savedAt);
    return { name, draft, state: level ? "overdue" : "seated", seatedAt: draft.savedAt, level, guests: draft.pax };
  }
  const paid = paidAwaitingClear(name, orders, config, now);
  if (paid) return { name, state: "paid", level: 0, paidOrder: paid, seatedAt: paid.openedAt };
  return { name, state: "available", level: 0 };
}

export const minutesSince = (t: number | undefined, now: number): string => (t ? `${Math.max(0, Math.floor((now - t) / 60_000))}m` : "—");

/** "Fire Course (2 of 3)": the next course to send, and where it sits among the order's courses. */
export function courseProgress(o: OrderState): { course: number; index: number; of: number } | null {
  const c = nextCourse(o);
  if (!c) return null;
  const all = [...new Set(o.lines.filter((l) => l.qty > 0 && l.course).map((l) => l.course as number))].sort((a, b) => a - b);
  return { course: c, index: all.indexOf(c) + 1, of: all.length };
}

export async function transferTable(o: OrderState, to: string, byName?: string): Promise<void> {
  await record(o.orderId, { type: "TableChanged", ...(o.spot ? { from: o.spot } : {}), to });
  void byName;
}

/** Why two orders cannot be merged, or null when they can. */
export function mergeProblem(from: OrderState, into: OrderState): string | null {
  if (from.orderId === into.orderId) return "Pick a different table.";
  const pay = (o: OrderState) => o.payments.length > 0;
  if (pay(from) || pay(into)) return "A table with a payment on it cannot be merged. Finish or refund the payment first.";
  if (from.split || into.split) return "A table with a split bill cannot be merged. Clear the split first.";
  if (from.discounts?.length) return `${from.spot} has a discount. Remove it first, so it is not lost in the merge.`;
  return null;
}

/**
 * Put one table's bill on another's. The table you start from keeps the bill: lines combine, guests add up, and the merged-away table is
 * freed. What the kitchen already has is carried over without printing again; a course still held goes over as it is.
 */
export async function mergeTables(from: OrderState, into: OrderState, byName?: string): Promise<string | null> {
  const bad = mergeProblem(from, into);
  if (bad) return bad;
  for (const l of from.lines.filter((x) => x.qty > 0)) {
    await record(into.orderId, {
      type: "ItemAdded", lineId: newId(), productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty,
      ...(l.bcrs !== undefined ? { bcrs: l.bcrs } : {}), ...(l.pointsExempt !== undefined ? { pointsExempt: l.pointsExempt } : {}),
      ...(l.taxInclusive !== undefined ? { taxInclusive: l.taxInclusive } : {}), ...(l.taxGroup ? { taxGroup: l.taxGroup } : {}),
      ...(l.options ? { options: l.options } : {}), ...(l.build ? { build: l.build } : {}),
      ...(l.course ? { course: l.course } : {}), ...(l.seat ? { seat: l.seat } : {}),
      ...(lineFired(from, l) ? { carried: true } : {}),
    });
  }
  if (from.pax || into.pax) await record(into.orderId, { type: "GuestsChanged", pax: (from.pax ?? 0) + (into.pax ?? 0), ...(byName ? { byName } : {}) });
  if (from.note) await record(into.orderId, { type: "OrderNoted", note: [into.note, from.note].filter(Boolean).join(" | "), ...(byName ? { byName } : {}) });
  await record(from.orderId, { type: "OrderMerged", into: into.orderId, ...(into.spot ? { intoSpot: into.spot } : {}), ...(byName ? { byName } : {}) });
  return null;
}

export const fireNextCourse = async (o: OrderState, byName?: string): Promise<boolean> => {
  const c = nextCourse(o);
  if (!c) return false;
  await record(o.orderId, { type: "CourseFired", course: c, ...(byName ? { byName } : {}) });
  return true;
};

export const askForBill = (o: OrderState, byName?: string) => record(o.orderId, { type: "BillRequested", ...(byName ? { byName } : {}) });

export const orderBrief = (o: OrderState, config: BusinessConfig): string => `${o.lines.filter((l) => l.qty > 0).reduce((n, l) => n + l.qty, 0)} items · ${formatMoney(orderTotals(o, config).total)}`;
