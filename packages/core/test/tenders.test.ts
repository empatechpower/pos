import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/config.js";
import { reduceOrder, type OrderEvent } from "../src/events.js";
import { receipt } from "../src/print/templates.js";
import { plainText } from "../src/print/plain.js";
import { staffSales, summarize } from "../src/reports.js";
import { RECORDED_TENDERS, paymentKey, paymentLabel, recordedTender } from "../src/tenders.js";

let n = 0;
const ev = (orderId: string, body: object) => ({ id: `t-${++n}`, orderId, deviceId: "t", ts: 1_800_000_000_000 + n, seq: n, ...body }) as unknown as OrderEvent;
const config = PRESETS.fastServe("m", "Shop", "Outlet");
const sale = (id: string, pay: object) => reduceOrder(id, [
  ev(id, { type: "OrderOpened", fulfilment: "takeaway" }),
  ev(id, { type: "ItemAdded", lineId: "l1", productId: "p", name: "Tea", unitCents: 500, qty: 1 }),
  ev(id, { type: "PaymentRecorded", paymentId: `${id}-p`, amountCents: 500, confirmed: true, byName: "Cat", ...pay }),
])!;

describe("recorded tenders", () => {
  it("the five the handout names, each filed under a money kind the books know", () => {
    expect(RECORDED_TENDERS.map((t) => t.label)).toEqual(["Card", "Debit", "Manual Card", "Check", "Gift Card"]);
    expect(recordedTender("debit")?.method).toBe("card");
    expect(recordedTender("check")?.method).toBe("other");
    expect(RECORDED_TENDERS.filter((t) => !t.optional).map((t) => t.id)).toEqual(["card"]); // only Card shows until a manager adds the rest
  });
  it("a payment keeps its tender; an unknown tender is dropped and the money kind stands", () => {
    expect(sale("a", { method: "card", tender: "debit" }).payments[0]).toMatchObject({ method: "card", tender: "debit" });
    expect(sale("b", { method: "card", tender: "bitcoin" }).payments[0]!.tender).toBeUndefined();
    expect(paymentKey({ method: "card", tender: "bitcoin" })).toBe("card");
    expect(paymentLabel("giftcard")).toBe("Gift Card");
    expect(paymentLabel("cash")).toBe("Cash");
  });
  it("reports list each tender on its own row, and by staff", () => {
    const orders = [sale("c", { method: "card", tender: "debit" }), sale("d", { method: "card", tender: "card" }), sale("e", { method: "other", tender: "check" }), sale("f", { method: "cash" }), sale("g", { method: "card", tender: "debit" })];
    const s = summarize(orders, config);
    expect(Object.fromEntries(s.payments.map((p) => [p.method, p.cents]))).toEqual({ debit: 1000, card: 500, check: 500, cash: 500 });
    expect(staffSales(orders, config)[0]!.byMethod).toEqual({ debit: 1000, card: 500, check: 500, cash: 500 });
  });
  it("the receipt names the tender", () => {
    const text = plainText(receipt(sale("h", { method: "other", tender: "giftcard" }), config, { merchantName: "Shop", outletName: "Outlet", now: 1_800_000_000_000 }), 42).join("\n");
    expect(text).toMatch(/Gift Card\s+S?\$5\.00/);
    expect(text).not.toContain("Other");
  });
});

describe("the shop's own tenders", () => {
  it("a delivery platform payment keeps the name it was taken under, on the order, the receipt and the report", async () => {
    const { customTenderName } = await import("../src/tenders.js");
    const o = sale("x", { method: "other", tender: "ct-grab", tenderName: "GrabFood" });
    expect(o.payments[0]).toMatchObject({ method: "other", tender: "ct-grab", tenderName: "GrabFood" });
    expect(customTenderName(o.payments[0]!)).toBe("GrabFood");
    const s = summarize([o, sale("y", { method: "other", tender: "ct-grab", tenderName: "GrabFood" }), sale("z", { method: "cash" })], config);
    expect(Object.fromEntries(s.payments.map((p) => [paymentLabel(p.method), p.cents]))).toEqual({ GrabFood: 1000, Cash: 500 });
    const text = plainText(receipt(o, config, { merchantName: "Shop", outletName: "Outlet", now: 1_800_000_000_000 }), 42).join("\n");
    expect(text).toMatch(/GrabFood\s+S?\$5\.00/);
  });
  it("a name without a proper custom id, or an id without a name, is not kept", () => {
    expect(sale("a2", { method: "other", tender: "ct-grab" }).payments[0]!.tender).toBeUndefined();
    expect(sale("b2", { method: "other", tender: "grab", tenderName: "GrabFood" }).payments[0]!.tenderName).toBeUndefined();
    expect(paymentKey({ method: "other", tender: "grab", tenderName: "GrabFood" })).toBe("other");
  });
});
