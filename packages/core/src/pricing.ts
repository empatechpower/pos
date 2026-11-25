import { type Cents, percentOf } from "./money.js";
import { roundTotal, type RoundingRule } from "./taxPacks.js";

/**
 * Price engine. Ported from the Bailey & Patch prototype rules (all in integer cents).
 * 100 points = S$1, so 1 point = 1 cent.
 */

export interface PricingConfig {
  /** Dine-in only. 0.09 = 9%. */
  serviceRate: number;
  /** The owner can switch the service charge off for the whole brand (most quick-service shops have none). Missing means on. */
  serviceOn?: boolean;
  gstRate: number;
  gstOn: boolean;
  /** Charged per unit of any line flagged bcrs (an item setting; very old lines with no flag fall back to "BCRS" in the name). */
  bcrsDepositCents: Cents;
  /** Which bill components points are allowed to pay for. */
  pointsDeduct: {
    /** "all" = every item, "eligible" = exclude lines flagged pointsExempt. */
    items: "all" | "eligible";
    service: boolean;
    tax: boolean;
    deposit: boolean;
  };
  /** Can a coupon/voucher and points be used on the same order? */
  stackable: boolean;
  /** Smallest points redemption when points are applied. */
  minPointsRedeem: number;
  /** Prices already include tax (the default for every line that does not say otherwise). Missing = tax is added on top, as before. */
  taxInclusive?: boolean;
  /** Tax groups beyond the default GST rate: id -> { name, rate }. A line names its group; a line with none uses `gstRate` as "GST". */
  taxGroups?: Record<string, { name: string; rate: number }>;
  /** From the outlet's country tax pack (taxPacks.ts), never set by hand: the country, what the tax is called, how totals are rounded, and whether staff may take the tax off an order. */
  country?: string;
  taxName?: string;
  rounding?: RoundingRule;
  taxRemovable?: boolean;
}

export const DEFAULT_PRICING: PricingConfig = {
  serviceRate: 0.08,
  gstRate: 0.09,
  gstOn: false,
  bcrsDepositCents: 10,
  // Usable points are capped at the items + service charge (handover 12.2): the container deposit is refundable cash, never payable in points.
  pointsDeduct: { items: "all", service: true, tax: true, deposit: false },
  stackable: true,
  minPointsRedeem: 100,
};

export interface PricedLine {
  name: string;
  unitCents: Cents;
  qty: number;
  /** Carries the deposit. Set from the item at the moment of sale. Only lines from before this setting existed have it unset, and they keep the old name rule so past orders do not change. */
  bcrs?: boolean;
  pointsExempt?: boolean;
  /** This line's price already includes its tax. Overrides the merchant default. */
  taxInclusive?: boolean;
  /** Which tax group this line belongs to (see `taxGroups`). Default: the GST rate. */
  taxGroup?: string;
}

export interface CouponInput {
  amountCents: Cents;
  /** Minimum spend, counted on the ITEMS subtotal only (before service, tax, deposit). */
  minSpendCents: Cents;
}

export interface PointsInput {
  balance: number;
  /** null = redeem the maximum usable. */
  requested: number | null;
}

export interface PriceInput {
  lines: PricedLine[];
  fulfilment: "dine_in" | "takeaway" | "delivery";
  /** Overrides the default (service charge on dine-in only) when the channel says otherwise. */
  serviceCharge?: boolean;
  coupon?: CouponInput | null;
  /** Discounts staff gave on lines or the bill, already worked out in cents. They come off the items before service charge and tax, like a coupon. */
  discountCents?: Cents;
  /** A fee staff added to the whole order (already worked out in cents). It is charged like the service charge: after discounts, and taxed with it. */
  feeCents?: Cents;
  points?: PointsInput | null;
  /** Staff took the tax off this order (Add/Remove Tax): none is added, and the tax inside tax-inclusive prices comes off the total. */
  taxRemoved?: boolean;
  config?: PricingConfig;
}

export interface PriceResult {
  subtotal: Cents;
  service: Cents;
  /** A fee staff added to the order. */
  fee: Cents;
  gst: Cents;
  bcrs: Cents;
  couponDiscount: Cents;
  /** What staff discounts took off (line and bill). */
  discountCents: Cents;
  pointsUsed: number;
  pointsDiscount: Cents;
  total: Cents;
  /** Which reward was dropped because promotions are not stackable. */
  ignored?: "points";
  /** Coupon given but items subtotal below its minimum spend. */
  couponIneligible?: boolean;
  /** The tax portion already INSIDE the total (for tax-inclusive prices); never added on top. */
  taxIncluded: Cents;
  /** Every tax, per group, said plainly: charged on top (`added`, part of `gst`) or already inside the prices (`included`). */
  taxes: TaxLine[];
  /** Tax taken off the order by staff: what would have been charged, and the part of it that was inside the prices and so came off the total. Only set when tax was removed. */
  taxRemoved?: { cents: Cents; offTotal: Cents; name: string };
  /** What rounding the total added (positive) or took off (negative), by the country's rule. Only set when it is not zero. */
  rounding?: Cents;
}

export interface TaxLine {
  group: string;
  name: string;
  rate: number;
  basis: "added" | "included";
  cents: Cents;
}

const DEFAULT_TAX_GROUP = "default";

const isBcrs = (l: PricedLine) => l.bcrs ?? /bcrs/i.test(l.name);

/**
 * Tax, per group. Prices that EXCLUDE tax have it added on top (rate x base). Prices that INCLUDE tax contain it already: the tax portion is
 * gross x rate / (1 + rate), shown but never added (S$30.00 including 9% GST holds S$2.48 of tax). The deposit is never taxed. The bill
 * discount and the service charge are shared between the lines in proportion to what each line is worth, so every cent is accounted for.
 */
function taxOf(lines: PricedLine[], subtotal: Cents, service: Cents, discount: Cents, cfg: PricingConfig): { added: Cents; included: Cents; taxes: TaxLine[] } {
  if (!cfg.gstOn || subtotal <= 0) return { added: 0, included: 0, taxes: [] };
  const buckets = new Map<string, { group: string; inclusive: boolean; gross: Cents }>();
  for (const l of lines) {
    const group = l.taxGroup ?? DEFAULT_TAX_GROUP;
    const inclusive = l.taxInclusive ?? cfg.taxInclusive ?? false;
    const key = `${group}|${inclusive ? "i" : "x"}`;
    const b = buckets.get(key) ?? { group, inclusive, gross: 0 };
    b.gross += l.unitCents * l.qty;
    buckets.set(key, b);
  }
  // Share the discount and the service charge across the buckets by value; the last bucket takes the rounding remainder.
  const list = [...buckets.values()];
  let discLeft = discount;
  let svcLeft = service;
  let added = 0;
  let included = 0;
  const taxes: TaxLine[] = [];
  list.forEach((b, i) => {
    const last = i === list.length - 1;
    const d = last ? discLeft : Math.round((discount * b.gross) / subtotal);
    const sv = last ? svcLeft : Math.round((service * b.gross) / subtotal);
    discLeft -= d;
    svcLeft -= sv;
    const base = Math.max(0, b.gross - d) + sv;
    const g = b.group === DEFAULT_TAX_GROUP ? undefined : cfg.taxGroups?.[b.group];
    const rate = g?.rate ?? cfg.gstRate;
    const name = g?.name ?? cfg.taxName ?? "GST";
    const cents = b.inclusive ? Math.round((base * rate) / (1 + rate)) : percentOf(base, rate);
    if (b.inclusive) included += cents;
    else added += cents;
    const same = taxes.find((t) => t.group === b.group && t.basis === (b.inclusive ? "included" : "added"));
    if (same) same.cents += cents;
    else taxes.push({ group: b.group, name, rate, basis: b.inclusive ? "included" : "added", cents });
  });
  return { added, included, taxes: taxes.filter((t) => t.cents > 0) };
}

/** What a receipt or the checkout shows, in order, with the basis said plainly: "Taxes (included)" is inside the total, "GST" is added to it. */
export interface TotalsLine {
  key: "subtotal" | "coupon" | "discount" | "service" | "fee" | "tax_added" | "tax_included" | "tax_removed" | "deposit" | "points" | "rounding" | "total";
  label: string;
  cents: Cents;
  /** Money taken off (a coupon or points). */
  negative?: boolean;
  /** The deposit is refundable cash and is never taxed. */
  taxable?: boolean;
  /** For tax lines: the group and rate, so the basis is never hidden. */
  group?: string;
  rate?: number;
}

export function totalsLines(r: PriceResult): TotalsLine[] {
  const out: TotalsLine[] = [{ key: "subtotal", label: "Subtotal", cents: r.subtotal }];
  if (r.couponDiscount > 0) out.push({ key: "coupon", label: "Coupon", cents: r.couponDiscount, negative: true });
  if (r.discountCents > 0) out.push({ key: "discount", label: "Discount", cents: r.discountCents, negative: true });
  if (r.service > 0) out.push({ key: "service", label: "Service charge", cents: r.service });
  if (r.fee > 0) out.push({ key: "fee", label: "Service fee", cents: r.fee });
  for (const t of r.taxes) out.push({ key: t.basis === "added" ? "tax_added" : "tax_included", label: t.basis === "added" ? t.name : `${t.name} (included)`, cents: t.cents, group: t.group, rate: t.rate });
  if (r.taxRemoved) out.push({ key: "tax_removed", label: `${r.taxRemoved.name} removed`, cents: r.taxRemoved.offTotal, negative: true });
  if (r.bcrs > 0) out.push({ key: "deposit", label: "Deposit", cents: r.bcrs, taxable: false });
  if (r.pointsDiscount > 0) out.push({ key: "points", label: "Points", cents: r.pointsDiscount, negative: true });
  if (r.rounding) out.push({ key: "rounding", label: "Rounding", cents: Math.abs(r.rounding), ...(r.rounding < 0 ? { negative: true } : {}) });
  out.push({ key: "total", label: "Total", cents: r.total });
  return out;
}

export function priceOrder(input: PriceInput): PriceResult {
  const cfg = input.config ?? DEFAULT_PRICING;
  const lines = input.lines.filter((l) => l.qty > 0);

  const subtotal = lines.reduce((n, l) => n + l.unitCents * l.qty, 0);
  const exempt = lines.reduce((n, l) => (l.pointsExempt ? n + l.unitCents * l.qty : n), 0);
  const bcrs = lines.reduce((n, l) => (isBcrs(l) ? n + l.qty : n), 0) * cfg.bcrsDepositCents;
  let coupon = input.coupon ?? null;
  let points = input.points ?? null;
  let ignored: PriceResult["ignored"];
  if (!cfg.stackable && coupon && points) {
    points = null;
    ignored = "points";
  }

  // The bill discount (a coupon or voucher) comes off the items first, and the minimum spend is judged on the items before it.
  const couponEligible = !!coupon && subtotal >= coupon.minSpendCents;
  const couponDiscount = coupon && couponEligible ? Math.min(coupon.amountCents, subtotal) : 0;

  // What staff took off comes off after the coupon, and never more than is left.
  const discountCents = Math.min(Math.max(0, Math.round(input.discountCents ?? 0)), Math.max(0, subtotal - couponDiscount));
  const allDiscount = couponDiscount + discountCents;

  // Service charge: dine-in only, on the items AFTER the bill discount, never on the deposit (owner rule, 16 Nov 2026).
  // Points are paid like money at the end, so they do not lower it.
  const service = cfg.serviceOn !== false && (input.serviceCharge ?? input.fulfilment === "dine_in") ? percentOf(Math.max(0, subtotal - allDiscount), cfg.serviceRate) : 0;

  // GST is never charged on the deposit. For points, it is fixed on the full items + service.
  const taxDiscount = points ? 0 : allDiscount;
  const fee = Math.max(0, Math.round(input.feeCents ?? 0));
  const worked = taxOf(lines, subtotal, service + fee, taxDiscount, cfg);
  // Tax taken off by staff: nothing is added, and what was inside tax-inclusive prices comes off the total.
  const removed = !!input.taxRemoved && cfg.gstOn && worked.added + worked.included > 0;
  const { added: gst, taxes, included: taxIncluded } = removed ? { added: 0, taxes: [] as TaxLine[], included: 0 } : worked;
  const taxOffTotal = removed ? worked.included : 0;

  let pointsUsed = 0;
  let pointsDiscount = 0;
  if (points) {
    const taxPart = cfg.gstOn && !removed ? percentOf(subtotal + service, cfg.gstRate) : 0;
    const deductibleBase =
      (cfg.pointsDeduct.items === "eligible" ? subtotal - exempt : subtotal) +
      (cfg.pointsDeduct.service ? service : 0) +
      (cfg.pointsDeduct.tax ? taxPart : 0) +
      (cfg.pointsDeduct.deposit ? bcrs : 0);
    const room = Math.max(0, deductibleBase - allDiscount);
    const max = Math.max(0, Math.min(points.balance, room));
    if (max > 0) {
      pointsUsed =
        points.requested == null
          ? max
          : Math.max(Math.min(cfg.minPointsRedeem, max), Math.min(points.requested, max));
      pointsDiscount = Math.min(pointsUsed, room);
    }
  }

  const exact = Math.max(0, subtotal + service + fee + gst + bcrs - allDiscount - pointsDiscount - taxOffTotal);
  const total = roundTotal(exact, cfg.rounding);
  return {
    subtotal,
    service,
    fee,
    gst,
    bcrs,
    couponDiscount,
    discountCents,
    pointsUsed,
    pointsDiscount,
    total,
    ignored,
    couponIneligible: coupon ? !couponEligible : undefined,
    taxIncluded,
    taxes,
    ...(removed ? { taxRemoved: { cents: worked.added + worked.included, offTotal: taxOffTotal, name: worked.taxes[0]?.name ?? cfg.taxName ?? "GST" } } : {}),
    ...(total !== exact ? { rounding: total - exact } : {}),
  };
}

/** A fee on the whole order, as staff chose it: a percentage of the items (after discounts) or a fixed amount. */
export interface OrderFee { id: string; kind: "percent" | "amount"; value: number; label: string }
export const feeCentsOf = (fees: readonly Pick<OrderFee, "kind" | "value">[], baseCents: Cents): Cents =>
  fees.reduce((n, f) => n + (f.kind === "percent" ? Math.round((Math.max(0, baseCents) * f.value) / 100) : Math.round(f.value)), 0);
