import { describe, expect, it } from "vitest";
import { PRESETS, orderTotals, priceOrder, reduceOrder, staffDiscountCents, totalsLines, DEFAULT_PRICING, type OrderEvent, type OrderEventBody, type StaffDiscount } from "../src/index.js";

let n = 0;
const ev = (orderId: string, ts: number, body: OrderEventBody): OrderEvent => ({ id: `d${++n}`, orderId, deviceId: "t", ts, seq: n, ...body }) as OrderEvent;
const d = (o: Partial<StaffDiscount> & Pick<StaffDiscount, "id" | "scope" | "kind" | "value">): StaffDiscount => ({ reason: "Test", at: 1, ...o });
const lines = [{ lineId: "a", unitCents: 500, qty: 2 }, { lineId: "b", unitCents: 300, qty: 1 }]; // 1000 + 300

describe("staff discounts", () => {
  it("a line discount comes off its own line; a bill discount comes off what is left", () => {
    expect(staffDiscountCents(lines, [d({ id: "1", scope: "line", lineId: "a", kind: "percent", value: 10 })]).totalCents).toBe(100);
    expect(staffDiscountCents(lines, [d({ id: "1", scope: "line", lineId: "a", kind: "percent", value: 10 }), d({ id: "2", scope: "bill", kind: "percent", value: 10 })]).byDiscount).toEqual({ "1": 100, "2": 120 });
    expect(staffDiscountCents(lines, [d({ id: "1", scope: "bill", kind: "amount", value: 250 })]).totalCents).toBe(250);
  });
  it("never takes off more than there is, and a line that is gone has nothing to discount", () => {
    expect(staffDiscountCents(lines, [d({ id: "1", scope: "line", lineId: "b", kind: "amount", value: 9999 })]).totalCents).toBe(300);
    expect(staffDiscountCents(lines, [d({ id: "1", scope: "line", lineId: "b", kind: "amount", value: 100 }), d({ id: "2", scope: "bill", kind: "amount", value: 99999 })]).totalCents).toBe(1300);
    expect(staffDiscountCents([{ lineId: "a", unitCents: 500, qty: 0 }], [d({ id: "1", scope: "line", lineId: "a", kind: "percent", value: 50 })]).totalCents).toBe(0);
    expect(staffDiscountCents(lines, [d({ id: "1", scope: "bill", kind: "percent", value: 250 })]).totalCents).toBe(1300);
  });
  it("comes off before service charge and GST, so both are charged on less", () => {
    const cfg = { ...DEFAULT_PRICING, gstOn: true, serviceRate: 0.1 };
    const plain = priceOrder({ lines: [{ name: "x", unitCents: 1000, qty: 1 }], fulfilment: "dine_in", config: cfg });
    const less = priceOrder({ lines: [{ name: "x", unitCents: 1000, qty: 1 }], fulfilment: "dine_in", discountCents: 200, config: cfg });
    expect(plain).toMatchObject({ service: 100, gst: 99, total: 1199 });
    expect(less).toMatchObject({ discountCents: 200, service: 80, gst: 79, total: 1000 - 200 + 80 + 79 });
    expect(totalsLines(less).find((l) => l.key === "discount")).toMatchObject({ cents: 200, negative: true });
  });
  it("an order rebuilt from its events: apply, remove, and override a price", () => {
    const cfg = PRESETS.fastServe("b1", "Cafe", "Main");
    const base = [ev("o", 1, { type: "OrderOpened", fulfilment: "takeaway" }), ev("o", 2, { type: "ItemAdded", lineId: "a", productId: "p", name: "Toast", unitCents: 500, qty: 2 })];
    const t0 = orderTotals(reduceOrder("o", base)!, cfg);
    const withDisc = reduceOrder("o", [...base, ev("o", 3, { type: "DiscountApplied", discountId: "x1", scope: "line", lineId: "a", kind: "percent", value: 20, reason: "Staff meal", byName: "Cat", approvedByName: "Max" })])!;
    expect(withDisc.discounts).toHaveLength(1);
    expect(orderTotals(withDisc, cfg).total).toBe(t0.total - 200);
    // the same event twice counts once; removing it puts the price back
    const twice = reduceOrder("o", [...base, ev("o", 3, { type: "DiscountApplied", discountId: "x1", scope: "bill", kind: "amount", value: 100, reason: "A" }), ev("o", 4, { type: "DiscountApplied", discountId: "x1", scope: "bill", kind: "amount", value: 100, reason: "A" })])!;
    expect(twice.discounts).toHaveLength(1);
    const removed = reduceOrder("o", [...base, ev("o", 3, { type: "DiscountApplied", discountId: "x1", scope: "bill", kind: "amount", value: 100, reason: "A" }), ev("o", 4, { type: "DiscountRemoved", discountId: "x1" })])!;
    expect(orderTotals(removed, cfg).total).toBe(t0.total);
    const over = reduceOrder("o", [...base, ev("o", 3, { type: "LinePriceOverridden", lineId: "a", unitCents: 400, reason: "Price match", byName: "Cat", approvedByName: "Max" })])!;
    expect(over.lines[0]).toMatchObject({ unitCents: 400, listUnitCents: 500, override: { reason: "Price match", approvedByName: "Max" } });
    expect(orderTotals(over, cfg).total).toBe(t0.total - 200);
  });
});
