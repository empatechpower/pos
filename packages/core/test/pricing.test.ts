import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, priceOrder, type PricedLine } from "../src/index.js";

// Prototype default bag: Kaya Toast S$2.00 + Coffee S$2.20 + Coke Classic 320ml BCRS S$2.50
const bag: PricedLine[] = [
  { name: "Kaya Toast", unitCents: 200, qty: 1 },
  { name: "Coffee", unitCents: 220, qty: 1 },
  { name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1 },
];

describe("priceOrder – spec numbers from the Bailey & Patch prototype", () => {
  it("dine-in, GST off: S$7.40", () => {
    const r = priceOrder({ lines: bag, fulfilment: "dine_in" });
    expect(r).toMatchObject({ subtotal: 670, service: 60, gst: 0, bcrs: 10, total: 740 });
  });

  it("take away has no service charge: S$6.80", () => {
    const r = priceOrder({ lines: bag, fulfilment: "takeaway" });
    expect(r).toMatchObject({ service: 0, total: 680 });
  });

  it("GST on, dine-in: S$8.06 (GST on items + service, not on the deposit)", () => {
    const r = priceOrder({ lines: bag, fulfilment: "dine_in", config: { ...DEFAULT_PRICING, gstOn: true } });
    expect(r).toMatchObject({ gst: 66, total: 806 });
  });

  it("GST on, take away: S$7.40", () => {
    const r = priceOrder({ lines: bag, fulfilment: "takeaway", config: { ...DEFAULT_PRICING, gstOn: true } });
    expect(r).toMatchObject({ gst: 60, total: 740 });
  });

  it("BCRS deposit applies only to products with BCRS in the name (case-insensitive)", () => {
    const r = priceOrder({
      lines: [
        { name: "Coke Zero", unitCents: 250, qty: 2 },
        { name: "Mystery bcrs can", unitCents: 300, qty: 3 },
      ],
      fulfilment: "takeaway",
    });
    expect(r.bcrs).toBe(30);
  });

  it("zero-quantity lines are ignored", () => {
    const r = priceOrder({ lines: [{ name: "Kaya Toast", unitCents: 200, qty: 0 }], fulfilment: "dine_in" });
    expect(r.total).toBe(0);
  });
});

describe("coupons", () => {
  const coupon = { amountCents: 300, minSpendCents: 2000 };

  it("S$3 coupon (min S$20) is ineligible on the S$6.70 bag", () => {
    const r = priceOrder({ lines: bag, fulfilment: "dine_in", coupon });
    expect(r.couponDiscount).toBe(0);
    expect(r.couponIneligible).toBe(true);
    expect(r.total).toBe(740);
  });

  it("minimum spend counts items only: S$20.48 payable is NOT enough if items are S$18.70", () => {
    const r = priceOrder({
      lines: [
        { name: "Mains", unitCents: 1870, qty: 1 },
        { name: "Cola BCRS", unitCents: 0, qty: 1 },
      ],
      fulfilment: "dine_in",
      coupon,
    });
    expect(r.service).toBe(168);
    expect(r.bcrs).toBe(10);
    expect(r.service + r.subtotal + r.bcrs).toBe(2048);
    expect(r.couponDiscount).toBe(0);
  });

  it("eligible coupon comes off the bill", () => {
    const r = priceOrder({ lines: [{ name: "Set", unitCents: 2500, qty: 1 }], fulfilment: "takeaway", coupon });
    expect(r.couponDiscount).toBe(300);
    expect(r.total).toBe(2200);
  });
});

describe("points (100 points = S$1)", () => {
  it("redeem-all uses the whole deductible base, never below zero", () => {
    const r = priceOrder({ lines: bag, fulfilment: "dine_in", points: { balance: 6800, requested: null } });
    expect(r.pointsUsed).toBe(740);
    expect(r.pointsDiscount).toBe(740);
    expect(r.total).toBe(0);
  });

  it("a S$39.30 deductible base means max 3,930 points, not the 6,800 balance", () => {
    const r = priceOrder({ lines: [{ name: "Feast", unitCents: 3930, qty: 1 }], fulfilment: "takeaway", points: { balance: 6800, requested: null } });
    expect(r.pointsUsed).toBe(3930);
  });

  it("balance caps the redemption", () => {
    const r = priceOrder({ lines: [{ name: "Feast", unitCents: 3930, qty: 1 }], fulfilment: "takeaway", points: { balance: 1000, requested: null } });
    expect(r.pointsUsed).toBe(1000);
    expect(r.total).toBe(2930);
  });

  it("a specific amount is honoured and clamped to the maximum", () => {
    const low = priceOrder({ lines: bag, fulfilment: "dine_in", points: { balance: 6800, requested: 300 } });
    expect(low.pointsUsed).toBe(300);
    const high = priceOrder({ lines: bag, fulfilment: "dine_in", points: { balance: 6800, requested: 99999 } });
    expect(high.pointsUsed).toBe(740);
  });

  it("deposit toggle off leaves the deposit payable", () => {
    const cfg = { ...DEFAULT_PRICING, pointsDeduct: { ...DEFAULT_PRICING.pointsDeduct, deposit: false } };
    const r = priceOrder({ lines: bag, fulfilment: "dine_in", points: { balance: 6800, requested: null }, config: cfg });
    expect(r.pointsUsed).toBe(730);
    expect(r.total).toBe(10);
  });

  it("items marked exempt (e.g. beer) are excluded when the 'eligible' base is chosen", () => {
    const cfg = { ...DEFAULT_PRICING, pointsDeduct: { items: "eligible" as const, service: false, tax: false, deposit: false } };
    const r = priceOrder({
      lines: [
        { name: "Burger", unitCents: 1000, qty: 1 },
        { name: "Beer", unitCents: 900, qty: 1, pointsExempt: true },
      ],
      fulfilment: "takeaway",
      points: { balance: 6800, requested: null },
      config: cfg,
    });
    expect(r.pointsUsed).toBe(1000);
    expect(r.total).toBe(900);
  });
});

describe("stacking", () => {
  const coupon = { amountCents: 500, minSpendCents: 0 };
  const lines: PricedLine[] = [{ name: "Set", unitCents: 2000, qty: 1 }];

  it("stackable: coupon first, points take what is left", () => {
    const r = priceOrder({ lines, fulfilment: "takeaway", coupon, points: { balance: 6800, requested: null } });
    expect(r.couponDiscount).toBe(500);
    expect(r.pointsUsed).toBe(1500);
    expect(r.total).toBe(0);
  });

  it("not stackable: coupon wins, points are dropped", () => {
    const cfg = { ...DEFAULT_PRICING, stackable: false };
    const r = priceOrder({ lines, fulfilment: "takeaway", coupon, points: { balance: 6800, requested: null }, config: cfg });
    expect(r.ignored).toBe("points");
    expect(r.pointsUsed).toBe(0);
    expect(r.total).toBe(1500);
  });
});
