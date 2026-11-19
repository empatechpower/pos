import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, PRESETS, priceOrder, quoteOrder, type Catalog, type PricedLine } from "../src/index.js";

// The verified fixtures from the Developer Handover (18 Nov 2026, section 8). The prototypes run a 9% service charge; Bailey's live rate is 8%,
// so the rate is passed in here exactly as production reads it from the merchant's configuration, never hardcoded.
const prototype = { ...DEFAULT_PRICING, serviceRate: 0.09, gstOn: false };
const kaya: PricedLine = { name: "Kaya Toast", unitCents: 200, qty: 1 };
const coffee: PricedLine = { name: "Coffee — Hot", unitCents: 220, qty: 1 };
const coke: PricedLine = { name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1, bcrs: true };

describe("handover money fixtures (kiosk and phone)", () => {
  it("seeded bag, dine-in: items 6.70 + service 0.60 + BCRS 0.10 = 7.40", () => {
    expect(priceOrder({ lines: [kaya, coffee, coke], fulfilment: "dine_in", config: prototype })).toMatchObject({ subtotal: 670, service: 60, bcrs: 10, total: 740 });
  });

  it("same bag, take away: 7.10 (food is 30c dearer on the take-away price book, drinks are not, no service charge)", () => {
    const takeAway = [{ ...kaya, unitCents: kaya.unitCents + 30 }, coffee, coke];
    expect(priceOrder({ lines: takeAway, fulfilment: "takeaway", config: prototype })).toMatchObject({ subtotal: 700, service: 0, bcrs: 10, total: 710 });
  });

  it("Kaya Toast x2, dine-in: 9.58", () => {
    expect(priceOrder({ lines: [{ ...kaya, qty: 2 }, coffee, coke], fulfilment: "dine_in", config: prototype }).total).toBe(958);
  });

  it("Kaya Toast removed, dine-in: 5.22", () => {
    expect(priceOrder({ lines: [coffee, coke], fulfilment: "dine_in", config: prototype }).total).toBe(522);
  });

  it("a line with qty 0 counts for nothing (a stepper brought to zero)", () => {
    expect(priceOrder({ lines: [{ ...kaya, qty: 0 }, coffee, coke], fulfilment: "dine_in", config: prototype }).total).toBe(522);
  });

  it("the service rate comes from configuration: the same bag at Bailey's live 8% is 7.34", () => {
    expect(priceOrder({ lines: [kaya, coffee, coke], fulfilment: "dine_in", config: { ...prototype, serviceRate: 0.08 } }).total).toBe(734);
  });

  it("service charge switched off: no charge at all, and the total follows (7.40 becomes 6.80)", () => {
    expect(priceOrder({ lines: [kaya, coffee, coke], fulfilment: "dine_in", config: { ...prototype, serviceOn: false } })).toMatchObject({ service: 0, total: 680 });
  });

  it("every total settles to a whole number of cents, for any quantity", () => {
    for (let q = 1; q <= 40; q++) {
      const r = priceOrder({ lines: [{ ...kaya, qty: q }, { ...coke, qty: q }], fulfilment: "dine_in", config: prototype });
      expect(Number.isInteger(r.total)).toBe(true);
      expect(r.total).toBe(r.subtotal + r.service + r.gst + r.bcrs);
    }
  });

  it("BCRS is a deposit per unit and follows the item's setting, not its name", () => {
    const named = { name: "Plain water BCRS", unitCents: 100, qty: 3, bcrs: false };
    const flagged = { name: "Plain water", unitCents: 100, qty: 3, bcrs: true };
    expect(priceOrder({ lines: [named], fulfilment: "takeaway", config: prototype }).bcrs).toBe(0);
    expect(priceOrder({ lines: [flagged], fulfilment: "takeaway", config: prototype }).bcrs).toBe(30);
  });

  it("a coupon's minimum spend is judged on the items subtotal, before service, tax and deposits", () => {
    const bag = [kaya, coffee, coke]; // items 6.70, total 7.40
    const ok = priceOrder({ lines: bag, fulfilment: "dine_in", config: prototype, coupon: { amountCents: 100, minSpendCents: 670 } });
    expect(ok.couponIneligible).toBeFalsy();
    expect(ok.couponDiscount).toBe(100);
    const short = priceOrder({ lines: bag, fulfilment: "dine_in", config: prototype, coupon: { amountCents: 100, minSpendCents: 700 } });
    expect(short.couponIneligible).toBe(true); // 7.40 reaches 7.00, but the items alone (6.70) do not
    expect(short.total).toBe(740);
  });
});

// The same fixtures through the whole path the kiosk and phone use: the catalog, the channel's price book and the channel's service charge.
describe("handover money fixtures through quoteOrder", () => {
  const catalog: Catalog = {
    version: 1,
    defaultPricebookId: "std",
    products: [
      { id: "kaya", name: "Kaya Toast", category: "Toast" },
      { id: "kopi", name: "Coffee", category: "Drinks" },
      { id: "coke", name: "Coke Classic 320ml BCRS", category: "Drinks", bcrs: true },
    ],
    pricebooks: [
      { id: "std", name: "Standard", missing: "show", prices: { kaya: 200, kopi: 220, coke: 250 } },
      { id: "take", name: "Take away", missing: "show", prices: { kaya: 230, kopi: 220, coke: 250 } }, // food 30c dearer, drinks the same (a price book is never mixed with another)
    ],
    channels: [
      { id: "dine", name: "Dine in", kind: "dine_in", serviceCharge: true, active: true },
      { id: "takeaway", name: "Take away", kind: "takeaway", serviceCharge: false, active: true },
    ],
    assignments: [{ pricebookId: "take", channelId: "takeaway" }],
  };
  const base = PRESETS.fastServe("b", "B", "O");
  const config = { ...base, pricing: { ...base.pricing, serviceRate: 0.09, gstOn: false } };
  const total = (channel: string, items: Array<{ productId: string; qty: number }>) => {
    const q = quoteOrder(catalog, config, { outletId: "O", channelId: channel }, items);
    if (!q.ok) throw new Error("quote failed: " + JSON.stringify(q));
    return q.priced.total;
  };
  const seeded = [{ productId: "kaya", qty: 1 }, { productId: "kopi", qty: 1 }, { productId: "coke", qty: 1 }];

  it("dine-in 7.40, take away 7.10, Kaya x2 9.58, Kaya removed 5.22", () => {
    expect(total("dine", seeded)).toBe(740);
    expect(total("takeaway", seeded)).toBe(710);
    expect(total("dine", [{ productId: "kaya", qty: 2 }, ...seeded.slice(1)])).toBe(958);
    expect(total("dine", seeded.slice(1))).toBe(522);
  });
});
