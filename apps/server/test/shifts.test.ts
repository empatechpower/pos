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

describe("shifts, floats and drawers", () => {
  const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
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
  const order = async (qty: number) => (await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty }], customerPhone: "9123 4567" } })).json as { orderId: string; totalCents: number };
  /** The till records a payment inside a shift (the shift id rides on the payment). */
  const pay = async (orderId: string, method: string, cents: number, shiftId: string) => {
    const id = ++n;
    await call("/api/sync/push", { body: { events: [{ id: `sp${id}`, orderId, deviceId: till.id, ts: Date.now() + id, seq: 9000 + id, type: "PaymentRecorded", paymentId: `shift-pay-${id}`, method, amountCents: cents, confirmed: true, shiftId }] } });
    return `shift-pay-${id}`;
  };

  beforeAll(async () => {
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const e = (await enroll(db, "bp", c.code, "Till"))!;
    till = { token: e.token, id: e.device.id };
    for (const [code, name, role, pin] of [["C1", "Cat Cashier", "cashier", "3333"], ["C2", "Cal Cashier", "cashier", "4444"], ["M1", "Max Manager", "manager", "222222"]] as const) {
      await createStaff(db, { merchantId: "bp", code, name, role, pin });
      tok[code] = (await call("/api/auth/login", { body: { code, pin } })).json.token;
    }
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  let c1: any, c2: any;

  it("a drawer is handed out, never chosen: two cashiers get drawers 1 and 2, a third finds none free", async () => {
    c1 = (await call("/api/shifts/open", { bearer: tok.C1, body: { openingFloatCents: 5000 } })).json.shift;
    c2 = (await call("/api/shifts/open", { bearer: tok.C2, body: { openingFloatCents: 3000 } })).json.shift;
    expect([c1.drawer, c2.drawer]).toEqual([1, 2]);
    expect(c1).toMatchObject({ staffName: "Cat Cashier", openingFloatCents: 5000, closedAt: null });
    expect((await call("/api/shifts/open", { bearer: tok.M1, body: { openingFloatCents: 0 } })).json.error).toBe("both_drawers_in_use");
    const again = await call("/api/shifts/open", { bearer: tok.C1, body: { openingFloatCents: 100 } });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("already_open");
    expect((await call("/api/shifts/mine", { bearer: tok.C1 })).json.shift.id).toBe(c1.id);
    expect((await call("/api/shifts/open", { bearer: tok.C2, body: { openingFloatCents: -5 } })).json.error).toBe("float_not_allowed");
  });

  it("cash is kept apart per shift, and the drawer figure follows float, sales, refunds, cash in and out", async () => {
    const a = await order(4), b = await order(2), x = await order(3);
    const cashA = await pay(a.orderId, "cash", a.totalCents, c1.id);
    await pay(b.orderId, "paynow", b.totalCents, c1.id);
    await pay(x.orderId, "cash", x.totalCents, c2.id);
    expect((await call(`/api/shifts/${c1.id}/cash`, { bearer: tok.C1, body: { kind: "out", amountCents: 100, reason: "Ice from the shop" } })).status).toBe(200);
    expect((await call(`/api/shifts/${c1.id}/cash`, { bearer: tok.C1, body: { kind: "in", amountCents: 50, reason: "Top up change" } })).status).toBe(200);
    expect((await call(`/api/shifts/${c1.id}/cash`, { bearer: tok.C1, body: { kind: "out", amountCents: 10, reason: "" } })).json.error).toBe("reason_required");

    let r = (await call(`/api/shifts/${c1.id}/report`, { bearer: tok.C1 })).json;
    expect(r.orders).toBe(2);
    expect(r.tenders).toEqual([{ method: "cash", salesCents: a.totalCents, refundsCents: 0, netCents: a.totalCents }, { method: "paynow", salesCents: b.totalCents, refundsCents: 0, netCents: b.totalCents }]);
    expect(r.expectedCashCents).toBe(5000 + a.totalCents - 100 + 50);
    const r2 = (await call(`/api/shifts/${c2.id}/report`, { bearer: tok.C2 })).json;
    expect(r2.expectedCashCents).toBe(3000 + x.totalCents);

    // Cash given back leaves the serving cashier's drawer.
    const rf = await call(`/api/orders/${a.orderId}/refund`, { bearer: tok.C1, body: { paymentId: cashA, amountCents: 150, reason: "Wrong item", approverCode: "M1", approverPin: "222222" } });
    expect(rf.status).toBe(200);
    r = (await call(`/api/shifts/${c1.id}/report`, { bearer: tok.C1 })).json;
    expect(r.tenders[0]).toMatchObject({ method: "cash", refundsCents: 150, netCents: a.totalCents - 150 });
    expect(r.expectedCashCents).toBe(5000 + a.totalCents - 150 - 100 + 50);
    (c1 as any).expected = r.expectedCashCents;
  });

  it("only the owner of a shift or a manager sees or changes it", async () => {
    expect((await call(`/api/shifts/${c1.id}/report`, { bearer: tok.C2 })).status).toBe(403);
    expect((await call(`/api/shifts/${c1.id}/cash`, { bearer: tok.C2, body: { kind: "in", amountCents: 1, reason: "sneaky" } })).status).toBe(403);
    expect((await call(`/api/shifts/${c1.id}/report`, { bearer: tok.M1 })).status).toBe(200);
    expect((await call("/api/shifts", { bearer: tok.C1 })).status).toBe(403);
    const list = (await call("/api/shifts", { bearer: tok.M1 })).json.shifts;
    expect(list.filter((s: any) => !s.closedAt).map((s: any) => s.drawer).sort()).toEqual([1, 2]);
  });

  it("closing counts the drawer against what it should hold, keeps the difference, and frees the drawer", async () => {
    expect((await call(`/api/shifts/${c1.id}/close`, { bearer: tok.C1, body: {} })).json.error).toBe("counted_cash_required");
    const exp = (c1 as any).expected as number;
    const close = await call(`/api/shifts/${c1.id}/close`, { bearer: tok.C1, body: { countedCents: exp - 200, note: "Gave a wrong change" } });
    expect(close.status).toBe(200);
    expect(close.json.report.shift).toMatchObject({ expectedCents: exp, countedCents: exp - 200, varianceCents: -200, closedByName: "Cat Cashier" });
    expect((await call(`/api/shifts/${c1.id}/close`, { bearer: tok.C1, body: { countedCents: exp } })).json.error).toBe("already_closed");
    expect((await call(`/api/shifts/${c1.id}/cash`, { bearer: tok.C1, body: { kind: "in", amountCents: 1, reason: "too late" } })).json.error).toBe("shift_closed");
    // drawer 1 is free again: the manager takes it
    const m = (await call("/api/shifts/open", { bearer: tok.M1, body: { openingFloatCents: 0 } })).json.shift;
    expect(m.drawer).toBe(1);
    // a manager can close someone else's forgotten shift
    const forced = await call(`/api/shifts/${c2.id}/close`, { bearer: tok.M1, body: { countedCents: 3000 } });
    expect(forced.status).toBe(200);
    expect((await db.query("SELECT detail FROM audit_log WHERE action='shift.close' ORDER BY id DESC LIMIT 1")).rows[0].detail.forcedBy).toBe("Max Manager");
  });

  it("whether a shift is required before selling is the shop's setting", async () => {
    expect((await call("/api/settings/shifts", { bearer: tok.C1 })).json).toEqual({ required: false });
    expect((await call("/api/settings/shifts", { bearer: tok.C1, method: "PUT", body: { required: true } })).status).toBe(403);
    expect((await call("/api/settings/shifts", { bearer: tok.M1, method: "PUT", body: { required: true } })).json).toEqual({ required: true });
    expect((await call("/api/settings/shifts", { bearer: tok.C1 })).json).toEqual({ required: true });
  });
});
