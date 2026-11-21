import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, PRESETS, priceOrder, quoteOrder, totalsLines, type Catalog, type PricedLine } from "../src/index.js";

// Backend handout (20 Nov 2026), section 11 and fixture 11.
const gst = { ...DEFAULT_PRICING, gstOn: true, gstRate: 0.09 };
const goods: PricedLine[] = [
  { name: "Mains", unitCents: 2000, qty: 1, taxInclusive: true },
  { name: "Sparkling Water", unitCents: 500, qty: 2, taxInclusive: true, bcrs: true }, // the two BCRS items
];

describe("GST-inclusive totals", () => {
  it("fixture 11: S$30.00 including 9% GST holds S$2.48 of tax, the deposit is its own S$0.20 line, the total is S$30.20", () => {
    const r = priceOrder({ lines: goods, fulfilment: "takeaway", config: gst });
    expect(r.subtotal).toBe(3000);
    expect(r.taxIncluded).toBe(248); // 3000 x 9 / 109 = 247.7
    expect(r.gst).toBe(0); // nothing is added on top
    expect(r.bcrs).toBe(20);
    expect(r.total).toBe(3020);
    expect(r.taxes).toEqual([{ group: "default", name: "GST", rate: 0.09, basis: "included", cents: 248 }]);
    const lines = totalsLines(r);
    expect(lines.map((l) => l.key)).toEqual(["subtotal", "tax_included", "deposit", "total"]);
    expect(lines.find((l) => l.key === "tax_included")).toMatchObject({ label: "GST (included)", cents: 248, rate: 0.09 });
    expect(lines.find((l) => l.key === "deposit")).toMatchObject({ label: "Deposit", cents: 20, taxable: false });
  });

  it("the same goods with tax ADDED on top still price as before (and say so)", () => {
    const r = priceOrder({ lines: goods.map((l) => ({ ...l, taxInclusive: false })), fulfilment: "takeaway", config: gst });
    expect(r).toMatchObject({ gst: 270, taxIncluded: 0, bcrs: 20, total: 3290 });
    expect(r.taxes).toEqual([{ group: "default", name: "GST", rate: 0.09, basis: "added", cents: 270 }]);
    expect(totalsLines(r).find((l) => l.key === "tax_added")).toMatchObject({ label: "GST", cents: 270 });
  });

  it("a merchant can make every price inclusive, and one line can still say otherwise", () => {
    const allIn = { ...gst, taxInclusive: true };
    const r = priceOrder({ lines: [{ name: "A", unitCents: 2000, qty: 1 }, { name: "B", unitCents: 1000, qty: 1, taxInclusive: false }], fulfilment: "takeaway", config: allIn });
    expect(r.taxIncluded).toBe(165); // 2000 x 9/109
    expect(r.gst).toBe(90); // B is taxed on top
    expect(r.total).toBe(3000 + 90);
  });

  it("a coupon comes off the lines in proportion, and the tax follows what is left", () => {
    const r = priceOrder({ lines: [{ name: "A", unitCents: 2000, qty: 1, taxInclusive: true }, { name: "B", unitCents: 1000, qty: 1 }], fulfilment: "takeaway", config: gst, coupon: { amountCents: 300, minSpendCents: 0 } });
    // A keeps 1,800 inclusive -> 149 of tax inside; B keeps 900 -> 81 added
    expect(r).toMatchObject({ taxIncluded: 149, gst: 81, couponDiscount: 300, total: 3000 - 300 + 81 });
  });

  it("the service charge is shared the same way, so a dine-in bill still adds up to the cent", () => {
    const r = priceOrder({ lines: [{ name: "A", unitCents: 3000, qty: 1, taxInclusive: true }], fulfilment: "dine_in", config: { ...gst, serviceRate: 0.08 } });
    expect(r.service).toBe(240);
    expect(r.taxIncluded).toBe(268); // (3000 + 240) x 9/109
    expect(r.total).toBe(3240);
  });

  it("no GST set up means no tax shown, whatever a line says", () => {
    const r = priceOrder({ lines: goods, fulfilment: "takeaway", config: { ...DEFAULT_PRICING, gstOn: false } });
    expect(r).toMatchObject({ taxIncluded: 0, gst: 0, taxes: [], total: 3020 });
  });

  it("tax groups carry their own name and rate", () => {
    const cfg = { ...gst, taxGroups: { luxury: { name: "Luxury tax", rate: 0.2 } } };
    const r = priceOrder({ lines: [{ name: "Wine", unitCents: 1200, qty: 1, taxInclusive: true, taxGroup: "luxury" }, { name: "Bread", unitCents: 1090, qty: 1, taxInclusive: true }], fulfilment: "takeaway", config: cfg });
    expect(r.taxes).toEqual([
      { group: "luxury", name: "Luxury tax", rate: 0.2, basis: "included", cents: 200 },
      { group: "default", name: "GST", rate: 0.09, basis: "included", cents: 90 },
    ]);
    expect(r.taxIncluded).toBe(290);
    expect(r.total).toBe(2290);
  });

  it("points still come off at the end and never change the tax", () => {
    const r = priceOrder({ lines: goods, fulfilment: "takeaway", config: gst, points: { balance: 500, requested: 500 } });
    expect(r.taxIncluded).toBe(248);
    expect(r.pointsDiscount).toBe(500);
    expect(r.total).toBe(3020 - 500);
  });
});

describe("tax-inclusive items through the catalogue", () => {
  const catalog: Catalog = {
    version: 1, defaultPricebookId: "std",
    products: [{ id: "bowl", name: "Bowl", category: "Mains", taxInclusive: true }, { id: "cola", name: "Cola BCRS", category: "Drinks", bcrs: true, taxInclusive: true }, { id: "tea", name: "Tea", category: "Drinks" }],
    pricebooks: [{ id: "std", name: "Standard", missing: "show", prices: { bowl: 2000, cola: 500, tea: 300 } }],
    channels: [{ id: "tk", name: "Take away", kind: "takeaway", serviceCharge: false, active: true }],
    assignments: [],
  };
  it("a product's own flag decides: the bowl and cola include tax, the tea has it added", () => {
    const base = PRESETS.fastServe("b", "B", "O");
    const config = { ...base, pricing: { ...base.pricing, gstOn: true, gstRate: 0.09 } };
    const q = quoteOrder(catalog, config, { outletId: "O", channelId: "tk" }, [{ productId: "bowl", qty: 1 }, { productId: "cola", qty: 2 }, { productId: "tea", qty: 1 }]);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // inside: (2000 + 1000) x 9/109 = 248; added: 300 x 9% = 27; deposit 20
    expect(q.priced).toMatchObject({ subtotal: 3300, taxIncluded: 248, gst: 27, bcrs: 20, total: 3300 + 27 + 20 });
  });
});
