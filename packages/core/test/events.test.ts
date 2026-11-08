import { describe, expect, it } from "vitest";
import {
  PRESETS,
  formatQueueNumber,
  isFullyPaid,
  mergeEvents,
  nextQueueCounter,
  reduceAll,
  reduceOrder,
  visibleToKitchen,
  type OrderEvent,
  type OrderEventBody,
} from "../src/index.js";

let n = 0;
const ev = (deviceId: string, orderId: string, ts: number, body: OrderEventBody): OrderEvent =>
  ({ id: `${deviceId}-${++n}`, orderId, deviceId, ts, seq: n, ...body }) as OrderEvent;

const fast = PRESETS.fastServe("b1", "Bailey & Patch", "Enabling Village");
const resto = PRESETS.restaurant("b1", "Bailey & Patch", "Enabling Village");

const baseEvents = (): OrderEvent[] => [
  ev("tabA", "o1", 1, { type: "OrderOpened", fulfilment: "takeaway", queueNumber: "A001" }),
  ev("tabA", "o1", 2, { type: "ItemAdded", lineId: "l1", productId: "p1", name: "Kaya Toast", unitCents: 200, qty: 2 }),
];

describe("order event log", () => {
  it("rebuilds an order from events", () => {
    const o = reduceOrder("o1", baseEvents())!;
    expect(o.queueNumber).toBe("A001");
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]!.qty).toBe(2);
  });

  it("is idempotent: replaying duplicates changes nothing", () => {
    const e = baseEvents();
    const once = reduceOrder("o1", e);
    const twice = reduceOrder("o1", [...e, ...e]);
    expect(twice).toEqual(once);
  });

  it("is order-independent: events arriving shuffled give the same order", () => {
    const e = [
      ...baseEvents(),
      ev("tabB", "o1", 3, { type: "ItemAdded", lineId: "l2", productId: "p2", name: "Coffee", unitCents: 220, qty: 1 }),
      ev("tabA", "o1", 4, { type: "ItemQtySet", lineId: "l1", qty: 3 }),
    ];
    const shuffled = [e[3]!, e[1]!, e[0]!, e[2]!];
    expect(reduceOrder("o1", shuffled)).toEqual(reduceOrder("o1", e));
  });

  it("two tablets adding items while offline merge cleanly", () => {
    const opened = baseEvents();
    const tabletA = [ev("tabA", "o1", 10, { type: "ItemAdded", lineId: "a1", productId: "p3", name: "Teh", unitCents: 180, qty: 1 })];
    const tabletB = [ev("tabB", "o1", 11, { type: "ItemAdded", lineId: "b1", productId: "p4", name: "Toast", unitCents: 250, qty: 1 })];
    const merged = mergeEvents(mergeEvents(opened, tabletA), tabletB);
    expect(reduceOrder("o1", merged)!.lines.map((l) => l.lineId).sort()).toEqual(["a1", "b1", "l1"]);
  });

  it("reduceAll lists orders newest first", () => {
    const e = [
      ...baseEvents(),
      ev("tabA", "o2", 100, { type: "OrderOpened", fulfilment: "dine_in", spot: "Table 5" }),
    ];
    expect(reduceAll(e).map((o) => o.orderId)).toEqual(["o2", "o1"]);
  });
});

describe("payment timing drives the kitchen", () => {
  it("fast serve (prepay): the kitchen sees the order only once paid", () => {
    const e = baseEvents();
    expect(visibleToKitchen(reduceOrder("o1", e)!, fast)).toBe(false);
    const paid = [...e, ev("tabA", "o1", 5, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 400, confirmed: true })];
    expect(visibleToKitchen(reduceOrder("o1", paid)!, fast)).toBe(true);
  });

  it("restaurant (postpay): the kitchen sees the order straight away, bill stays open", () => {
    const o = reduceOrder("o1", baseEvents())!;
    expect(visibleToKitchen(o, resto)).toBe(true);
    expect(isFullyPaid(o, resto)).toBe(false);
  });

  it("an online payment is not paid until the gateway confirms it", () => {
    const e = [
      ...baseEvents(),
      ev("tabA", "o1", 5, { type: "PaymentRecorded", paymentId: "p1", method: "card", amountCents: 400, confirmed: false }),
    ];
    expect(isFullyPaid(reduceOrder("o1", e)!, fast)).toBe(false);
    const confirmed = [...e, ev("server", "o1", 6, { type: "PaymentConfirmed", paymentId: "p1" })];
    expect(isFullyPaid(reduceOrder("o1", confirmed)!, fast)).toBe(true);
  });

  it("underpayment is not fully paid", () => {
    const e = [...baseEvents(), ev("tabA", "o1", 5, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 100, confirmed: true })];
    expect(isFullyPaid(reduceOrder("o1", e)!, fast)).toBe(false);
  });

  it("cancelled orders never reach the kitchen", () => {
    const e = [...baseEvents(), ev("tabA", "o1", 5, { type: "StageSet", stage: "cancelled" })];
    expect(visibleToKitchen(reduceOrder("o1", e)!, resto)).toBe(false);
  });
});

describe("offline-safe queue numbers", () => {
  it("formats per-device numbers", () => {
    expect(formatQueueNumber("A", 7)).toBe("A007");
  });
  it("continues from the highest number this device issued today", () => {
    expect(nextQueueCounter("A", ["A001", "A002", "B009"])).toBe(3);
    expect(nextQueueCounter("B", ["A001", "A002", "B009"])).toBe(10);
    expect(nextQueueCounter("C", [])).toBe(1);
  });
  it("two devices can never collide", () => {
    expect(formatQueueNumber("A", 1)).not.toBe(formatQueueNumber("B", 1));
  });
});
