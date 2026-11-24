import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

describe("who opened an order, and the order's whole story", () => {
  const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let till = { token: "", id: "" };
  let tok: Record<string, string> = {};
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
  const order = async () => (await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 2 }], customerPhone: "9123 4567" } })).json as { orderId: string; totalCents: number };

  beforeAll(async () => {
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const e = (await enroll(db, "bp", c.code, "Front till"))!;
    till = { token: e.token, id: e.device.id };
    for (const [code, name, role, pin] of [["C1", "Cat Cashier", "cashier", "3333"], ["M1", "Max Manager", "manager", "222222"]] as const) {
      await createStaff(db, { merchantId: "bp", code, name, role, pin });
      tok[code] = (await call("/api/auth/login", { body: { code, pin } })).json.token;
    }
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  it("every opening is written with who and when, even a look with no change; a redraw a moment later is not a second look", async () => {
    const o = await order();
    expect((await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.C1, body: { seenIn: "Online orders" } })).json).toEqual({ ok: true });
    expect((await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.C1, body: { seenIn: "Online orders" } })).json).toMatchObject({ repeated: true });
    // another place, or another person, is a new opening
    expect((await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.C1, body: { seenIn: "Refund panel" } })).json).toEqual({ ok: true });
    expect((await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.M1, body: { seenIn: "Online orders" } })).json).toEqual({ ok: true });
    const rows = (await db.query("SELECT staff_name, staff_role, seen_in FROM order_views WHERE order_id=$1 ORDER BY id", [o.orderId])).rows;
    expect(rows).toEqual([{ staff_name: "Cat Cashier", staff_role: "cashier", seen_in: "Online orders" }, { staff_name: "Cat Cashier", staff_role: "cashier", seen_in: "Refund panel" }, { staff_name: "Max Manager", staff_role: "manager", seen_in: "Online orders" }]);
  });

  it("an unknown order is not found and nobody unsigned can log a view", async () => {
    expect((await call("/api/orders/nope/viewed", { bearer: tok.C1, body: {} })).status).toBe(404);
    const o = await order();
    expect((await call(`/api/orders/${o.orderId}/viewed`, { body: {} })).status).toBe(401);
  });

  it("an opening reported late by an offline till keeps the time it really happened, within the last week", async () => {
    const o = await order();
    const earlier = Date.now() - 3 * 3_600_000;
    await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.C1, body: { seenIn: "Online orders", at: earlier } });
    await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.C1, body: { seenIn: "Old", at: Date.now() - 30 * 86_400_000 } }); // too old to believe: counted as now
    const rows = (await db.query("SELECT seen_in, extract(epoch from viewed_at)*1000 AS at FROM order_views WHERE order_id=$1 ORDER BY id", [o.orderId])).rows;
    expect(Math.abs(Number(rows[0].at) - earlier)).toBeLessThan(2000);
    expect(Date.now() - Number(rows[1].at)).toBeLessThan(5000);
  });

  it("a manager reads the order's whole story: what happened, who did it, and who opened it; a cashier cannot", async () => {
    const o = await order();
    const push = (body: object) => call("/api/sync/push", { body: { events: [{ id: `tr${++n}`, orderId: o.orderId, deviceId: till.id, ts: Date.now() + n, seq: 8000 + n, ...body }] } });
    await push({ type: "PaymentRecorded", paymentId: "tp1", method: "cash", amountCents: o.totalCents, confirmed: true });
    await push({ type: "OrderNoted", note: "Allergy: nuts", byName: "Cat Cashier" });
    await call(`/api/orders/${o.orderId}/viewed`, { bearer: tok.C1, body: { seenIn: "Online orders" } });
    await call(`/api/orders/${o.orderId}/refund`, { bearer: tok.M1, body: { paymentId: "tp1", amountCents: 100, reason: "Wrong item" } });
    expect((await call(`/api/orders/${o.orderId}/trail`, { bearer: tok.C1 })).status).toBe(403);
    const t = (await call(`/api/orders/${o.orderId}/trail`, { bearer: tok.M1 })).json.entries as Array<{ kind: string; text: string; who: string; at: number }>;
    const kinds = t.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["opened", "item", "payment", "note", "viewed", "refund"]));
    expect(t.find((e) => e.kind === "opened")).toMatchObject({ who: "Customer", text: "Order placed online" });
    expect(t.find((e) => e.kind === "payment")).toMatchObject({ who: "Front till" });
    expect(t.find((e) => e.kind === "viewed")).toMatchObject({ who: "Cat Cashier (cashier)", text: "Opened in Online orders" });
    expect(t.find((e) => e.kind === "refund")).toMatchObject({ who: "Max Manager (approved)", text: expect.stringContaining("Wrong item") });
    expect([...t].sort((a, b) => a.at - b.at)).toEqual(t);
    expect((await call("/api/orders/nope/trail", { bearer: tok.M1 })).status).toBe(404);
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='order.trail_read'")).rowCount).toBeGreaterThan(0);
  });
});
