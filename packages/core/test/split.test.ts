import { describe, expect, it } from "vitest";
import { PRESETS, orderTotals, reduceAll, staffSales, splitBySeat, splitByItem, splitEvenly, splitManually, reduceOrder, nextCourse, lineFired, checkStanding, type OrderEvent } from "../src/index.js";

const sum = (p: Array<{ totalCents: number }> | null) => (p ?? []).reduce((n, c) => n + c.totalCents, 0);

describe("split bill", () => {
  it("splits evenly with the extra cents on the earliest checks", () => {
    expect(splitEvenly(491, 2)!.map((c) => c.totalCents)).toEqual([246, 245]);
    expect(splitEvenly(100, 3)!.map((c) => c.totalCents)).toEqual([34, 33, 33]);
    expect(splitEvenly(100, 1)).toBeNull();
  });
  it("keyed amounts leave the rest as the last check, never more than the bill", () => {
    expect(splitManually(1000, [300, 250])!.map((c) => c.totalCents)).toEqual([300, 250, 450]);
    expect(splitManually(1000, [1000])).toBeNull();
    expect(splitManually(1000, [0])).toBeNull();
  });
  const lines = [{ lineId: "a", qty: 2, unitCents: 300, seat: 1 }, { lineId: "b", qty: 1, unitCents: 220, seat: 2 }, { lineId: "c", qty: 1, unitCents: 150, seat: 2 }];
  it("by item needs every unit taken and always adds up to the total", () => {
    expect(splitByItem(lines, [{ a: 1, b: 1 }, { a: 1 }], 1111)).toBeNull();
    const p = splitByItem(lines, [{ a: 1, b: 1 }, { a: 1, c: 1 }], 1111)!;
    expect(sum(p)).toBe(1111);
    expect(p[0]!.shares).toEqual([{ lineId: "a", qty: 1 }, { lineId: "b", qty: 1 }]);
  });
  it("by seat makes a check for each seat", () => {
    const p = splitBySeat(lines, 1000)!;
    expect(p.map((c) => c.seat)).toEqual([1, 2]);
    expect(sum(p)).toBe(1000);
    expect(splitBySeat(lines.map((l) => ({ ...l, seat: 1 })), 1000)).toBeNull();
  });
});

const ev = (orderId: string, ts: number, body: object): OrderEvent => ({ id: `${orderId}${ts}`, orderId, deviceId: "d", ts, seq: ts, ...body } as unknown as OrderEvent);

describe("courses, checks and merge in the order record", () => {
  const e = [
    ev("o", 1, { type: "OrderOpened", fulfilment: "dine_in", spot: "Table 5" }),
    ev("o", 2, { type: "ItemAdded", lineId: "l1", productId: "p", name: "Soup", unitCents: 500, qty: 1, course: 1 }),
    ev("o", 3, { type: "ItemAdded", lineId: "l2", productId: "p", name: "Steak", unitCents: 2000, qty: 1, course: 2 }),
    ev("o", 4, { type: "ItemAdded", lineId: "l3", productId: "p", name: "Water", unitCents: 100, qty: 1 }),
    ev("o", 5, { type: "CourseFired", course: 1 }),
    ev("o", 6, { type: "GuestsChanged", pax: 3 }),
    ev("o", 7, { type: "SplitCreated", method: "even", checks: [{ id: "c1", totalCents: 1300 }, { id: "c2", totalCents: 1300 }] }),
    ev("o", 8, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 1000, confirmed: true, checkId: "c1" }),
  ];
  it("fires courses in order and knows which lines are out", () => {
    const s = reduceOrder("o", e.slice(0, 4))!;
    expect(nextCourse(s)).toBe(1);
    const t = reduceOrder("o", e)!;
    expect(nextCourse(t)).toBe(2);
    expect(t.lines.map((l) => lineFired(t, l))).toEqual([true, false, true]);
    expect(t.pax).toBe(3);
  });
  it("tracks what each check has taken", () => {
    const t = reduceOrder("o", e)!;
    expect(checkStanding(t, "c1")).toEqual({ totalCents: 1300, paidCents: 1000, dueCents: 300, exactDueCents: 300, roundingCents: 0 });
    expect(checkStanding(t, "zz")).toBeNull();
    const cleared = reduceOrder("o", [...e, ev("o", 9, { type: "SplitCleared" })])!;
    expect(cleared.split).toBeUndefined();
  });
  it("rounds each check on its own, and the order's total stays the sum of its checks", () => {
    const config = PRESETS.fastServe("b", "B", "O");
    // one S$4.25 item, split 2.13 / 2.12; cash rounds to five cents
    const base = [
      ev("r", 1, { type: "OrderOpened", fulfilment: "takeaway", channelId: "take", serviceCharge: false }),
      ev("r", 2, { type: "ItemAdded", lineId: "l1", productId: "p", name: "Set", unitCents: 425, qty: 1 }),
      ev("r", 3, { type: "SplitCreated", method: "even", checks: [{ id: "c1", totalCents: 213 }, { id: "c2", totalCents: 212 }] }),
    ];
    const exact = orderTotals(reduceOrder("r", base)!, config).total;
    // check 1 pays S$2.15 in cash (two cents up)
    const one = reduceOrder("r", [...base, ev("r", 4, { type: "RoundingApplied", cents: 2, tender: "cash", checkId: "c1" }), ev("r", 5, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 215, confirmed: true, checkId: "c1" })])!;
    expect(checkStanding(one, "c1")).toMatchObject({ totalCents: 215, paidCents: 215, dueCents: 0, exactDueCents: 0, roundingCents: 2 });
    expect(checkStanding(one, "c2")).toMatchObject({ totalCents: 212, dueCents: 212, exactDueCents: 212, roundingCents: 0 });
    expect(orderTotals(one, config).total).toBe(exact + 2);
    // check 2 pays S$2.10 in cash (two cents down): it owes nothing, and the two roundings cancel
    const both = reduceOrder("r", [...base, ev("r", 4, { type: "RoundingApplied", cents: 2, checkId: "c1" }), ev("r", 5, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 215, confirmed: true, checkId: "c1" }), ev("r", 6, { type: "RoundingApplied", cents: -2, checkId: "c2" }), ev("r", 7, { type: "PaymentRecorded", paymentId: "p2", method: "cash", amountCents: 210, confirmed: true, checkId: "c2" })])!;
    expect(checkStanding(both, "c2")).toMatchObject({ totalCents: 210, paidCents: 210, dueCents: 0, exactDueCents: 0, roundingCents: -2 });
    expect(both.roundingCents).toBeUndefined();
    expect(orderTotals(both, config).total).toBe(exact);
    expect(both.payments.reduce((n, p) => n + p.amountCents, 0)).toBe(orderTotals(both, config).total);
    // a check paid by card afterwards is charged to the cent: its rounding is set back to nothing
    const card = reduceOrder("r", [...base, ev("r", 4, { type: "RoundingApplied", cents: 2, checkId: "c1" }), ev("r", 5, { type: "RoundingApplied", cents: 0, checkId: "c1" })])!;
    expect(checkStanding(card, "c1")).toMatchObject({ totalCents: 213, exactDueCents: 213, roundingCents: 0 });
    expect(card.checkRounding).toBeUndefined();
    // rounding against a check that does not exist is ignored; clearing the split takes the checks' rounding with it
    expect(reduceOrder("r", [...base, ev("r", 4, { type: "RoundingApplied", cents: 2, checkId: "nope" })])!.roundingCents).toBeUndefined();
    const cleared = reduceOrder("r", [...base, ev("r", 4, { type: "RoundingApplied", cents: 2, checkId: "c1" }), ev("r", 5, { type: "SplitCleared" })])!;
    expect(cleared.roundingCents).toBeUndefined();
    expect(orderTotals(cleared, config).total).toBe(exact);
  });
  it("a merged-away table is closed and points at the survivor", () => {
    const t = reduceOrder("o", [...e.slice(0, 3), ev("o", 9, { type: "OrderMerged", into: "x", intoSpot: "Table 9" })])!;
    expect(t.stage).toBe("cancelled");
    expect(t.mergedInto).toMatchObject({ orderId: "x", spot: "Table 9" });
  });
});

describe("one held item and one item sold through another channel", () => {
  const e = [
    ev("o", 1, { type: "OrderOpened", fulfilment: "dine_in", spot: "Table 5" }),
    ev("o", 2, { type: "ItemAdded", lineId: "a", productId: "p", name: "Cake", unitCents: 500, qty: 1, hold: true }),
    ev("o", 3, { type: "ItemAdded", lineId: "b", productId: "p", name: "Tea", unitCents: 300, qty: 1, channelId: "grab", channelName: "Grab" }),
    ev("o", 4, { type: "CourseFired", course: 1 }),
  ];
  it("a held item stays held, even when its course is fired, until it is fired by itself", () => {
    const s = reduceOrder("o", e)!;
    expect(s.lines.map((l) => lineFired(s, l))).toEqual([false, true]);
    const t = reduceOrder("o", [...e, ev("o", 5, { type: "LineFired", lineId: "a" })])!;
    expect(t.lines.map((l) => lineFired(t, l))).toEqual([true, true]);
    expect(t.lines[0]!.held).toBeUndefined();
  });
  it("remembers the channel an item was sold through", () => {
    expect(reduceOrder("o", e)!.lines[1]).toMatchObject({ channelId: "grab", channelName: "Grab" });
  });
});

describe("a fee on the whole order", () => {
  const cfg = PRESETS.fastServe("b", "B", "O");
  const e = [
    ev("o", 1, { type: "OrderOpened", fulfilment: "takeaway", serviceCharge: false }),
    ev("o", 2, { type: "ItemAdded", lineId: "a", productId: "p", name: "Cake", unitCents: 1000, qty: 1 }),
  ];
  it("adds a percentage of the items, or a fixed amount, to the total, and can be taken off again", () => {
    const base = orderTotals(reduceOrder("o", e)!, cfg);
    const pct = orderTotals(reduceOrder("o", [...e, ev("o", 3, { type: "FeeApplied", feeId: "f1", kind: "percent", value: 10, label: "Corkage" })])!, cfg);
    expect(pct.fee).toBe(100);
    expect(pct.total - base.total).toBeGreaterThanOrEqual(100);
    const amt = orderTotals(reduceOrder("o", [...e, ev("o", 3, { type: "FeeApplied", feeId: "f2", kind: "amount", value: 250, label: "Cake cutting" })])!, cfg);
    expect(amt.fee).toBe(250);
    const off = orderTotals(reduceOrder("o", [...e, ev("o", 3, { type: "FeeApplied", feeId: "f1", kind: "percent", value: 10, label: "x" }), ev("o", 4, { type: "FeeRemoved", feeId: "f1" })])!, cfg);
    expect(off.total).toBe(base.total);
  });
  it("ignores a fee that makes no sense", () => {
    const s = reduceOrder("o", [...e, ev("o", 3, { type: "FeeApplied", feeId: "f", kind: "percent", value: 500, label: "x" }), ev("o", 4, { type: "FeeApplied", feeId: "g", kind: "amount", value: -5, label: "x" })])!;
    expect(s.fees).toBeUndefined();
  });
});

describe("sales by person", () => {
  const cfg = PRESETS.fastServe("b", "B", "O");
  const base = (id: string, items: number, extra: OrderEvent[] = []) => [
    ev(id, 1, { type: "OrderOpened", fulfilment: "takeaway", serviceCharge: false }),
    ev(id, 2, { type: "ItemAdded", lineId: `${id}a`, productId: "p", name: "Cake", unitCents: items, qty: 1 }),
    ...extra,
  ];
  const pay = (id: string, cents: number, by: string | undefined, method = "cash", shiftId?: string) => ev(id, 5, { type: "PaymentRecorded", paymentId: `${id}-p`, method, amountCents: cents, confirmed: true, ...(by ? { byName: by } : {}), ...(shiftId ? { shiftId } : {}) });
  const orders = reduceAll([
    ...base("o1", 1000, [pay("o1", 1000, "Cat")]),
    ...base("o2", 2000, [pay("o2", 2000, "Cat", "paynow")]),
    ...base("o3", 500, [pay("o3", 500, undefined, "cash", "shift-1")]),
    ...base("o4", 700, [pay("o4", 700, undefined)]),
    ...base("o5", 3000, [pay("o5", 3000, "Dan"), ev("o5", 6, { type: "RefundRecorded", refundId: "r1", paymentId: "o5-p", method: "cash", amountCents: 1000, reason: "x", approvedBy: "m", approvedByName: "Max" }), ev("o5", 7, { type: "DiscountApplied", discountId: "d1", scope: "bill", kind: "amount", value: 200, reason: "x", byName: "Dan" })]),
    ...base("o6", 900, [pay("o6", 900, "Dan"), ev("o6", 6, { type: "OrderVoided", reason: "x", approvedBy: "m", approvedByName: "Max" })]),
  ]);
  it("gives each payment to whoever took it, by method, and works out net and average", () => {
    const r = staffSales(orders, cfg, (sid) => (sid === "shift-1" ? "Eve" : undefined));
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    expect(by.Cat).toMatchObject({ payments: 2, takenCents: 3000, orders: 2, averageCents: 1500, byMethod: { cash: 1000, paynow: 2000 } });
    expect(by.Eve).toMatchObject({ takenCents: 500 }); // an older payment, through its shift
    expect(by["Not recorded"]).toMatchObject({ takenCents: 700 });
    expect(by.Dan).toMatchObject({ takenCents: 3900, discounts: 1, discountCents: 200 });
    expect(r.map((x) => x.name)[0]).toBe("Dan"); // biggest first
  });
  it("gives refunds and voids to the manager who approved them, and counts them against nobody else", () => {
    const by = Object.fromEntries(staffSales(orders, cfg).map((x) => [x.name, x]));
    expect(by.Max).toMatchObject({ refunds: 1, refundedCents: 1000, voids: 1, takenCents: 0, netCents: -1000 });
    expect(by.Dan!.refunds).toBe(0);
  });
  it("adds up: what was taken in total equals what the orders were paid", () => {
    const total = staffSales(orders, cfg).reduce((n, x) => n + x.takenCents, 0);
    expect(total).toBe(1000 + 2000 + 500 + 700 + 3000 + 900);
  });
});

describe("a paid table waits to be cleared", () => {
  it("records when staff cleared the table", () => {
    const o = reduceOrder("o", [ev("o", 1, { type: "OrderOpened", fulfilment: "dine_in", serviceCharge: false, spot: "T1" }), ev("o", 2, { type: "TableCleared", byName: "Cat" })])!;
    expect(o.clearedAt).toBe(2);
  });
});
