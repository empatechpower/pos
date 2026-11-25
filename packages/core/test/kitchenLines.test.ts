import { describe, expect, it } from "vitest";
import { kitchenLines, reduceOrder, type OrderEvent } from "../src/events.js";

let n = 0;
const ev = (body: object) => ({ id: `k-${++n}`, orderId: "o", deviceId: "t", ts: 1000 + n, seq: n, ...body }) as unknown as OrderEvent;
const names = (ls: Array<{ name: string }>) => ls.map((l) => l.name);
const open = () => [
  ev({ type: "OrderOpened", fulfilment: "dine_in", spot: "T5" }),
  ev({ type: "ItemAdded", lineId: "soup", productId: "p1", name: "Soup", unitCents: 500, qty: 1, course: 1 }),
  ev({ type: "ItemAdded", lineId: "steak", productId: "p2", name: "Steak", unitCents: 2000, qty: 1, course: 2 }),
  ev({ type: "ItemAdded", lineId: "tea", productId: "p3", name: "Tea", unitCents: 200, qty: 1 }),
  ev({ type: "CourseFired", course: 1 }),
];

describe("what the kitchen has to make", () => {
  it("only fired lines count: a later course waits", () => {
    const k = kitchenLines(reduceOrder("o", open())!);
    expect(names(k.toMake)).toEqual(["Soup", "Tea"]);
    expect(k.ready).toEqual([]);
  });
  it("a station finishes its lines; the rest stay to make", () => {
    const k = kitchenLines(reduceOrder("o", [...open(), ev({ type: "LinesReady", lineIds: ["tea"], station: "bar" })])!);
    expect(names(k.toMake)).toEqual(["Soup"]);
    expect(names(k.ready)).toEqual(["Tea"]);
  });
  it("served lines leave the ready list, and a course fired afterwards brings the table back", () => {
    const evs = [...open(), ev({ type: "LinesReady", lineIds: ["soup", "tea"] }), ev({ type: "LinesServed", lineIds: ["soup", "tea"] })];
    const done = kitchenLines(reduceOrder("o", evs)!);
    expect(done.toMake).toEqual([]);
    expect(done.ready).toEqual([]);
    expect(names(done.served)).toEqual(["Soup", "Tea"]);
    const next = kitchenLines(reduceOrder("o", [...evs, ev({ type: "CourseFired", course: 2 })])!);
    expect(names(next.toMake)).toEqual(["Steak"]);
  });
  it("marking the whole order ready or completed covers the lines the kitchen had by then, not ones fired later", () => {
    const ready = reduceOrder("o", [...open(), ev({ type: "StageSet", stage: "ready" }), ev({ type: "CourseFired", course: 2 })])!;
    expect(names(kitchenLines(ready).ready)).toEqual(["Soup", "Tea"]);
    expect(names(kitchenLines(ready).toMake)).toEqual(["Steak"]);
    const gone = reduceOrder("o", [...open(), ev({ type: "StageSet", stage: "completed" })])!;
    expect(names(kitchenLines(gone).served)).toEqual(["Soup", "Tea"]);
    expect(kitchenLines(gone).toMake).toEqual([]);
  });
  it("a cancelled order has nothing to make, and replaying events twice changes nothing", () => {
    const cancelled = reduceOrder("o", [...open(), ev({ type: "StageSet", stage: "cancelled" })])!;
    expect(kitchenLines(cancelled).toMake).toEqual([]);
    const evs = [...open(), ev({ type: "LinesReady", lineIds: ["tea"] })];
    expect(reduceOrder("o", [...evs, ...evs])).toEqual(reduceOrder("o", evs));
  });
});

describe("handing an order over", () => {
  it("records who took it, once: a second handover does not replace the first", () => {
    const o = reduceOrder("o", [...open(), ev({ type: "OrderHandedOver", to: "  Rider   Ali ", ref: "GRAB-8841", byName: "Cat" }), ev({ type: "OrderHandedOver", to: "Someone else" })])!;
    expect(o.handover).toMatchObject({ to: "Rider Ali", ref: "GRAB-8841", byName: "Cat" });
  });
  it("finds the order a scanned or typed code means", async () => {
    const { findOrderByCode, transactionCode } = await import("../src/print/templates.js");
    const mk = (id: string, q: string, ts: number) => reduceOrder(id, [
      { id: `${id}-1`, orderId: id, deviceId: "t", ts, seq: 1, type: "OrderOpened", fulfilment: "takeaway", queueNumber: q },
      { id: `${id}-2`, orderId: id, deviceId: "t", ts: ts + 1, seq: 2, type: "ItemAdded", lineId: "l", productId: "p", name: "Tea", unitCents: 100, qty: 1 },
    ] as unknown as OrderEvent[])!;
    const old = mk("aaaaaaaa-1111", "A012", 1_790_000_000_000), today = mk("bbbbbbbb-2222", "A012", 1_795_000_000_000), other = mk("cccccccc-3333", "B007", 1_795_000_100_000);
    const all = [old, today, other], ctx = { now: 1_795_000_200_000 };
    expect(findOrderByCode(all, "a012", ctx)?.orderId).toBe("bbbbbbbb-2222"); // the newest order with that number
    expect(findOrderByCode(all, "7", ctx)?.orderId).toBe("cccccccc-3333");
    expect(findOrderByCode(all, transactionCode(old, ctx), ctx)?.orderId).toBe("aaaaaaaa-1111"); // the receipt's barcode names its own order
    expect(findOrderByCode(all, "CCCCCCCC", ctx)?.orderId).toBe("cccccccc-3333");
    expect(findOrderByCode(all, "Z999", ctx)).toBeNull();
    expect(findOrderByCode(all, "x", ctx)).toBeNull();
  });
});

describe("taking over an order", () => {
  it("is on the order's record and changes nothing about the order", () => {
    const before = reduceOrder("o", open())!;
    const after = reduceOrder("o", [...open(), ev({ type: "OrderTakenOver", from: "Olive", byName: "Cat" })])!;
    expect(after.lines).toEqual(before.lines);
    expect(after.stage).toBe(before.stage);
  });
});
