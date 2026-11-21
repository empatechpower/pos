import { describe, expect, it } from "vitest";
import { PRESETS, reduceOrder, toDisplayState, IDLE_DISPLAY } from "../src/index.js";

const cfg = PRESETS.restaurant("b1", "Bailey & Patch", "Enabling Village");
const ev = (body: object, seq: number) => ({ id: `e${seq}`, orderId: "o", ts: seq, deviceId: "d", seq, ...body }) as never;

describe("customer display state", () => {
  const events = [
    ev({ type: "OrderOpened", fulfilment: "dine_in", source: "pos", channelName: "Dine in", serviceCharge: true, queueNumber: "0128" }, 1),
    ev({ type: "ItemAdded", lineId: "a", productId: "kaya", name: "Kaya Toast", unitCents: 200, qty: 1 }, 2),
    ev({ type: "ItemAdded", lineId: "b", productId: "coke", name: "Coke Classic 320ml", unitCents: 250, qty: 1, bcrs: true }, 3),
    ev({ type: "ItemAdded", lineId: "c", productId: "coffee", name: "Coffee", unitCents: 220, qty: 1, options: [{ group: "Temperature", name: "Hot", qty: 1, priceCents: 0 }] }, 4),
  ];
  const order = reduceOrder("o", events)!;

  it("lists the lines with their choices, tags the deposit item, and the totals add up", () => {
    const d = toDisplayState(order, cfg);
    expect(d.mode).toBe("sale");
    expect(d.orderNo).toBe("0128");
    expect(d.orderType).toBe("Dine in");
    expect(d.lines.map((l) => [l.qty, l.name, l.lineCents])).toEqual([[1, "Kaya Toast", 200], [1, "Coke Classic 320ml", 250], [1, "Coffee", 220]]);
    expect(d.lines[1]!.deposit).toBe(true);
    expect(d.lines[2]!.details).toEqual(["Hot"]);
    const signed = d.totals.reduce((n, t) => n + (t.negative ? -t.cents : t.cents), 0);
    expect(signed).toBe(d.totalCents);
    expect(d.totals.find((t) => t.key === "deposit")!.cents).toBe(10);
    expect(d.totals.some((t) => t.key === "total")).toBe(false); // the total is its own big figure
  });

  it("is idle with nothing in the order, and carries the payment QR in pay mode", () => {
    expect(toDisplayState(reduceOrder("o", [events[0]!])!, cfg).mode).toBe("idle");
    expect(IDLE_DISPLAY.mode).toBe("idle");
    const pay = toDisplayState(order, cfg, { mode: "pay", qrText: "paynow-string", demo: true });
    expect(pay.mode).toBe("pay");
    expect(pay.qrText).toBe("paynow-string");
    expect(pay.demo).toBe(true);
  });
});
