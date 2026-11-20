import { type Cents, percentOf } from "./money.js";

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
  points?: PointsInput | null;
  config?: PricingConfig;
}

export interface PriceResult {
  subtotal: Cents;
  service: Cents;
  gst: Cents;
  bcrs: Cents;
  couponDiscount: Cents;
  pointsUsed: number;
  pointsDiscount: Cents;
  total: Cents;
  /** Which reward was dropped because promotions are not stackable. */
  ignored?: "points";
  /** Coupon given but items subtotal below its minimum spend. */
  couponIneligible?: boolean;
}

const isBcrs = (l: PricedLine) => l.bcrs ?? /bcrs/i.test(l.name);

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

  // Service charge: dine-in only, on the items AFTER the bill discount, never on the deposit (owner rule, 16 Nov 2026).
  // Points are paid like money at the end, so they do not lower it.
  const service = cfg.serviceOn !== false && (input.serviceCharge ?? input.fulfilment === "dine_in") ? percentOf(Math.max(0, subtotal - couponDiscount), cfg.serviceRate) : 0;

  // GST is never charged on the deposit. For points, it is fixed on the full items + service.
  const gstBase = points
    ? subtotal + service
    : Math.max(0, subtotal - couponDiscount) + service;
  const gst = cfg.gstOn ? percentOf(gstBase, cfg.gstRate) : 0;

  let pointsUsed = 0;
  let pointsDiscount = 0;
  if (points) {
    const taxPart = cfg.gstOn ? percentOf(subtotal + service, cfg.gstRate) : 0;
    const deductibleBase =
      (cfg.pointsDeduct.items === "eligible" ? subtotal - exempt : subtotal) +
      (cfg.pointsDeduct.service ? service : 0) +
      (cfg.pointsDeduct.tax ? taxPart : 0) +
      (cfg.pointsDeduct.deposit ? bcrs : 0);
    const room = Math.max(0, deductibleBase - couponDiscount);
    const max = Math.max(0, Math.min(points.balance, room));
    if (max > 0) {
      pointsUsed =
        points.requested == null
          ? max
          : Math.max(Math.min(cfg.minPointsRedeem, max), Math.min(points.requested, max));
      pointsDiscount = Math.min(pointsUsed, room);
    }
  }

  const total = Math.max(0, subtotal + service + gst + bcrs - couponDiscount - pointsDiscount);
  return {
    subtotal,
    service,
    gst,
    bcrs,
    couponDiscount,
    pointsUsed,
    pointsDiscount,
    total,
    ignored,
    couponIneligible: coupon ? !couponEligible : undefined,
  };
}
