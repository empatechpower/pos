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

describe("a person's own screen choices", () => {
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
    await createStaff(db, { merchantId: "bp", code: "C2", name: "Cal Cashier", role: "cashier", pin: "4444" });
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  it("are kept per person, only the allowed choices are saved, and each person sees only their own", async () => {
    const a = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    const b = (await call("/api/auth/login", { body: { code: "C2", pin: "4444" } })).json.token;
    expect((await call("/api/auth/prefs", { bearer: a })).json).toEqual({ prefs: {} });
    expect((await call("/api/auth/prefs", { bearer: a, method: "PUT", body: { menuSide: "left", textSize: "large" } })).json).toEqual({ prefs: { menuSide: "left", textSize: "large" } });
    expect((await call("/api/auth/prefs", { bearer: a, method: "PUT", body: { menuSide: "sideways", textSize: "xl", hack: "x" } })).json).toEqual({ prefs: { menuSide: "left", textSize: "xl" } });
    expect((await call("/api/auth/prefs", { bearer: a, method: "PUT", body: { menuSide: "up" } })).status).toBe(400);
    expect((await call("/api/auth/prefs", { bearer: b })).json).toEqual({ prefs: {} });
    expect((await call("/api/auth/prefs")).status).toBe(401);
  });
});
