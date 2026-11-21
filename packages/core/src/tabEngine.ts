import type { Cents } from "./money.js";
import { DEFAULT_PRICING, priceOrder, type PricingConfig } from "./pricing.js";
import { shareProRata } from "./tab.js";

/**
 * The Tab money engine (Spec 12.5-12.7, Addendum 2.3, 2.4, 3, 4.1). Pure and in integer cents.
 *
 * A tab is a set of lines. Every line breaks into CLAIMABLE UNITS: one per quantity, or, for a line shared between k people, k slices (the
 * line's value split to the cent, any odd cents to the first slices, every deposit on the first slice: "the deposit stays with the item").
 * A payment claims units (or, for Equal and "reduce only", just a value). The whole bill is priced ONCE, on the whole bill (service rounded once);
 * what each payer owes is their units' items and deposits plus their pro-rata part of what is left of the service and the tax, so every set of
 * shares adds up to the whole-bill total exactly (the quoted-total rule), and a completed payment's allocation is never changed afterwards.
 */

export interface TabLineIn {
  lineId: string;
  /** Round number, 1 upwards (time order). */
  round: number;
  name: string;
  unitCents: Cents;
  qty: number;
  /** Who ordered it ("Pay mine" takes the lines you own). */
  ownerId: string;
  bcrs?: boolean;
  taxInclusive?: boolean;
  taxGroup?: string;
  /** Shared between these people (Share this item). Empty or missing = not shared. */
  sharedWith?: readonly string[];
}

export interface TabOpts {
  /** Whether the channel charges service (dine-in at Bailey). */
  serviceCharge: boolean;
  pricing?: PricingConfig;
}

export interface Unit {
  lineId: string;
  /** Position within the line (the unit number, or the slice number of a shared line). */
  idx: number;
  round: number;
  ownerId: string;
  items: Cents;
  deposit: Cents;
}

/** What a payment settled. A payment's allocation is final once made. */
export interface PaymentAlloc {
  items: Cents;
  service: Cents;
  tax: Cents;
  deposit: Cents;
  /** Value paid that is not tied to units (Equal, "reduce only", the part of a custom amount no unit could take). Negative when a unit payment used some. */
  credit: Cents;
  units: ReadonlyArray<{ lineId: string; idx: number }>;
}

export const allocTotal = (a: PaymentAlloc): Cents => a.items + a.service + a.tax + a.deposit + a.credit;

export interface TabBill {
  itemsCents: Cents;
  serviceCents: Cents;
  /** Tax charged on top (tax-inclusive prices carry theirs inside). */
  taxCents: Cents;
  depositCents: Cents;
  totalCents: Cents;
  /** Tax already inside the prices: shown, never added. */
  taxIncludedCents: Cents;
}

/** The whole tab, priced once on the whole bill. */
export function tabBill(lines: readonly TabLineIn[], opts: TabOpts): TabBill {
  const cfg = opts.pricing ?? DEFAULT_PRICING;
  const r = priceOrder({
    lines: lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, unitCents: l.unitCents, qty: l.qty, bcrs: l.bcrs ?? false, taxInclusive: l.taxInclusive, taxGroup: l.taxGroup })),
    fulfilment: "dine_in",
    serviceCharge: opts.serviceCharge,
    config: cfg,
  });
  return { itemsCents: r.subtotal, serviceCents: r.service, taxCents: r.gst, depositCents: r.bcrs, totalCents: r.total, taxIncludedCents: r.taxIncluded };
}

/** Split `total` into k parts to the cent: the odd cents go to the first parts. */
function splitCents(total: Cents, k: number): Cents[] {
  const base = Math.floor(total / k);
  const extra = total - base * k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Every claimable unit of the tab, oldest round first. */
export function tabUnits(lines: readonly TabLineIn[], opts: TabOpts): Unit[] {
  const dep = (opts.pricing ?? DEFAULT_PRICING).bcrsDepositCents;
  const out: Unit[] = [];
  for (const l of [...lines].filter((x) => x.qty > 0).sort((a, b) => a.round - b.round)) {
    const sharers = l.sharedWith && l.sharedWith.length > 1 ? l.sharedWith : null;
    if (!sharers) {
      for (let i = 0; i < l.qty; i++) out.push({ lineId: l.lineId, idx: i, round: l.round, ownerId: l.ownerId, items: l.unitCents, deposit: l.bcrs ? dep : 0 });
    } else {
      const parts = splitCents(l.unitCents * l.qty, sharers.length);
      sharers.forEach((who, i) => out.push({ lineId: l.lineId, idx: i, round: l.round, ownerId: who, items: parts[i]!, deposit: i === 0 && l.bcrs ? dep * l.qty : 0 }));
    }
  }
  return out;
}

const key = (u: { lineId: string; idx: number }) => `${u.lineId}#${u.idx}`;

export interface TabState {
  lines: readonly TabLineIn[];
  /** Completed and reserved payments (a reserved one counts: that liability is spoken for). */
  payments: readonly PaymentAlloc[];
  opts: TabOpts;
}

export interface TabStanding {
  bill: TabBill;
  paidCents: Cents;
  remainingCents: Cents;
  /** Units no payment has claimed. */
  unpaid: Unit[];
  /** What is left of each pool to share out. */
  serviceLeft: Cents;
  taxLeft: Cents;
  /** Value paid that no unit has absorbed yet. */
  creditLeft: Cents;
}

export function tabStanding(s: TabState): TabStanding {
  const bill = tabBill(s.lines, s.opts);
  const claimed = new Set(s.payments.flatMap((p) => p.units.map(key)));
  const unpaid = tabUnits(s.lines, s.opts).filter((u) => !claimed.has(key(u)));
  const sum = (f: (a: PaymentAlloc) => number) => s.payments.reduce((n, p) => n + f(p), 0);
  const paid = sum(allocTotal);
  return { bill, paidCents: paid, remainingCents: Math.max(0, bill.totalCents - paid), unpaid, serviceLeft: bill.serviceCents - sum((a) => a.service), taxLeft: bill.taxCents - sum((a) => a.tax), creditLeft: sum((a) => a.credit) };
}

export interface TabQuote {
  mode: "mine" | "round" | "all" | "equal" | "custom";
  amountCents: Cents;
  alloc: PaymentAlloc;
  /** The maths in the standard Bag format: what the payer sees before paying. */
  lines: Array<{ lineId: string; name: string; units: number; items: Cents; deposit: Cents }>;
  itemsCents: Cents;
  serviceCents: Cents;
  taxCents: Cents;
  depositCents: Cents;
  /** Value already paid by someone that reduces this share (negative amounts only appear on unit payments). */
  creditAppliedCents: Cents;
}

/** Price a claim on specific units: their items and deposits plus their pro-rata part of the service and tax left, less their part of any unattributed credit. */
function quoteUnits(s: TabState, st: TabStanding, claim: readonly Unit[], mode: TabQuote["mode"], asOwner?: string): TabQuote {
  const claimedKeys = new Set(claim.map(key));
  // "Pay mine" is keyed by the person, the same key everyone else's quote uses for them, so every person's own quote rounds the same way and the shares add up.
  const mine = asOwner ? `o:${asOwner}` : "claim";
  const weights: Record<string, number> = { [mine]: claim.reduce((n, u) => n + u.items, 0) };
  for (const u of st.unpaid) if (!claimedKeys.has(key(u))) weights[`o:${u.ownerId}`] = (weights[`o:${u.ownerId}`] ?? 0) + u.items;
  // Items of nothing (all free) still carry their deposit; weights of zero share nothing.
  const service = shareProRata(Math.max(0, st.serviceLeft), weights)[mine] ?? 0;
  const tax = shareProRata(Math.max(0, st.taxLeft), weights)[mine] ?? 0;
  const items = claim.reduce((n, u) => n + u.items, 0);
  const deposit = claim.reduce((n, u) => n + u.deposit, 0);
  const gross = items + service + tax + deposit;
  // Value someone already paid without claiming units reduces everyone's share pro-rata, so the shares still add up to what remains.
  const pool = Math.max(0, st.creditLeft);
  const take = pool > 0 ? Math.min(gross, shareProRata(pool, weights)[mine] ?? 0) : 0;
  const byLine = new Map<string, { lineId: string; name: string; units: number; items: Cents; deposit: Cents }>();
  for (const u of claim) {
    const l = s.lines.find((x) => x.lineId === u.lineId);
    const e = byLine.get(u.lineId) ?? { lineId: u.lineId, name: l?.name ?? u.lineId, units: 0, items: 0, deposit: 0 };
    e.units += 1; e.items += u.items; e.deposit += u.deposit;
    byLine.set(u.lineId, e);
  }
  const alloc: PaymentAlloc = { items, service, tax, deposit, credit: -take, units: claim.map((u) => ({ lineId: u.lineId, idx: u.idx })) };
  return { mode, amountCents: gross - take, alloc, lines: [...byLine.values()], itemsCents: items, serviceCents: service, taxCents: tax, depositCents: deposit, creditAppliedCents: take };
}

/** "Pay mine": every unit I ordered, or my slice of a shared line. */
export function quoteMine(s: TabState, personId: string): TabQuote {
  const st = tabStanding(s);
  return quoteUnits(s, st, st.unpaid.filter((u) => u.ownerId === personId), "mine", personId);
}

/** "By round": one round whole. */
export function quoteRound(s: TabState, round: number): TabQuote {
  const st = tabStanding(s);
  return quoteUnits(s, st, st.unpaid.filter((u) => u.round === round), "round");
}

/** "Pay remaining / Pay all". */
export function quoteAll(s: TabState): TabQuote {
  const st = tabStanding(s);
  return quoteUnits(s, st, st.unpaid, "all");
}

/**
 * "Split equally": the Remaining divided between the people still to pay. Working rule B (Addendum 3.3): the non-deposit part is divided
 * equally, floored to the cent, the Host taking the odd cents; each deposit still unpaid goes whole to the person who ordered that item (or,
 * if they are not among the payers, to the Host). The result is a value payment: nothing is marked paid.
 */
export function quoteEqual(s: TabState, payers: readonly string[], payerId: string, hostId: string): TabQuote {
  const st = tabStanding(s);
  if (!payers.includes(payerId)) throw new Error("the payer must be one of the people splitting");
  const host = payers.includes(hostId) ? hostId : payers[0]!;
  const deposits: Record<string, number> = {};
  for (const u of st.unpaid) if (u.deposit > 0) { const who = payers.includes(u.ownerId) ? u.ownerId : host; deposits[who] = (deposits[who] ?? 0) + u.deposit; }
  const depTotal = Object.values(deposits).reduce((n, v) => n + v, 0);
  // Deposits already covered by value someone paid are not counted twice: the non-deposit part is what is left after deposits.
  const rest = Math.max(0, st.remainingCents - Math.min(depTotal, st.remainingCents));
  const each = Math.floor(rest / payers.length);
  const odd = rest - each * payers.length;
  const mine = each + (payerId === host ? odd : 0) + (deposits[payerId] ?? 0);
  const amount = Math.min(mine, st.remainingCents);
  const alloc: PaymentAlloc = { items: 0, service: 0, tax: 0, deposit: 0, credit: amount, units: [] };
  return { mode: "equal", amountCents: amount, alloc, lines: [], itemsCents: 0, serviceCents: 0, taxCents: 0, depositCents: deposits[payerId] ?? 0, creditAppliedCents: 0 };
}

/**
 * "Custom amount". `oldest_first` (D2 a): the amount marks units paid, oldest round first, as many whole units as it covers (a unit's cost
 * includes its part of service and tax); what is left over is value. `reduce_only` (D2 b): the amount only reduces the Remaining.
 */
export function quoteCustom(s: TabState, amountCents: Cents, allocation: "oldest_first" | "reduce_only"): TabQuote {
  const st = tabStanding(s);
  const amount = Math.min(Math.max(0, Math.floor(amountCents)), st.remainingCents);
  if (allocation === "reduce_only" || amount === 0) {
    const alloc: PaymentAlloc = { items: 0, service: 0, tax: 0, deposit: 0, credit: amount, units: [] };
    return { mode: "custom", amountCents: amount, alloc, lines: [], itemsCents: 0, serviceCents: 0, taxCents: 0, depositCents: 0, creditAppliedCents: 0 };
  }
  const claim: Unit[] = [];
  let best: TabQuote | null = null;
  for (const u of st.unpaid) {
    const q = quoteUnits(s, st, [...claim, u], "custom");
    if (q.amountCents > amount) break;
    claim.push(u);
    best = q;
  }
  if (!best) {
    const alloc: PaymentAlloc = { items: 0, service: 0, tax: 0, deposit: 0, credit: amount, units: [] };
    return { mode: "custom", amountCents: amount, alloc, lines: [], itemsCents: 0, serviceCents: 0, taxCents: 0, depositCents: 0, creditAppliedCents: 0 };
  }
  const left = amount - best.amountCents;
  return { ...best, amountCents: amount, alloc: { ...best.alloc, credit: best.alloc.credit + left } };
}

/** Where each line of the tab stands: how many units are paid, and how many are only reserved. */
export function lineStates(lines: readonly TabLineIn[], opts: TabOpts, paid: ReadonlyArray<{ lineId: string; idx: number }>, reserved: ReadonlyArray<{ lineId: string; idx: number }>): Record<string, { total: number; paid: number; reserved: number }> {
  const out: Record<string, { total: number; paid: number; reserved: number }> = {};
  for (const u of tabUnits(lines, opts)) out[u.lineId] = { total: (out[u.lineId]?.total ?? 0) + 1, paid: 0, reserved: 0 };
  for (const p of paid) if (out[p.lineId]) out[p.lineId]!.paid++;
  for (const p of reserved) if (out[p.lineId]) out[p.lineId]!.reserved++;
  return out;
}
