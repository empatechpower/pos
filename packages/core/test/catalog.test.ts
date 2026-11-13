import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, blockedFor, fulfilmentOf, menuFor, newId, orderTotals, pricebookChain, reduceOrder, resolvePrice, validateCatalog, PRESETS, type Catalog, type OrderEvent } from "../src/index.js";

/** The McDonald's example from the client: same cone, S$1.70 at Regal, S$2.20 at LIDO. */
const catalog = (): Catalog => ({
  version: 1,
  defaultPricebookId: "std",
  products: [
    { id: "cone", name: "Hershey's Cone", category: "Dessert" },
    { id: "burger", name: "Burger", category: "Mains" },
    { id: "shake", name: "Shake", category: "Drinks" },
  ],
  pricebooks: [
    { id: "std", name: "Standard", missing: "show", prices: { cone: 170, burger: 500, shake: 300 } },
    { id: "lido", name: "LIDO", missing: "show", prices: { cone: 220 } },
    { id: "grab", name: "Grab", missing: "show", prices: { cone: 250, burger: 650 } },
    { id: "event", name: "Movie event", missing: "hide", prices: { cone: 100 } },
  ],
  channels: [
    { id: "dine", name: "Dine in", kind: "dine_in", serviceCharge: true, active: true },
    { id: "take", name: "Take away", kind: "takeaway", serviceCharge: false, active: true },
    { id: "grab", name: "Grab", kind: "delivery", serviceCharge: false, active: true },
    { id: "movie", name: "Movie Event", kind: "other", serviceCharge: false, active: true },
  ],
  assignments: [
    { pricebookId: "lido", outletId: "LIDO" },
    { pricebookId: "grab", channelId: "grab" },
    { pricebookId: "event", channelId: "movie" },
  ],
});

const price = (c: Catalog, product: string, outletId: string, channelId: string) => resolvePrice(c, product, { outletId, channelId })?.priceCents ?? null;

describe("resolvePrice", () => {
  it("the same item costs S$1.70 at Regal and S$2.20 at LIDO", () => {
    const c = catalog();
    expect(price(c, "cone", "Regal", "take")).toBe(170);
    expect(price(c, "cone", "LIDO", "take")).toBe(220);
  });

  it("an item missing from the winning pricebook is not sold: no fallback to another book (A-1)", () => {
    expect(price(catalog(), "burger", "LIDO", "take")).toBeNull();
    expect(price(catalog(), "cone", "LIDO", "take")).toBe(220);
  });

  it("blockedFor lists unpriced items only when the book says show", () => {
    const c = catalog();
    expect(blockedFor(c, { outletId: "LIDO", channelId: "take" }).map((p) => p.id).sort()).toEqual(["burger", "shake"]);
    expect(blockedFor(c, { outletId: "Regal", channelId: "movie" })).toEqual([]); // movie is set to hide
  });

  it("a channel pricebook applies at every outlet", () => {
    const c = catalog();
    expect(price(c, "burger", "Regal", "grab")).toBe(650);
    expect(price(c, "burger", "LIDO", "grab")).toBe(650);
    expect(price(c, "shake", "Regal", "grab")).toBeNull(); // grab has no shake price
  });

  it("channel beats outlet when only one is set", () => {
    // LIDO prices the cone at 220, but Grab (channel) says 250 everywhere
    expect(price(catalog(), "cone", "LIDO", "grab")).toBe(250);
  });

  it("outlet + channel together beat channel alone and outlet alone", () => {
    const c = catalog();
    c.pricebooks.push({ id: "lido-grab", name: "LIDO Grab", missing: "show", prices: { cone: 275 } });
    c.assignments.push({ pricebookId: "lido-grab", outletId: "LIDO", channelId: "grab" });
    expect(price(c, "cone", "LIDO", "grab")).toBe(275);
    expect(price(c, "cone", "Regal", "grab")).toBe(250); // other outlets unaffected
  });

  it("a pricebook set to hide removes products it does not price (not sold in that channel)", () => {
    const c = catalog();
    expect(price(c, "cone", "Regal", "movie")).toBe(100);
    expect(price(c, "burger", "Regal", "movie")).toBeNull();
    expect(menuFor(c, { outletId: "Regal", channelId: "movie" }).map((m) => m.id)).toEqual(["cone"]);
  });

  it("changing the default pricebook changes what unassigned contexts pay", () => {
    const c = catalog();
    c.defaultPricebookId = "grab";
    expect(price(c, "burger", "Regal", "take")).toBe(650);
  });

  it("a price of 0 is a real price, not a missing one", () => {
    const c = catalog();
    c.pricebooks[0]!.prices.shake = 0;
    expect(price(c, "shake", "Regal", "take")).toBe(0);
  });

  it("unknown products and unknown contexts do not throw", () => {
    const c = catalog();
    expect(price(c, "nope", "Regal", "take")).toBeNull();
    expect(price(c, "cone", "Nowhere", "no-such-channel")).toBe(170);
  });

  it("the chain lists most specific first, once each", () => {
    const c = catalog();
    expect(pricebookChain(c, { outletId: "LIDO", channelId: "grab" }).map((b) => b.id)).toEqual(["grab", "lido", "std"]);
    expect(pricebookChain(c, { outletId: "Regal", channelId: "take" }).map((b) => b.id)).toEqual(["std"]);
  });
});

describe("menuFor", () => {
  it("lists the whole menu with the context's prices", () => {
    const m = menuFor(catalog(), { outletId: "LIDO", channelId: "take" });
    expect(Object.fromEntries(m.map((x) => [x.id, x.priceCents]))).toEqual({ cone: 220 });
  });
});

describe("validateCatalog", () => {
  it("accepts a good catalog", () => expect(validateCatalog(catalog())).toEqual([]));

  it("rejects broken references and bad prices", () => {
    const c = catalog();
    c.defaultPricebookId = "ghost";
    c.assignments.push({ pricebookId: "ghost", channelId: "take" }, { pricebookId: "std" });
    c.pricebooks[0]!.prices.cone = -5;
    c.pricebooks[0]!.prices.burger = 4.5;
    c.pricebooks[0]!.prices.unknown = 100;
    expect(validateCatalog(c).length).toBeGreaterThanOrEqual(6);
  });

});

describe("channels on orders", () => {
  const reduce = (events: OrderEvent[]) => reduceOrder(events[0]!.orderId, events)!;
  const open = (extra: Partial<Extract<OrderEvent, { type: "OrderOpened" }>>): OrderEvent[] => {
    const orderId = newId();
    const base = { orderId, deviceId: "A", ts: 1, seq: 1 };
    return [
      { ...base, id: "e1", type: "OrderOpened", fulfilment: "takeaway", ...extra } as OrderEvent,
      { ...base, id: "e2", seq: 2, ts: 2, type: "ItemAdded", lineId: "l1", productId: "burger", name: "Burger", unitCents: 1000, qty: 1 } as OrderEvent,
    ];
  };
  const config = PRESETS.fastServe("b", "B", "O");

  it("a channel can switch the service charge on regardless of fulfilment", () => {
    const order = reduce(open({ channelId: "movie", channelName: "Movie Event", serviceCharge: true }));
    expect(order.channelName).toBe("Movie Event");
    expect(orderTotals(order, config).service).toBe(80);
  });

  it("a channel can switch it off even for dine-in", () => {
    const order = reduce(open({ fulfilment: "dine_in", channelId: "x", serviceCharge: false }));
    expect(orderTotals(order, config).service).toBe(0);
  });

  it("orders from before channels still follow the old dine-in rule", () => {
    const dine = reduce(open({ fulfilment: "dine_in" }));
    const take = reduce(open({ fulfilment: "takeaway" }));
    expect(orderTotals(dine, config).service).toBe(80);
    expect(orderTotals(take, config).service).toBe(0);
    expect(DEFAULT_PRICING.serviceRate).toBe(0.08);
  });

  it("other channels are recorded as take-away for older screens", () => {
    expect(fulfilmentOf("other")).toBe("takeaway");
    expect(fulfilmentOf("dine_in")).toBe("dine_in");
  });
});
