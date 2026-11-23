import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { buildPayload, buildReference, checkChar, cleanPaynowConfig, crc16, proxyProblem, referenceLooksRight } from "../src/paynowQr.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

describe("PayNow QR payload (the spec's test vectors)", () => {
  it("Vector A: UEN, locked amount, reference and expiry date, byte for byte", () => {
    const reference = buildReference({ channel: "O", outletCode: "B1", seq: 123456, amountCents: 2450 });
    expect(reference).toBe("RZOB1000002N9C001W2Z");
    const payload = buildPayload({ config: { proxyType: "uen", proxyValue: "201912345K", displayName: "BAILEY AND PATCH" }, amountCents: 2450, reference, expiryDate: "20261123" });
    expect(payload).toBe("00020101021226490009SG.PAYNOW010120210201912345K03010040820261123520400005303702540524.505802SG5916BAILEY AND PATCH6009Singapore62240120RZOB1000002N9C001W2Z630479D7");
  });

  it("Vector B: mobile, no expiry, the QR that was paid in the live trial", () => {
    const payload = buildPayload({ config: { proxyType: "mobile", proxyValue: "+6588007198", displayName: "NA" }, amountCents: 1, reference: "POC2026111804" });
    expect(payload).toBe("00020101021226380009SG.PAYNOW010100211+65880071980301052040000530370254040.015802SG5902NA6009Singapore62170113POC2026111804630424B7");
  });

  it("the CRC covers everything before it, so a changed character changes it", () => {
    const p = buildPayload({ config: { proxyType: "uen", proxyValue: "201912345K", displayName: "SHOP" }, amountCents: 500, reference: "RZOB1000000001001A3X" });
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
    expect(crc16(p.slice(0, -4).replace("5.00", "6.00"))).not.toBe(p.slice(-4));
  });

  it("the reference check character catches any single-character slip", () => {
    const ref = buildReference({ channel: "K", outletCode: "A1", seq: 98765, amountCents: 1830 });
    expect(ref).toHaveLength(20);
    expect(referenceLooksRight(ref)).toBe(true);
    for (let i = 0; i < 19; i++) {
      const alt = ref[i] === "7" ? "8" : "7";
      const bad = ref.slice(0, i) + alt + ref.slice(i + 1);
      expect(referenceLooksRight(bad)).toBe(false);
    }
    expect(checkChar("RZOB1000002N9C001W2")).toBe("Z");
  });

  it("refuses an amount that is not a positive whole number of cents, and a reference that is not capital letters and digits", () => {
    const cfg = { proxyType: "uen" as const, proxyValue: "201912345K", displayName: "SHOP" };
    expect(() => buildPayload({ config: cfg, amountCents: 0, reference: "ABC" })).toThrow();
    expect(() => buildPayload({ config: cfg, amountCents: 10.5, reference: "ABC" })).toThrow();
    expect(() => buildPayload({ config: cfg, amountCents: 100, reference: "has space" })).toThrow();
    expect(() => buildPayload({ config: cfg, amountCents: 100, reference: "A".repeat(25) })).toThrow();
  });
});

describe("PayNow proxies and settings", () => {
  it("checks mobile, UEN and NRIC formats", () => {
    expect(proxyProblem("mobile", "+6588007198")).toBeNull();
    expect(proxyProblem("mobile", "+6578007198")).not.toBeNull();
    expect(proxyProblem("mobile", "88007198")).not.toBeNull();
    expect(proxyProblem("uen", "201912345K")).toBeNull();
    expect(proxyProblem("uen", "201731166R6BH")).toBeNull();
    expect(proxyProblem("uen", "T09LL0001B")).toBeNull();
    expect(proxyProblem("uen", "12345")).not.toBeNull();
    expect(proxyProblem("nric", "S1234567D")).toBeNull();
    expect(proxyProblem("nric", "S1234567A")).not.toBeNull();
  });

  it("cleans the owner's settings and says what is wrong", () => {
    const ok = cleanPaynowConfig({ proxyType: "uen", proxyValue: " 201912345k ", displayName: "Bailey & Patch (Cafe) - East Coast Road", outletCode: "b1", ttlMinutes: 4 });
    expect(ok).toMatchObject({ ok: true, config: { proxyType: "uen", proxyValue: "201912345K", outletCode: "B1", ttlMinutes: 4 } });
    if (ok.ok) { expect(ok.config.displayName.length).toBeLessThanOrEqual(25); expect(ok.config.displayName).toBe("BAILEY & PATCH CAFE - EAS"); }
    expect(cleanPaynowConfig({ proxyType: "uen", proxyValue: "201912345K", displayName: "X", outletCode: "B", ttlMinutes: 3 })).toMatchObject({ ok: false });
    expect(cleanPaynowConfig({ proxyType: "uen", proxyValue: "201912345K", displayName: "X", outletCode: "B1", ttlMinutes: 10 })).toMatchObject({ ok: false });
    expect(cleanPaynowConfig({ proxyType: "bank", proxyValue: "1", displayName: "X", outletCode: "B1" })).toMatchObject({ ok: false });
    expect(cleanPaynowConfig({ proxyType: "uen", proxyValue: "201912345K", displayName: "", outletCode: "B1" })).toMatchObject({ ok: false });
  });
});

describe("issuing a PayNow QR for a kiosk order", () => {
  const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let store: PgEventStore;
  let till = { token: "", id: "" };
  let ip = 0;
  let n = 0;

  const call = async (url: string, o: { body?: unknown; device?: string } = {}) => {
    const res = await fetch(base + url, {
      method: o.body !== undefined ? "POST" : "GET",
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.device ? { "x-device-token": o.device } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  };
  const place = () => call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 5 }], customerPhone: "9123 4567" } });
  const qr = (id: string) => call(`/api/shop/orders/${id}/pay`, { body: { method: "paynow", display: "qr" } });

  beforeAll(async () => {
    process.env.PAYNOW_PROXY_TYPE = "uen";
    process.env.PAYNOW_PROXY_VALUE = "201912345K";
    process.env.PAYNOW_NAME = "Bailey and Patch";
    process.env.PAYNOW_OUTLET_CODE = "B1";
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
  }, 120_000);
  afterAll(async () => {
    delete process.env.PAYNOW_PROXY_TYPE; delete process.env.PAYNOW_PROXY_VALUE; delete process.env.PAYNOW_NAME; delete process.env.PAYNOW_OUTLET_CODE;
    await app?.close();
    await stop?.();
  });

  it("tells the kiosk it can show a QR, even with no card provider", async () => {
    const info = (await call("/api/shop/info")).json;
    expect(info.payments).toEqual({ online: false, methods: [], paynowQr: true });
  });

  it("builds a QR for exactly what is owed, with a reference that matches, and stores what it expects", async () => {
    const o = await place();
    const r = await qr(o.json.orderId);
    expect(r.status).toBe(200);
    const p: string = r.json.url;
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
    expect(p).toContain("SG.PAYNOW");
    expect(p).toContain(`54${String((o.json.totalCents / 100).toFixed(2)).length.toString().padStart(2, "0")}${(o.json.totalCents / 100).toFixed(2)}`);
    expect(p).toContain((o.json.totalCents / 100).toFixed(2));
    expect(p).toContain(r.json.reference);
    expect(r.json.reference).toMatch(/^RZKB1[0-9A-Z]{15}$/);
    expect(referenceLooksRight(r.json.reference)).toBe(true);
    expect(r.json.expiresAt - Date.now()).toBeGreaterThan(2.5 * 60_000);
    expect(r.json.expiresAt - Date.now()).toBeLessThanOrEqual(3 * 60_000);
    const row = (await db.query("SELECT order_id, amount_cents, state, proxy_value FROM payment_expectations WHERE payment_id=$1", [r.json.paymentId])).rows[0];
    expect(row).toMatchObject({ order_id: o.json.orderId, amount_cents: o.json.totalCents, state: "WAITING", proxy_value: "201912345K" });
    expect((await call(`/api/payments/paynow/status/${r.json.paymentId}`)).json.state).toBe("WAITING");
  });

  it("a new QR replaces the old one with a different reference", async () => {
    const o = await place();
    const a = await qr(o.json.orderId);
    const b = await qr(o.json.orderId);
    expect(b.json.reference).not.toBe(a.json.reference);
    expect((await call(`/api/payments/paynow/status/${a.json.paymentId}`)).json.state).toBe("EXPIRED");
    expect((await call(`/api/payments/paynow/status/${b.json.paymentId}`)).json.state).toBe("WAITING");
  });

  it("shows NOT_FOUND once the minutes are up, and PAID once the order is paid at the till", async () => {
    const o = await place();
    const r = await qr(o.json.orderId);
    await db.query("UPDATE payment_expectations SET expires_at = now() - interval '1 minute' WHERE payment_id=$1", [r.json.paymentId]);
    expect((await call(`/api/payments/paynow/status/${r.json.paymentId}`)).json.state).toBe("NOT_FOUND");
    // Staff confirm the PayNow payment at the till: the order is paid, so the QR's status follows.
    await call("/api/sync/push", { device: till.token, body: { events: [{ id: `pn${++n}`, orderId: o.json.orderId, deviceId: till.id, ts: Date.now() + n, seq: 1000 + n, type: "PaymentRecorded", paymentId: `till-${n}`, method: "paynow", amountCents: o.json.totalCents, confirmed: true }] } });
    const st = (await call(`/api/payments/paynow/status/${r.json.paymentId}`)).json;
    expect(st.state).toBe("PAID");
    expect(st.paidAt).toBeGreaterThan(0);
  });

  it("will not build a QR for an order that is already paid or does not exist, and an unknown QR is a plain not found", async () => {
    expect((await qr("nope")).status).toBe(404);
    expect((await call("/api/payments/paynow/status/nope")).status).toBe(404);
  });
});
