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

describe("the shop floor settings", () => {
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

  it("anyone signed in can read the floor, only a manager can change it, and a bad layout is refused", async () => {
    const c = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    const m = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    const first = (await call("/api/settings/floor", { bearer: c })).json;
    expect(first.sections.length).toBeGreaterThan(0);
    expect(first).toMatchObject({ splitBill: true, courses: true });
    expect((await call("/api/settings/floor", { bearer: c, method: "PUT", body: { splitBill: false } })).status).toBe(403);
    const saved = await call("/api/settings/floor", { bearer: m, method: "PUT", body: { sections: [{ id: "patio", name: "Patio", tables: [{ id: "p1", name: "P1", seats: 2 }, { id: "p2", name: "P2" }] }], splitBill: false } });
    expect(saved.status).toBe(200);
    expect((await call("/api/settings/floor", { bearer: c })).json).toMatchObject({ splitBill: false, courses: true, sections: [{ name: "Patio", tables: [{ name: "P1", seats: 2 }, { name: "P2" }] }] });
    expect((await call("/api/settings/floor", { bearer: m, method: "PUT", body: { sections: [{ id: "a", name: "A", tables: [{ id: "1", name: "T1" }, { id: "2", name: "T1" }] }] } })).status).toBe(400);
  });
});
