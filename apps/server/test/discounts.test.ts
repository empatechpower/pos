import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, orderTotals, reduceOrder } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

describe("discount rules and approvals", () => {
  const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let store: PgEventStore;
  let till = { token: "", id: "" };
  let tok: Record<string, string> = {};
  let ip = 0;
  let n = 0;

  const call = async (url: string, o: { body?: unknown; bearer?: string; method?: string } = {}) => {
    const res = await fetch(base + url, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, "x-device-token": till.token, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  };

  beforeAll(async () => {
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    store = new PgEventStore(db, "bp", "EV");
    app = await buildApp({ config, db, logger: false, store, catalog: cat, catalogAdmin: cat, trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const e = (await enroll(db, "bp", c.code, "Till"))!;
    till = { token: e.token, id: e.device.id };
    for (const [code, name, role, pin] of [["C1", "Cat Cashier", "cashier", "3333"], ["M1", "Max Manager", "manager", "222222"]] as const) {
      await createStaff(db, { merchantId: "bp", code, name, role, pin });
      tok[code] = (await call("/api/auth/login", { body: { code, pin } })).json.token;
    }
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  it("the shop keeps its own list of discount reasons: tidied, kept when the limits change, and cleared by an empty list", async () => {
    const put = (body: object) => call("/api/settings/discounts", { bearer: tok.M1, method: "PUT", body: { cashierMaxPercent: 10, cashierMaxAmountCents: 500, ...body } });
    const set = await put({ reasons: ["  Staff meal ", "Birthday", "birthday", "", "Other", "Opening week"] });
    expect(set.json.reasons).toEqual(["Staff meal", "Birthday", "Opening week"]); // blanks, repeats and "Other" (always offered) dropped
    expect((await call("/api/settings/discounts", { bearer: tok.C1 })).json.reasons).toEqual(["Staff meal", "Birthday", "Opening week"]);
    expect((await put({})).json.reasons).toEqual(["Staff meal", "Birthday", "Opening week"]); // changing the limits leaves the list alone
    expect((await put({ reasons: "anything" })).status).toBe(400);
    expect((await put({ reasons: [] })).json.reasons).toBeUndefined(); // back to the built-in list
  });

  it("starts with sensible limits a cashier may use alone, and only a manager changes them", async () => {
    expect((await call("/api/settings/discounts", { bearer: tok.C1 })).json).toEqual({ cashierMaxPercent: 10, cashierMaxAmountCents: 500, overrideNeedsManager: true });
    expect((await call("/api/settings/discounts", { bearer: tok.C1, method: "PUT", body: { cashierMaxPercent: 50, cashierMaxAmountCents: 0 } })).status).toBe(403);
    expect((await call("/api/settings/discounts", { bearer: tok.M1, method: "PUT", body: { cashierMaxPercent: 101, cashierMaxAmountCents: 0 } })).status).toBe(400);
    const set = await call("/api/settings/discounts", { bearer: tok.M1, method: "PUT", body: { cashierMaxPercent: 15, cashierMaxAmountCents: 300, overrideNeedsManager: true } });
    expect(set.json).toEqual({ cashierMaxPercent: 15, cashierMaxAmountCents: 300, overrideNeedsManager: true });
    expect((await call("/api/settings/discounts", { bearer: tok.C1 })).json.cashierMaxPercent).toBe(15);
  });

  it("a cashier gets a manager's approval by typing the manager's code and PIN; wrong or non-manager PINs are refused", async () => {
    expect((await call("/api/approvals", { bearer: tok.C1, body: {} })).json.error).toBe("manager_approval_needed");
    expect((await call("/api/approvals", { bearer: tok.C1, body: { approverCode: "M1", approverPin: "000000" } })).json.error).toBe("approval_refused");
    expect((await call("/api/approvals", { bearer: tok.C1, body: { approverCode: "C1", approverPin: "3333" } })).json.error).toBe("approver_cannot_approve");
    const ok = await call("/api/approvals", { bearer: tok.C1, body: { approverCode: "M1", approverPin: "222222", purpose: "discount" } });
    expect(ok.json).toMatchObject({ ok: true, approver: { name: "Max Manager" } });
    expect((await call("/api/approvals", { body: { approverCode: "M1", approverPin: "222222" } })).status).toBe(401);
  });

  it("discounts and price changes pushed from a till count in the order's total and are written to the audit log", async () => {
    const o = (await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 4 }], customerPhone: "9123 4567" } })).json;
    const line = reduceOrder(o.orderId, await store.eventsForOrder(o.orderId))!.lines[0]!.lineId;
    const push = (body: object) => call("/api/sync/push", { body: { events: [{ id: `dc${++n}`, orderId: o.orderId, deviceId: till.id, ts: Date.now() + n, seq: 7000 + n, ...body }] } });
    await push({ type: "DiscountApplied", discountId: "disc-1", scope: "line", lineId: line, kind: "percent", value: 10, reason: "Staff meal", byName: "Cat Cashier" });
    await push({ type: "LinePriceOverridden", lineId: line, unitCents: 150, reason: "Price match", byName: "Cat Cashier", approvedBy: "m", approvedByName: "Max Manager" });
    const s = reduceOrder(o.orderId, await store.eventsForOrder(o.orderId))!;
    expect(s.lines[0]).toMatchObject({ unitCents: 150, listUnitCents: 200 });
    // 4 x 1.50 = 6.00; 10% of the line = 0.60
    expect(orderTotals(s, config)).toMatchObject({ subtotal: 600, discountCents: 60 });
    const rows = (await db.query("SELECT action, detail FROM audit_log WHERE action IN ('order.discount','order.price_override') ORDER BY id")).rows;
    expect(rows.map((r) => r.action)).toEqual(["order.discount", "order.price_override"]);
    expect(rows[0].detail).toMatchObject({ reason: "Staff meal", by: "Cat Cashier", value: 10 });
    expect(rows[1].detail).toMatchObject({ reason: "Price match", approvedBy: "Max Manager", unitCents: 150 });
    // the order report carries the discount
    const rep = (await call(`/api/reports/orders`, { bearer: tok.M1 })).json;
    expect(rep.orders.find((x: any) => x.orderId === o.orderId)).toMatchObject({ discountCents: 60 });
  });
});
