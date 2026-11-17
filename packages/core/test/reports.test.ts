import { describe, expect, it } from "vitest";
import { PRESETS, hourly, orderTotals, productMix, summarize, type OrderState } from "../src/index.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let n = 0;
const at = (hhmm: string, day = "2026-11-16") => new Date(`${day}T${hhmm}:00+08:00`).getTime();
const order = (o: Partial<OrderState> & { openedAt: number }, price = 500, qty = 2): OrderState => ({
  orderId: `o${++n}`, fulfilment: "takeaway", channelName: "Takeaway", source: "pos",
  lines: [{ lineId: "l", productId: "toast", name: "Toast", unitCents: price, qty }], payments: [], stage: "completed", ...o,
});

describe("sales summary", () => {
  it("net sales are gross minus discounts, and net to account for equals what customers are billed", () => {
    const a = order({ openedAt: at("09:10"), coupon: { title: "S$1 off", amountCents: 100, minSpendCents: 0 }, payments: [{ paymentId: "p", method: "cash", amountCents: 0, confirmed: true }] });
    const b = order({ openedAt: at("09:40"), payments: [{ paymentId: "q", method: "credit", amountCents: 1000, confirmed: true }] });
    const s = summarize([a, b], config);
    expect(s.orders).toBe(2);
    expect(s.grossCents).toBe(2000);
    expect(s.discountsCents).toBe(100);
    expect(s.netCents).toBe(1900);
    expect(s.netToAccountForCents).toBe(orderTotals(a, config).total + orderTotals(b, config).total);
    expect(s.netCents + s.serviceCents + s.gstCents + s.liabilitiesCents).toBe(s.netToAccountForCents);
    expect(s.payments.find((p) => p.method === "credit")).toMatchObject({ cents: 1000, count: 1 });
  });

  it("counts cancelled orders as voided, not as sales, and flags unpaid ones", () => {
    const s = summarize([order({ openedAt: at("10:00") }), order({ openedAt: at("10:05"), stage: "cancelled" })], config);
    expect(s.orders).toBe(1);
    expect(s.voided.orders).toBe(1);
    expect(s.voided.cents).toBeGreaterThan(0);
    expect(s.unpaidOrders).toBe(1);
  });
});

describe("hourly sales", () => {
  it("groups by Singapore hour with transactions, items, average and total", () => {
    const rows = hourly([order({ openedAt: at("09:10") }), order({ openedAt: at("09:50"), lines: [{ lineId: "l", productId: "t", name: "Toast", unitCents: 500, qty: 4 }] }), order({ openedAt: at("13:00") })], config);
    expect(rows.map((r) => r.hour)).toEqual([9, 13]);
    expect(rows[0]).toMatchObject({ orders: 2, items: 6 });
    expect(rows[0]!.averageCents).toBe(Math.round(rows[0]!.cents / 2));
  });
});

describe("product mix", () => {
  const all = [
    order({ openedAt: at("09:00"), lines: [{ lineId: "1", productId: "toast", name: "Toast", unitCents: 300, qty: 3 }] }),
    order({ openedAt: at("09:05", "2026-11-17"), channelName: "Dine-in", lines: [{ lineId: "2", productId: "kopi", name: "Kopi", unitCents: 200, qty: 5 }] }),
    order({ openedAt: at("09:10"), stage: "cancelled", lines: [{ lineId: "3", productId: "toast", name: "Toast", unitCents: 300, qty: 9 }] }),
  ];
  const cat = (id: string) => (id === "kopi" ? "Drinks" : "Food");
  it("ranks by quantity with category, average price and share, ignoring cancelled orders", () => {
    const m = productMix(all, cat);
    expect(m.map((x) => [x.name, x.category, x.qty])).toEqual([["Kopi", "Drinks", 5], ["Toast", "Food", 3]]);
    expect(m[0]).toMatchObject({ averageCents: 200 });
    expect(m[0]!.share + m[1]!.share).toBeCloseTo(1);
  });
  it("filters by category, channel and weekday", () => {
    expect(productMix(all, cat, { category: "Food" }).map((x) => x.name)).toEqual(["Toast"]);
    expect(productMix(all, cat, { channel: "Dine-in" }).map((x) => x.name)).toEqual(["Kopi"]);
    expect(productMix(all, cat, { weekday: 1 }).map((x) => x.name)).toEqual(["Toast"]); // 16 Nov 2026 is a Monday
  });
});
