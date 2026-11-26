import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, priceOrder, totalsLines, type PricingConfig } from "../src/pricing.js";
import { TAX_PACKS, isTaxCountry, roundTotal, taxPackFor, withTaxPack } from "../src/taxPacks.js";
import { orderTotals, reduceOrder, type OrderEvent } from "../src/events.js";
import { PRESETS } from "../src/config.js";

const on: PricingConfig = { ...DEFAULT_PRICING, gstOn: true };
const line = (unitCents: number, qty = 1, extra: object = {}) => ({ name: "Item", unitCents, qty, ...extra });

describe("country tax packs", () => {
  it("Singapore is GST 9%, and an unknown country falls back to it", () => {
    expect(TAX_PACKS.SG).toMatchObject({ taxName: "GST", rate: 0.09 });
    expect(taxPackFor("ZZ").country).toBe("SG");
    expect(taxPackFor(null).country).toBe("SG");
    expect(isTaxCountry("SG")).toBe(true);
    expect(isTaxCountry("toString")).toBe(false);
  });
  it("the pack writes the rate and name into the pricing rules, whatever was there", () => {
    const p = withTaxPack({ ...on, gstRate: 0.5, rounding: { stepCents: 5, mode: "nearest" } }, "SG");
    expect(p.gstRate).toBe(0.09);
    expect(p.taxName).toBe("GST");
    expect(p.taxInclusive).toBe(true); // Singapore prices include GST
    expect(p.country).toBe("SG");
    expect(p.rounding).toBeUndefined(); // Singapore's pack has none, so one set by hand does not survive
    expect(p.taxRemovable).toBe(false);
    expect(p.gstOn).toBe(true); // registration is the shop's, not the pack's
  });
});

describe("rounding the total", () => {
  it("rounds to the step by the rule", () => {
    const near = { stepCents: 5, mode: "nearest" as const };
    expect([1001, 1002, 1003, 1004, 1005, 1007, 1008].map((c) => roundTotal(c, near))).toEqual([1000, 1000, 1005, 1005, 1005, 1005, 1010]);
    expect(roundTotal(1004, { stepCents: 5, mode: "down" })).toBe(1000);
    expect(roundTotal(1001, { stepCents: 5, mode: "up" })).toBe(1005);
    expect(roundTotal(1003, undefined)).toBe(1003);
    expect(roundTotal(1003, { stepCents: 1, mode: "nearest" })).toBe(1003);
  });
  it("shows the difference as its own line, and the lines still add up to the total", () => {
    const cfg: PricingConfig = { ...on, rounding: { stepCents: 5, mode: "nearest" } };
    const r = priceOrder({ lines: [line(1130)], fulfilment: "takeaway", config: cfg }); // 11.30 + 9% = 12.317 -> 12.32 -> 12.30
    expect(r.gst).toBe(102);
    expect(r.total).toBe(1230);
    expect(r.rounding).toBe(-2);
    const lines = totalsLines(r);
    expect(lines.find((l) => l.key === "rounding")).toMatchObject({ cents: 2, negative: true });
    const sum = lines.filter((l) => l.key !== "total" && l.key !== "tax_included").reduce((n, l) => n + (l.negative ? -l.cents : l.cents), 0);
    expect(sum).toBe(r.total);
  });
  it("no rounding line when the total already sits on the step, or when the pack has no rule", () => {
    expect(priceOrder({ lines: [line(1000)], fulfilment: "takeaway", config: { ...DEFAULT_PRICING, rounding: { stepCents: 5, mode: "nearest" } } }).rounding).toBeUndefined();
    const r = priceOrder({ lines: [line(1130)], fulfilment: "takeaway", config: on });
    expect(r.total).toBe(1232);
    expect(r.rounding).toBeUndefined();
    expect(totalsLines(r).some((l) => l.key === "rounding")).toBe(false);
  });
});

describe("taking the tax off an order", () => {
  it("tax added on top is simply not added", () => {
    const r = priceOrder({ lines: [line(1000)], fulfilment: "takeaway", taxRemoved: true, config: on });
    expect(r.gst).toBe(0);
    expect(r.total).toBe(1000);
    expect(r.taxRemoved).toEqual({ cents: 90, offTotal: 0, name: "GST" });
    expect(r.taxes).toEqual([]);
  });
  it("tax inside the prices comes off the total", () => {
    const r = priceOrder({ lines: [line(1090)], fulfilment: "takeaway", taxRemoved: true, config: { ...on, taxInclusive: true } });
    expect(r.taxRemoved).toEqual({ cents: 90, offTotal: 90, name: "GST" });
    expect(r.total).toBe(1000);
    expect(r.taxIncluded).toBe(0);
    expect(totalsLines(r).find((l) => l.key === "tax_removed")).toMatchObject({ label: "GST removed", cents: 90, negative: true });
  });
  it("does nothing when the shop charges no tax, and never touches the deposit", () => {
    const off = priceOrder({ lines: [line(1000)], fulfilment: "takeaway", taxRemoved: true, config: DEFAULT_PRICING });
    expect(off.taxRemoved).toBeUndefined();
    expect(off.total).toBe(1000);
    const dep = priceOrder({ lines: [line(200, 2, { bcrs: true })], fulfilment: "takeaway", taxRemoved: true, config: on });
    expect(dep.bcrs).toBe(20);
    expect(dep.total).toBe(420);
  });
  it("is an order event: removed, then put back", () => {
    const config = PRESETS.restaurant("m", "Shop", "Outlet");
    config.pricing = { ...config.pricing, gstOn: true, serviceOn: false };
    const base = { orderId: "o1", deviceId: "d", merchantId: "m" };
    const evs = [
      { ...base, id: "e1", seq: 1, ts: 1, type: "OrderOpened", fulfilment: "takeaway" },
      { ...base, id: "e2", seq: 2, ts: 2, type: "ItemAdded", lineId: "l1", productId: "p", name: "Tea", unitCents: 1000, qty: 1 },
      { ...base, id: "e3", seq: 3, ts: 3, type: "TaxRemovalSet", removed: true, reason: "Diplomatic sale", byName: "Cashier", approvedByName: "Manager" },
    ] as unknown as OrderEvent[];
    const removed = reduceOrder("o1", evs)!;
    expect(removed.taxRemoved).toMatchObject({ reason: "Diplomatic sale", byName: "Cashier", approvedByName: "Manager" });
    expect(orderTotals(removed, config).total).toBe(1000);
    const back = reduceOrder("o1", [...evs, { ...base, id: "e4", seq: 4, ts: 4, type: "TaxRemovalSet", removed: false, reason: "" } as unknown as OrderEvent])!;
    expect(back.taxRemoved).toBeUndefined();
    expect(orderTotals(back, config).total).toBe(1090);
  });
});

describe("service charge: by each line's own channel, at the rate the order opened with", () => {
  const rest: PricingConfig = { ...DEFAULT_PRICING, serviceOn: true, serviceRate: 0.09 };
  it("a take-away line on a dine-in order pays no service charge (the prototype's totals)", () => {
    // Dine in: Kaya 2.00 and Milo 2.50 (charged) + one Coffee 2.00 taken away (not charged): 9% of 4.50 = 0.405 -> 0.41
    const r = priceOrder({ lines: [line(200), line(250), line(200, 1, { serviceCharge: false })], fulfilment: "dine_in", config: rest });
    expect(r.service).toBe(41);
    expect(r.total).toBe(691);
  });
  it("and a dine-in line on a take-away order does", () => {
    const r = priceOrder({ lines: [line(1000), line(1000, 1, { serviceCharge: true })], fulfilment: "takeaway", config: rest });
    expect(r.service).toBe(90);
  });
  it("with no line on another channel, nothing changes", () => {
    expect(priceOrder({ lines: [line(200), line(250)], fulfilment: "dine_in", config: rest }).service).toBe(41);
    expect(priceOrder({ lines: [line(200), line(250)], fulfilment: "takeaway", config: rest }).service).toBe(0);
    expect(priceOrder({ lines: [line(1000)], fulfilment: "dine_in", discountCents: 200, config: rest }).service).toBe(72);
  });
  it("a bill discount is shared by value, so only the charged lines' part lowers the charge", () => {
    // 10.00 charged + 10.00 not charged, 4.00 off the bill: the charged half carries 2.00 of it -> 9% of 8.00
    const r = priceOrder({ lines: [line(1000), line(1000, 1, { serviceCharge: false })], fulfilment: "dine_in", discountCents: 400, config: rest });
    expect(r.service).toBe(72);
    expect(r.total).toBe(1672);
  });
  it("an order keeps the rate it was opened at when the shop changes its rate", () => {
    const config = PRESETS.restaurant("m", "Shop", "Outlet");
    config.pricing = { ...config.pricing, serviceOn: true, serviceRate: 0.09 };
    const base = { orderId: "o9", deviceId: "d" };
    const evs = [
      { ...base, id: "s1", seq: 1, ts: 1, type: "OrderOpened", fulfilment: "dine_in", serviceCharge: true, serviceRate: 0.09 },
      { ...base, id: "s2", seq: 2, ts: 2, type: "ItemAdded", lineId: "l1", productId: "p", name: "Set", unitCents: 1000, qty: 1 },
      { ...base, id: "s3", seq: 3, ts: 3, type: "ItemAdded", lineId: "l2", productId: "q", name: "Tea", unitCents: 1000, qty: 1, channelId: "take-away", serviceCharge: false },
    ] as unknown as OrderEvent[];
    const o = reduceOrder("o9", evs)!;
    expect(orderTotals(o, config).service).toBe(90); // the take-away tea is not charged
    config.pricing = { ...config.pricing, serviceRate: 0.1 };
    expect(orderTotals(o, config).service).toBe(90); // still 9%
    const old = reduceOrder("o9", [{ ...evs[0]!, serviceRate: undefined } as unknown as OrderEvent, evs[1]!])!;
    expect(orderTotals(old, config).service).toBe(100); // an order from before this follows the shop's rate
  });
});

describe("rounding by tender, chosen by the outlet from what its country offers", () => {
  it("Singapore and Malaysia both offer 5 and 10 cents; anything else is refused", async () => {
    const { cleanTenderRounding } = await import("../src/taxPacks.js");
    expect(TAX_PACKS.SG!.roundingSteps).toEqual([5, 10]);
    expect(TAX_PACKS.MY).toMatchObject({ taxName: "SST", roundingSteps: [5, 10] });
    expect(cleanTenderRounding({ cash: 5 }, "SG")).toEqual({ cash: 5 });
    expect(cleanTenderRounding({ cash: 10, card: 0 }, "MY")).toEqual({ cash: 10 });
    expect(cleanTenderRounding({ cash: 100 }, "SG")).toBeNull();
    expect(cleanTenderRounding({ "Cash!": 5 }, "SG")).toBeNull();
    expect(cleanTenderRounding(undefined, "SG")).toEqual({});
  });
  it("a cash payment rounded at the till keeps the difference on the order, and the lines still add up", () => {
    const config = PRESETS.fastServe("m", "Shop", "Outlet");
    const base = { orderId: "r1", deviceId: "d" };
    const evs = [
      { ...base, id: "a1", seq: 1, ts: 1, type: "OrderOpened", fulfilment: "takeaway" },
      { ...base, id: "a2", seq: 2, ts: 2, type: "ItemAdded", lineId: "l1", productId: "p", name: "Tea", unitCents: 1232, qty: 1 },
      { ...base, id: "a3", seq: 3, ts: 3, type: "RoundingApplied", cents: -2, tender: "cash" },
      { ...base, id: "a4", seq: 4, ts: 4, type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 1230, confirmed: true },
    ] as unknown as OrderEvent[];
    const o = reduceOrder("r1", evs)!;
    const t = orderTotals(o, config);
    expect(t.total).toBe(1230);
    expect(t.rounding).toBe(-2);
    expect(totalsLines(t).find((l) => l.key === "rounding")).toMatchObject({ cents: 2, negative: true });
    // before it was paid (no rounding yet) the order shows the exact amount, as a card payment would be charged
    expect(orderTotals(reduceOrder("r1", evs.slice(0, 2))!, config).total).toBe(1232);
    // nonsense is ignored
    expect(orderTotals(reduceOrder("r1", [...evs.slice(0, 2), { ...base, id: "a9", seq: 3, ts: 3, type: "RoundingApplied", cents: 500 } as unknown as OrderEvent])!, config).total).toBe(1232);
  });
  it("whether tax may be taken off is the outlet's switch, within what the country allows", () => {
    expect(withTaxPack({ ...on, taxRemovable: true }, "SG").taxRemovable).toBe(true);
    expect(withTaxPack({ ...on }, "SG").taxRemovable).toBe(false);
  });
});
