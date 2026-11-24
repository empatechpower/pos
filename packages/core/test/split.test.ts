import { describe, expect, it } from "vitest";
import { splitBySeat, splitByItem, splitEvenly, splitManually, reduceOrder, nextCourse, lineFired, checkStanding, type OrderEvent } from "../src/index.js";

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
    expect(checkStanding(t, "c1")).toEqual({ totalCents: 1300, paidCents: 1000, dueCents: 300 });
    expect(checkStanding(t, "zz")).toBeNull();
    const cleared = reduceOrder("o", [...e, ev("o", 9, { type: "SplitCleared" })])!;
    expect(cleared.split).toBeUndefined();
  });
  it("a merged-away table is closed and points at the survivor", () => {
    const t = reduceOrder("o", [...e.slice(0, 3), ev("o", 9, { type: "OrderMerged", into: "x", intoSpot: "Table 9" })])!;
    expect(t.stage).toBe("cancelled");
    expect(t.mergedInto).toMatchObject({ orderId: "x", spot: "Table 9" });
  });
});
