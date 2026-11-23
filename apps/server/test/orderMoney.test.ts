import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, reduceOrder, confirmedPaid } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

describe("refunds and voids need a manager", () => {
  const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let store: PgEventStore;
  let till = { token: "", id: "" };
  let cashier = "";
  let manager = "";
  let ip = 0;
  let n = 0;

  const call = async (url: string, o: { body?: unknown; bearer?: string } = {}) => {
    const res = await fetch(base + url, {
      method: o.body !== undefined ? "POST" : "GET",
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, "x-device-token": till.token, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  };
  /** A shop order, paid in cash at the till. */
  const paidOrder = async (qty = 5) => {
    const o = (await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty }], customerPhone: "9123 4567" } })).json;
    const payId = `till-pay-${++n}`;
    await call("/api/sync/push", { body: { events: [{ id: `pay${n}`, orderId: o.orderId, deviceId: till.id, ts: Date.now() + n, seq: 5000 + n, type: "PaymentRecorded", paymentId: payId, method: "cash", amountCents: o.totalCents, confirmed: true }] } });
    return { ...o, payId } as { orderId: string; totalCents: number; payId: string };
  };
  const state = async (id: string) => reduceOrder(id, await store.eventsForOrder(id))!;

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
    await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat Cashier", role: "cashier", pin: "3333" });
    await createStaff(db, { merchantId: "bp", code: "M1", name: "Max Manager", role: "manager", pin: "222222" });
    cashier = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    manager = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  it("a cashier alone cannot refund; a wrong PIN, or a cashier's own PIN, is refused", async () => {
    const o = await paidOrder();
    const body = { paymentId: o.payId, amountCents: 100, reason: "Wrong item" };
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body })).json.error).toBe("manager_approval_needed");
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body: { ...body, approverCode: "M1", approverPin: "000000" } })).json.error).toBe("approval_refused");
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body: { ...body, approverCode: "C1", approverPin: "3333" } })).json.error).toBe("approver_cannot_approve");
    expect(confirmedPaid(await state(o.orderId))).toBe(o.totalCents);
  });

  it("a cashier with the manager's PIN refunds part of a payment; it is recorded with who approved and why", async () => {
    const o = await paidOrder();
    const r = await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body: { paymentId: o.payId, amountCents: 150, reason: "Wrong item", approverCode: "M1", approverPin: "222222" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, method: "cash", amountCents: 150, manual: true });
    const s = await state(o.orderId);
    expect(confirmedPaid(s)).toBe(o.totalCents - 150);
    expect(s.refunds).toEqual([expect.objectContaining({ amountCents: 150, reason: "Wrong item", approvedByName: "Max Manager" })]);
    const a = (await db.query("SELECT action, detail FROM audit_log WHERE action='order.refund' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(a.detail).toMatchObject({ orderId: o.orderId, amountCents: 150, reason: "Wrong item" });
  });

  it("needs a reason, cannot refund more than was paid, and the same refund sent twice counts once", async () => {
    const o = await paidOrder();
    const base = { paymentId: o.payId, reason: "Dropped", amountCents: 100 };
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: manager, body: { ...base, reason: "" } })).json.error).toBe("reason_required");
    const over = await call(`/api/orders/${o.orderId}/refund`, { bearer: manager, body: { ...base, amountCents: o.totalCents + 1 } });
    expect(over.status).toBe(400);
    expect(over.json).toMatchObject({ error: "amount_not_allowed", remainingCents: o.totalCents });
    const first = await call(`/api/orders/${o.orderId}/refund`, { bearer: manager, body: { ...base, refundId: "refund-key-0001" } });
    const again = await call(`/api/orders/${o.orderId}/refund`, { bearer: manager, body: { ...base, refundId: "refund-key-0001" } });
    expect(first.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, replayed: true });
    expect(confirmedPaid(await state(o.orderId))).toBe(o.totalCents - 100);
    // the rest of the payment can still go, but not more
    const rest = await call(`/api/orders/${o.orderId}/refund`, { bearer: manager, body: { ...base, amountCents: o.totalCents - 100 } });
    expect(rest.status).toBe(200);
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: manager, body: { ...base, amountCents: 1 } })).status).toBe(400);
  });

  it("voiding a paid order refunds every payment, closes it, and tells staff what to hand back", async () => {
    const o = await paidOrder(3);
    const r = await call(`/api/orders/${o.orderId}/void`, { bearer: cashier, body: { reason: "Customer left", approverCode: "M1", approverPin: "222222" } });
    expect(r.status).toBe(200);
    expect(r.json.manual).toEqual([{ method: "cash", amountCents: o.totalCents }]);
    const s = await state(o.orderId);
    expect(s.stage).toBe("cancelled");
    expect(s.voided).toMatchObject({ reason: "Customer left", approvedByName: "Max Manager" });
    expect(confirmedPaid(s)).toBe(0);
    expect((await call(`/api/orders/${o.orderId}/void`, { bearer: manager, body: { reason: "again" } })).json.error).toBe("already_voided");
  });

  it("an unpaid order can be voided too, and an unknown order is a plain not found", async () => {
    const o = (await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 1 }], customerPhone: "9123 4567" } })).json;
    expect((await call(`/api/orders/${o.orderId}/void`, { bearer: manager, body: { reason: "Walked out" } })).status).toBe(200);
    expect((await state(o.orderId)).voided).toBeDefined();
    expect((await call("/api/orders/nope/void", { bearer: manager, body: { reason: "x y z" } })).status).toBe(404);
    expect((await call(`/api/orders/${o.orderId}/void`, { body: { reason: "no sign-in" } })).status).toBe(401);
  });

  it("five wrong manager PINs lock that manager out", async () => {
    await createStaff(db, { merchantId: "bp", code: "M2", name: "Mia Manager", role: "manager", pin: "444444" });
    const o = await paidOrder();
    const body = { paymentId: o.payId, amountCents: 100, reason: "Test", approverCode: "M2", approverPin: "000000" };
    for (let i = 0; i < 4; i++) expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body })).json.error).toBe("approval_refused");
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body })).json.error).toBe("approver_locked");
    expect((await call(`/api/orders/${o.orderId}/refund`, { bearer: cashier, body: { ...body, approverPin: "444444" } })).json.error).toBe("approver_locked");
  });
});
