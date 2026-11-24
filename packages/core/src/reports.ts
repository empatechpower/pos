import type { Cents } from "./money.js";
import type { BusinessConfig } from "./config.js";
import { confirmedPaid, orderTotals, type OrderState } from "./events.js";
import { staffDiscountCents } from "./discounts.js";

/** Singapore day and hour of a timestamp. Reports are read in the outlet's own time. */
const TZ = "Asia/Singapore";
export const reportDay = (ms: number): string => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
export const reportHour = (ms: number): number => Number(new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }).slice(0, 2));
/** 0 = Sunday ... 6 = Saturday, Singapore time. */
export const reportWeekday = (ms: number): number => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ }));

export interface SalesSummary {
  orders: number;
  items: number;
  /** Items sold, before any discount. */
  grossCents: Cents;
  /** Coupon / voucher, staff discounts, and points paid toward the bill. */
  discountsCents: Cents;
  couponCents: Cents;
  /** Discounts staff gave on lines or the bill. */
  manualCents: Cents;
  pointsCents: Cents;
  /** Gross sales minus discounts. */
  netCents: Cents;
  serviceCents: Cents;
  gstCents: Cents;
  /** Container deposits: held for the customer's return, not sales. */
  liabilitiesCents: Cents;
  /** Net sales + service + GST + liabilities: what the till has to account for. */
  netToAccountForCents: Cents;
  averageCents: Cents;
  payments: Array<{ method: string; cents: Cents; count: number }>;
  paidCents: Cents;
  unpaidOrders: number;
  voided: { orders: number; cents: Cents };
}

/** The Sales Summary: did we make money? Cancelled orders are counted apart as voided, never in the sales. */
export function summarize(all: readonly OrderState[], config: BusinessConfig): SalesSummary {
  const s: SalesSummary = {
    orders: 0, items: 0, grossCents: 0, discountsCents: 0, couponCents: 0, manualCents: 0, pointsCents: 0, netCents: 0, serviceCents: 0, gstCents: 0, liabilitiesCents: 0,
    netToAccountForCents: 0, averageCents: 0, payments: [], paidCents: 0, unpaidOrders: 0, voided: { orders: 0, cents: 0 },
  };
  const pay = new Map<string, { cents: number; count: number }>();
  for (const o of all) {
    if (!o.lines.some((l) => l.qty > 0)) continue;
    const t = orderTotals(o, config);
    if (o.stage === "cancelled") { s.voided.orders++; s.voided.cents += t.total; continue; }
    s.orders++;
    s.items += o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0);
    s.grossCents += t.subtotal;
    s.couponCents += t.couponDiscount;
    s.manualCents += t.discountCents;
    s.pointsCents += t.pointsDiscount;
    s.serviceCents += t.service;
    s.gstCents += t.gst;
    s.liabilitiesCents += t.bcrs;
    s.netToAccountForCents += t.total;
    const paid = confirmedPaid(o);
    s.paidCents += paid;
    if (paid < t.total) s.unpaidOrders++;
    for (const p of o.payments) {
      if (!p.confirmed) continue;
      const x = pay.get(p.method) ?? { cents: 0, count: 0 };
      x.cents += p.amountCents; x.count++; pay.set(p.method, x);
    }
  }
  s.discountsCents = s.couponCents + s.manualCents + s.pointsCents;
  s.netCents = s.grossCents - s.discountsCents;
  s.averageCents = s.orders ? Math.round(s.netToAccountForCents / s.orders) : 0;
  s.payments = [...pay].map(([method, v]) => ({ method, cents: v.cents, count: v.count })).sort((a, b) => b.cents - a.cents);
  return s;
}

export interface HourRow { hour: number; orders: number; items: number; averageCents: Cents; cents: Cents }

/** Hourly Sales: when are we busy? One row per hour that had orders, with transactions, items, average and total. */
export function hourly(all: readonly OrderState[], config: BusinessConfig): HourRow[] {
  const m = new Map<number, { orders: number; items: number; cents: number }>();
  for (const o of all) {
    if (o.stage === "cancelled" || !o.lines.some((l) => l.qty > 0)) continue;
    const x = m.get(reportHour(o.openedAt)) ?? { orders: 0, items: 0, cents: 0 };
    x.orders++; x.items += o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0); x.cents += orderTotals(o, config).total;
    m.set(reportHour(o.openedAt), x);
  }
  return [...m].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, orders: v.orders, items: v.items, averageCents: Math.round(v.cents / v.orders), cents: v.cents }));
}

export interface MixRow { name: string; category: string; qty: number; cents: Cents; averageCents: Cents; share: number }
export interface MixFilter { category?: string; channel?: string; weekday?: number }

/** Product Mix: what sold, what didn't. Revenue is the item price before discounts; share is of all item sales in the selection. */
export function productMix(all: readonly OrderState[], categoryOf: (productId: string) => string, filter: MixFilter = {}): MixRow[] {
  const m = new Map<string, { name: string; category: string; qty: number; cents: number }>();
  let total = 0;
  for (const o of all) {
    if (o.stage === "cancelled") continue;
    if (filter.channel && (o.channelName ?? o.fulfilment) !== filter.channel) continue;
    if (filter.weekday !== undefined && reportWeekday(o.openedAt) !== filter.weekday) continue;
    for (const l of o.lines) {
      if (l.qty <= 0) continue;
      const category = categoryOf(l.productId) || "Other";
      if (filter.category && category !== filter.category) continue;
      const x = m.get(l.name) ?? { name: l.name, category, qty: 0, cents: 0 };
      x.qty += l.qty; x.cents += l.unitCents * l.qty; total += l.unitCents * l.qty; m.set(l.name, x);
    }
  }
  return [...m.values()].map((x) => ({ ...x, averageCents: Math.round(x.cents / x.qty), share: total ? x.cents / total : 0 })).sort((a, b) => b.qty - a.qty || b.cents - a.cents);
}

/**
 * What a channel's platform took on one order, when this merchant records commission for the channel (an opt-in, Q&A A-5).
 * The figure entered for the order wins (it is the actual one, which can differ from the contract during platform promotions);
 * without one it is the contract rate on the order total. Null when the channel does not record commission.
 */
export function commissionOf(order: { commission?: { cents: number } }, totalCents: number, channel: { commission?: { ratePct: number } } | undefined): { cents: number; source: "actual" | "contract" } | null {
  if (!channel?.commission) return null;
  if (order.commission) return { cents: order.commission.cents, source: "actual" };
  return { cents: Math.round((totalCents * channel.commission.ratePct) / 100), source: "contract" };
}

/** What one person did at the till in the period: what they took, refunded (as the approver), discounted and voided. */
export interface StaffRow {
  name: string;
  /** Payments taken, and the money in them, in total and by way of paying. */
  payments: number;
  takenCents: Cents;
  byMethod: Record<string, Cents>;
  /** Orders they took a payment on. */
  orders: number;
  /** Refunds they approved. */
  refunds: number;
  refundedCents: Cents;
  /** Discounts they gave. */
  discounts: number;
  discountCents: Cents;
  /** Whole orders voided on their approval. */
  voids: number;
  voidedCents: Cents;
  /** Taken less refunded. */
  netCents: Cents;
  averageCents: Cents;
}

/**
 * Sales by person. A payment belongs to whoever took it (the name stamped on it; for older payments the owner of the shift it was taken in, when `shiftStaff`
 * knows it; else "Not recorded"). Refunds and voids belong to the manager who approved them, discounts to whoever gave them. Pure, integer cents.
 */
export function staffSales(all: readonly OrderState[], config: BusinessConfig, shiftStaff: (shiftId: string) => string | undefined = () => undefined): StaffRow[] {
  const rows = new Map<string, StaffRow>();
  const row = (name: string): StaffRow => {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { name, payments: 0, takenCents: 0, byMethod: {}, orders: 0, refunds: 0, refundedCents: 0, discounts: 0, discountCents: 0, voids: 0, voidedCents: 0, netCents: 0, averageCents: 0 }));
    return r;
  };
  for (const o of all) {
    if (!o.lines.some((l) => l.qty > 0)) continue;
    const paidBy = new Set<string>();
    for (const p of o.payments) {
      if (!p.confirmed || p.paymentId.startsWith("refund:")) continue;
      const r = row(p.byName ?? (p.shiftId ? shiftStaff(p.shiftId) : undefined) ?? "Not recorded");
      r.payments++;
      r.takenCents += p.amountCents;
      r.byMethod[p.method] = (r.byMethod[p.method] ?? 0) + p.amountCents;
      paidBy.add(r.name);
    }
    for (const n of paidBy) row(n).orders++;
    for (const f of o.refunds ?? []) { const r = row(f.approvedByName || "Not recorded"); r.refunds++; r.refundedCents += f.amountCents; }
    for (const d of o.discounts ?? []) { const r = row(d.byName || "Not recorded"); r.discounts++; r.discountCents += staffDiscountCents(o.lines, [d]).totalCents; }
    if (o.voided) { const r = row(o.voided.approvedByName || "Not recorded"); r.voids++; r.voidedCents += orderTotals(o, config).total; }
  }
  for (const r of rows.values()) { r.netCents = r.takenCents - r.refundedCents; r.averageCents = r.orders ? Math.round(r.takenCents / r.orders) : 0; }
  return [...rows.values()].sort((a, b) => b.takenCents - a.takenCents || a.name.localeCompare(b.name));
}
