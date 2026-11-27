import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff, setStaffPhone } from "../src/auth.js";
import { createEnrollmentCode, enroll, setDeviceLimit } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

describe("devices: approved by an owner signing in, the licence's limit, disconnect and reset", () => {
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let till = "";
  let ip = 0;
  const call = async (url: string, o: { body?: unknown; bearer?: string; device?: string | null } = {}) => {
    const device = o.device === undefined ? till : o.device;
    const res = await fetch(base + url, {
      method: o.body !== undefined ? "POST" : "GET",
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(device ? { "x-device-token": device } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, clear: res.headers.get("clear-site-data") };
  };
  beforeAll(async () => {
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    till = (await enroll(db, "bp", c.code, "Till"))!.token;
    await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat Cashier", role: "cashier", pin: "3333" });
    await createStaff(db, { merchantId: "bp", code: "O1", name: "Olive Owner", role: "owner", pin: "555555" });
    await setStaffPhone(db, "bp", "O1", "+6591110000");
    await setStaffPhone(db, "bp", "C1", "+6591110001");
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  it("an owner signing in on a new device approves it; a cashier or a wrong PIN does not", async () => {
    expect((await call("/api/devices/approve", { device: null, body: { phone: "+65 9111 0001", pin: "3333", name: "Phone" } })).status).toBe(403);
    expect((await call("/api/devices/approve", { device: null, body: { phone: "+65 9111 0000", pin: "000000", name: "Phone" } })).status).toBe(401);
    expect((await call("/api/devices/approve", { device: null, body: { phone: "+65 9111 0000", pin: "555555" } })).status).toBe(400);
    const ok = await call("/api/devices/approve", { device: null, body: { phone: "+65 9111 0000", pin: "555555", name: "Boss phone" } });
    expect(ok.status).toBe(200);
    expect(ok.json.outletId).toBe("EV");
    // the new token works like any enrolled device's: staff can sign in on it
    expect((await call("/api/auth/login", { device: ok.json.token, body: { code: "C1", pin: "3333" } })).status).toBe(200);
    // a staff code works as well as a phone number
    expect((await call("/api/devices/approve", { device: null, body: { code: "O1", pin: "555555", name: "Tablet 2" } })).status).toBe(200);
  });

  it("the licence caps connected devices for codes and approvals alike; disconnecting one makes room", async () => {
    const owner = (await call("/api/auth/login", { body: { code: "O1", pin: "555555" } })).json.token;
    const list = async () => (await call("/api/devices", { bearer: owner })).json;
    const now = (await list()).active as number;
    await setDeviceLimit(db, "bp", now);
    expect((await list()).limit).toBe(now);
    const refused = await call("/api/devices/approve", { device: null, body: { code: "O1", pin: "555555", name: "One too many" } });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: "device_limit", limit: now });
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    expect((await call("/api/devices/enroll", { device: null, body: { code: c.code, name: "Also too many" } })).status).toBe(409);
    // the code was given back: once a device is disconnected, the same code works
    const victim = ((await list()).devices as Array<{ id: string; name: string; active: boolean }>).find((d) => d.name === "Tablet 2")!;
    expect((await call(`/api/devices/${victim.id}/revoke`, { bearer: owner, body: {} })).status).toBe(200);
    expect((await call("/api/devices/enroll", { device: null, body: { code: c.code, name: "Now it fits" } })).status).toBe(200);
    await setDeviceLimit(db, "bp", null);
    expect((await list()).limit).toBeNull();
  });

  it("disconnect and reset: the device's next call tells its browser to clear the app; a plain disconnect does not", async () => {
    const owner = (await call("/api/auth/login", { body: { code: "O1", pin: "555555" } })).json.token;
    const plain = (await call("/api/devices/approve", { device: null, body: { code: "O1", pin: "555555", name: "Plain" } })).json;
    const stuck = (await call("/api/devices/approve", { device: null, body: { code: "O1", pin: "555555", name: "Stuck phone" } })).json;
    expect((await call(`/api/devices/${plain.deviceId}/revoke`, { bearer: owner, body: {} })).status).toBe(200);
    expect((await call(`/api/devices/${stuck.deviceId}/revoke`, { bearer: owner, body: { reset: true } })).status).toBe(200);
    const a = await call("/api/auth/login", { device: plain.token, body: { code: "C1", pin: "3333" } });
    expect(a.status).toBe(401);
    expect(a.clear).toBeNull();
    const b = await call("/api/auth/login", { device: stuck.token, body: { code: "C1", pin: "3333" } });
    expect(b.status).toBe(401);
    expect(b.json.error).toBe("device_not_enrolled");
    expect(b.clear).toBe('"cache", "storage"');
    // an already-disconnected device can still be reset
    expect((await call(`/api/devices/${plain.deviceId}/revoke`, { bearer: owner, body: { reset: true } })).status).toBe(200);
    expect((await call("/api/auth/login", { device: plain.token, body: { code: "C1", pin: "3333" } })).clear).toBe('"cache", "storage"');
    // the device in use cannot be disconnected from itself
    const rows = (await call("/api/devices", { bearer: owner })).json.devices as Array<{ id: string; name: string }>;
    expect((await call(`/api/devices/${rows.find((d) => d.name === "Till")!.id}/revoke`, { bearer: owner, body: { reset: true } })).status).toBe(400);
  });
});
