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

describe("signing in with a phone number", () => {
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let till = "";
  let ip = 0;
  const call = async (url: string, o: { body?: unknown; bearer?: string; method?: string } = {}) => {
    const res = await fetch(base + url, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, "x-device-token": till, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
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
    app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    till = (await enroll(db, "bp", c.code, "Till"))!.token;
    await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat Cashier", role: "cashier", pin: "3333" });
    await createStaff(db, { merchantId: "bp", code: "M1", name: "Max Manager", role: "manager", pin: "222222" });
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  const login = (b: object) => call("/api/auth/login", { body: b });
  it("a person sets their phone with their PIN, then signs in with it; formats are forgiven, wrong numbers and PINs are not", async () => {
    const c = (await login({ code: "C1", pin: "3333" })).json.token;
    expect((await call("/api/auth/phone", { method: "PUT", bearer: c, body: { phone: "+65 8111 1111", pin: "0000" } })).status).toBe(401);
    expect((await call("/api/auth/phone", { method: "PUT", bearer: c, body: { phone: "8111", pin: "3333" } })).status).toBe(400);
    expect((await call("/api/auth/phone", { method: "PUT", bearer: c, body: { phone: "+65 8111 1111", pin: "3333" } })).json.phone).toBe("+6581111111");
    const ok = await login({ phone: "+65-8111-1111", pin: "3333" });
    expect(ok.status).toBe(200);
    expect(ok.json.staff.code).toBe("C1");
    expect((await login({ phone: "+6581111111", pin: "1234" })).status).toBe(401);
    expect((await login({ phone: "+6590000000", pin: "3333" })).status).toBe(401); // an unknown number looks just like a wrong PIN
    expect((await login({ pin: "3333" })).status).toBe(400);
    expect((await login({ code: "C1", pin: "3333" })).status).toBe(200); // the code still works
  });
  it("one number belongs to one person, and removing it ends phone sign-in", async () => {
    const m = (await login({ code: "M1", pin: "222222" })).json.token;
    expect((await call("/api/auth/phone", { method: "PUT", bearer: m, body: { phone: "+6581111111", pin: "222222" } })).status).toBe(409);
    const c = (await login({ code: "C1", pin: "3333" })).json.token;
    expect((await call("/api/auth/phone", { method: "PUT", bearer: c, body: { phone: null, pin: "3333" } })).json.phone).toBeNull();
    expect((await login({ phone: "+6581111111", pin: "3333" })).status).toBe(401);
  });
  it("five wrong PINs by phone lock the account, just as by code", async () => {
    const m = (await login({ code: "M1", pin: "222222" })).json.token;
    await call("/api/auth/phone", { method: "PUT", bearer: m, body: { phone: "+60123456789", pin: "222222" } });
    for (let i = 0; i < 5; i++) await login({ phone: "+60123456789", pin: "0000" });
    expect((await login({ code: "M1", pin: "222222" })).status).toBe(429);
  });
});
