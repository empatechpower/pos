import type { Cents } from "./money.js";
import { DEFAULT_PRICING, type PricingConfig } from "./pricing.js";
import { percentOf } from "./money.js";

/**
 * Tab & Split & Pay money rules (spec 12.7). Pure functions, integer cents.
 *  - Service charge is worked out on the WHOLE tab, then shared pro-rata on the item prices each person pays for.
 *  - The BCRS deposit stays with the item: whoever pays for that item pays its deposit.
 *  - Per-share amounts always add up to the whole-tab total (the "quoted total" rule).
 */

export interface TabLine {
  id: string;
  name: string;
  unitCents: Cents;
  qty: number;
  /** Who pays for this line in "Pay mine" (the name chip). */
  owner: string;
  /** Overrides the "name contains BCRS" rule. */
  bcrs?: boolean;
}

export interface TabTotals {
  items: Cents;
  service: Cents;
  bcrs: Cents;
  total: Cents;
}

const isBcrs = (l: TabLine) => l.bcrs ?? /bcrs/i.test(l.name);

/** The whole tab, computed on the whole bill. */
export function tabTotals(lines: readonly TabLine[], opts: { serviceCharge: boolean; pricing?: PricingConfig }): TabTotals {
  const cfg = opts.pricing ?? DEFAULT_PRICING;
  const live = lines.filter((l) => l.qty > 0);
  const items = live.reduce((n, l) => n + l.unitCents * l.qty, 0);
  const service = opts.serviceCharge ? percentOf(items, cfg.serviceRate) : 0;
  const bcrs = live.reduce((n, l) => (isBcrs(l) ? n + l.qty : n), 0) * cfg.bcrsDepositCents;
  return { items, service, bcrs, total: items + service + bcrs };
}

/**
 * Share `amount` between people in proportion to `weights`. Each share is rounded to the cent and the largest
 * share absorbs any difference, so the shares always add up to `amount` exactly.
 */
export function shareProRata(amount: Cents, weights: Readonly<Record<string, number>>): Record<string, Cents> {
  const ids = Object.keys(weights);
  const sum = ids.reduce((n, id) => n + weights[id]!, 0);
  const out: Record<string, Cents> = Object.fromEntries(ids.map((id) => [id, 0]));
  if (!ids.length || sum <= 0 || amount === 0) return out;
  for (const id of ids) out[id] = Math.round((amount * weights[id]!) / sum);
  const diff = amount - ids.reduce((n, id) => n + out[id]!, 0);
  if (diff !== 0) {
    const largest = ids.reduce((a, b) => (weights[b]! > weights[a]! ? b : a));
    out[largest] = out[largest]! + diff;
  }
  return out;
}

export interface Share {
  items: Cents;
  service: Cents;
  bcrs: Cents;
  total: Cents;
}

/** "Pay mine" for everyone: each person's own items, their share of service, and the deposits on their items. */
export function payMineShares(lines: readonly TabLine[], opts: { serviceCharge: boolean; pricing?: PricingConfig }): Record<string, Share> {
  const cfg = opts.pricing ?? DEFAULT_PRICING;
  const whole = tabTotals(lines, opts);
  const items: Record<string, Cents> = {};
  const bcrs: Record<string, Cents> = {};
  for (const l of lines) {
    if (l.qty <= 0) continue;
    items[l.owner] = (items[l.owner] ?? 0) + l.unitCents * l.qty;
    bcrs[l.owner] = (bcrs[l.owner] ?? 0) + (isBcrs(l) ? l.qty * cfg.bcrsDepositCents : 0);
  }
  const service = shareProRata(whole.service, items);
  return Object.fromEntries(Object.keys(items).map((id) => [id, { items: items[id]!, service: service[id]!, bcrs: bcrs[id]!, total: items[id]! + service[id]! + bcrs[id]! }]));
}

/**
 * Split the remaining amount equally between `people`. Shares are floored to the cent and the Host takes the
 * leftover cents (S$19.18 / 3 = S$6.40 Host, S$6.39, S$6.39). Spec 12.7, fix T-5.
 */
export function splitEqual(remainingCents: Cents, people: readonly string[], hostId: string): Record<string, Cents> {
  if (!people.length) return {};
  const each = Math.floor(remainingCents / people.length);
  const out: Record<string, Cents> = Object.fromEntries(people.map((p) => [p, each]));
  const left = remainingCents - each * people.length;
  const host = people.includes(hostId) ? hostId : people[0]!;
  out[host] = out[host]! + left;
  return out;
}

export interface TabPayment {
  /** Who actually paid (the session identity, never someone else's). */
  payer: string;
  /** Whose liability it cleared; equals payer unless they paid for someone else. */
  forPerson?: string;
  amountCents: Cents;
}

/** What is still owed. Never negative. */
export const tabRemaining = (totalCents: Cents, payments: readonly TabPayment[]): Cents =>
  Math.max(0, totalCents - payments.reduce((n, p) => n + p.amountCents, 0));

/**
 * Rewards on a tab (spec D4): each payer earns on what THEY paid, nothing is credited until the whole tab is
 * paid, and a payer may route their reward to the Host. Returns points per beneficiary (1 point per cent x rate).
 */
export function tabRewards(
  payments: readonly (TabPayment & { hostKeeps?: boolean })[],
  opts: { remainingCents: Cents; hostId: string; pointsPerDollar: number },
): Record<string, number> {
  if (opts.remainingCents > 0) return {};
  const out: Record<string, number> = {};
  for (const p of payments) {
    const who = p.hostKeeps ? opts.hostId : p.payer;
    out[who] = (out[who] ?? 0) + Math.floor((p.amountCents / 100) * opts.pointsPerDollar);
  }
  return out;
}
