import { describe, expect, it } from "vitest";
import { PRESETS, orderTotals, contrastRatio, isHexColor, newId, quoteOrder, readableOn, reduceOrder, shopStatus, visibleToKitchen, type Catalog, type OrderEvent } from "../src/index.js";

const catalog = (): Catalog => ({
  version: 1,
  defaultPricebookId: "std",
  products: [
    { id: "kaya", name: "Kaya Toast", category: "Toast" },
    { id: "kopi", name: "Coffee", category: "Drinks" },
    { id: "gone", name: "Barley", category: "Drinks", soldOut: true },
    { id: "beer", name: "Beer", category: "Bar", pointsExempt: true },
  ],
  pricebooks: [
    { id: "std", name: "Standard", missing: "show", prices: { kaya: 200, kopi: 220, gone: 200, beer: 900 } },
    { id: "grab", name: "Grab", missing: "show", prices: { kaya: 230 } },
  ],
  channels: [
    { id: "dine", name: "Dine in", kind: "dine_in", serviceCharge: true, active: true },
    { id: "take", name: "Take away", kind: "takeaway", serviceCharge: false, active: true },
    { id: "grab", name: "Grab", kind: "delivery", serviceCharge: false, active: true },
    { id: "off", name: "Closed channel", kind: "other", serviceCharge: false, active: false },
  ],
  assignments: [{ pricebookId: "grab", channelId: "grab" }],
});
const config = PRESETS.fastServe("b", "B", "O");
const ctx = (channelId: string) => ({ outletId: "O", channelId });

describe("quoteOrder", () => {
  it("prices from the catalog for the channel, with the channel's service charge", () => {
    const dine = quoteOrder(catalog(), config, ctx("dine"), [{ productId: "kaya", qty: 2 }, { productId: "kopi", qty: 1 }]);
    expect(dine.ok && dine.priced.subtotal).toBe(620);
    expect(dine.ok && dine.priced.service).toBe(56); // 9% of 620, rounded
    expect(dine.ok && dine.priced.total).toBe(676);
    const grab = quoteOrder(catalog(), config, ctx("grab"), [{ productId: "kaya", qty: 2 }]);
    expect(grab.ok && grab.priced.total).toBe(460); // Grab price 230, no service
  });

  it("merges repeated lines and ignores any attempt to supply a price", () => {
    const q = quoteOrder(catalog(), config, ctx("take"), [{ productId: "kaya", qty: 1 }, { productId: "kaya", qty: 2, unitCents: 1 } as never]);
    expect(q.ok && q.lines).toEqual([{ productId: "kaya", name: "Kaya Toast", unitCents: 200, qty: 3, pointsExempt: undefined, options: [] }]);
  });

  it("refuses sold-out items, unknown items and items a channel does not sell", () => {
    expect(quoteOrder(catalog(), config, ctx("take"), [{ productId: "gone", qty: 1 }])).toEqual({ ok: false, error: "unavailable", productId: "gone" });
    expect(quoteOrder(catalog(), config, ctx("take"), [{ productId: "nope", qty: 1 }])).toEqual({ ok: false, error: "unavailable", productId: "nope" });
    const c = catalog();
    c.pricebooks[1]!.missing = "hide";
    expect(quoteOrder(c, config, ctx("grab"), [{ productId: "kopi", qty: 1 }]).ok).toBe(false);
  });

  it("refuses bad quantities, empty orders, oversized orders and unknown or closed channels", () => {
    const bad = (qty: number) => quoteOrder(catalog(), config, ctx("take"), [{ productId: "kaya", qty }]);
    for (const q of [0, -1, 1.5, 21, NaN]) expect(bad(q)).toMatchObject({ ok: false, error: "bad_quantity" });
    expect(quoteOrder(catalog(), config, ctx("take"), [])).toEqual({ ok: false, error: "empty" });
    expect(quoteOrder(catalog(), config, ctx("take"), Array.from({ length: 31 }, () => ({ productId: "kaya", qty: 1 })))).toEqual({ ok: false, error: "too_many_items" });
    expect(quoteOrder(catalog(), config, ctx("nope"), [{ productId: "kaya", qty: 1 }])).toEqual({ ok: false, error: "unknown_channel" });
    expect(quoteOrder(catalog(), config, ctx("off"), [{ productId: "kaya", qty: 1 }])).toEqual({ ok: false, error: "channel_off" });
  });

  it("merged quantity for one product is also capped", () => {
    expect(quoteOrder(catalog(), config, ctx("take"), [{ productId: "kaya", qty: 15 }, { productId: "kaya", qty: 15 }])).toMatchObject({ ok: false, error: "bad_quantity" });
  });
});

describe("online orders", () => {
  const events = (extra: object[] = [], opened: object = {}): OrderEvent[] => {
    const orderId = newId();
    const base = { orderId, deviceId: "shop" };
    return [
      { ...base, id: "e1", ts: 1, seq: 1, type: "OrderOpened", fulfilment: "takeaway", source: "online", customerName: "Sam", customerPhone: "91234567", queueNumber: "W001", ...opened },
      { ...base, id: "e2", ts: 2, seq: 2, type: "ItemAdded", lineId: "l1", productId: "kaya", name: "Kaya Toast", unitCents: 200, qty: 1 },
      ...extra.map((x, i) => ({ ...base, id: `x${i}`, ts: 10 + i, seq: 10 + i, ...x })),
    ] as OrderEvent[];
  };
  const reduce = (ev: OrderEvent[]) => reduceOrder(ev[0]!.orderId, ev)!;
  const postpay = PRESETS.restaurant("b", "B", "O");

  it("is hidden from the kitchen until staff accept it, in any payment mode", () => {
    const o = reduce(events());
    expect(visibleToKitchen(o, postpay)).toBe(false);
    expect(visibleToKitchen(reduce(events([{ type: "OrderAccepted" }])), postpay)).toBe(true);
  });

  it("in fast serve it also needs paying after acceptance", () => {
    const accepted = reduce(events([{ type: "OrderAccepted" }]));
    expect(visibleToKitchen(accepted, config)).toBe(false);
    const paid = reduce(events([{ type: "OrderAccepted" }, { type: "PaymentRecorded", paymentId: "p", method: "cash", amountCents: 200, confirmed: true }]));
    expect(visibleToKitchen(paid, config)).toBe(true);
  });

  it("POS orders are unaffected: no acceptance needed", () => {
    const o = reduce(events([], { source: undefined }));
    expect(o.source).toBe("pos");
    expect(visibleToKitchen(o, postpay)).toBe(true);
  });

  it("accepting twice, or before the order exists, changes nothing harmful", () => {
    const o = reduce(events([{ type: "OrderAccepted" }, { type: "OrderAccepted" }]));
    expect(o.acceptedAt).toBe(10);
  });

  it("tells the customer a plain status as the order moves along", () => {
    const status = (extra: object[], cfg = config) => shopStatus(reduce(events(extra)), cfg);
    expect(status([])).toBe("received");
    expect(status([{ type: "OrderAccepted" }])).toBe("awaiting_payment");
    const paid = { type: "PaymentRecorded", paymentId: "p", method: "cash", amountCents: 200, confirmed: true };
    expect(status([{ type: "OrderAccepted" }, paid])).toBe("queued");
    expect(status([{ type: "OrderAccepted" }, paid, { type: "StageSet", stage: "preparing" }])).toBe("preparing");
    expect(status([{ type: "OrderAccepted" }, paid, { type: "StageSet", stage: "ready" }])).toBe("ready");
    expect(status([{ type: "OrderAccepted" }, paid, { type: "StageSet", stage: "completed" }])).toBe("completed");
    expect(status([{ type: "StageSet", stage: "cancelled" }])).toBe("cancelled");
    expect(status([{ type: "OrderAccepted" }], postpay)).toBe("queued"); // restaurant: no pay-first
  });
});

describe("brand colours", () => {
  it("accepts only 6-digit hex colours", () => {
    for (const ok of ["#ea7016", "#FFFFFF", "#000000"]) expect(isHexColor(ok)).toBe(true);
    for (const bad of ["red", "#fff", "ea7016", "#ea7016;background:url(x)", "#gggggg", "", null, 5]) expect(isHexColor(bad)).toBe(false);
  });

  it("picks readable text for any background", () => {
    expect(readableOn("#ffffff")).toBe("#21252a");
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#ffe000")).toBe("#21252a"); // bright yellow needs dark text
    expect(readableOn("#1a237e")).toBe("#ffffff"); // deep blue needs white
    expect(readableOn("#e1523e")).toBe("#ffffff"); // the prototype's red keeps white text (3.8:1, fine for bold buttons)
    expect(readableOn("#ea7016")).toBe("#ffffff"); // and its orange
    expect(readableOn("#00acc1")).toBe("#21252a"); // a light teal does not reach 3:1 with white
    for (const bg of ["#ea7016", "#e1523e", "#2e9d5b", "#7b1fa2", "#fdd835", "#00acc1"]) expect(contrastRatio(bg, readableOn(bg))).toBeGreaterThan(3);
  });

  it("contrast ratio is 21 for black on white and 1 for the same colour", () => {
    expect(Math.round(contrastRatio("#000000", "#ffffff"))).toBe(21);
    expect(contrastRatio("#abcdef", "#abcdef")).toBe(1);
  });
});

describe("points on a quote and on an order", () => {
  it("a quote with points lowers the total by what is usable, at 1 point = 1 cent", () => {
    const q = quoteOrder(catalog(), config, ctx("take"), [{ productId: "kaya", qty: 5 }], { balance: 500, requested: null });
    expect(q.ok && q.priced.pointsUsed).toBeGreaterThan(0);
  });

  it("a PointsRedeemed event lowers what the order owes, and counts once", () => {
    const base = { orderId: "o1", deviceId: "d", ts: 1 };
    const ev = (n: number, body: object) => ({ id: `e${n}`, seq: n, ...base, ...body }) as any;
    const state = reduceOrder("o1", [
      ev(1, { type: "OrderOpened", fulfilment: "takeaway", serviceCharge: false }),
      ev(2, { type: "ItemAdded", lineId: "l", productId: "kaya", name: "Kaya", unitCents: 1000, qty: 1 }),
      ev(3, { type: "PointsRedeemed", points: 300 }),
      ev(4, { type: "PointsRedeemed", points: 900 }),
    ])!;
    expect(state.pointsRedeemed).toBe(300);
    expect(orderTotals(state, config).total).toBe(700);
  });
});
