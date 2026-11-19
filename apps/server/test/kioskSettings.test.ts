import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// The kiosk's operator settings live on the server (set once in Manager), not on each tablet.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let owner = "";
let scoped = "";
let device = "";

async function call(url: string, o: { method?: string; body?: unknown; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "PUT" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(device ? { "x-device-token": device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  owner = (await call("/api/auth/login", { method: "POST", body: { code: "OWN", pin: "999999" } })).json.token;
  await call("/api/outlets/QS", { body: { name: "Counter shop", serviceMode: "qsr" }, staff: owner });
  await createStaff(db, { merchantId: "bp", code: "QSM", name: "Quin", role: "manager", pin: "222222", outletId: "QS" });
  scoped = (await call("/api/auth/login", { method: "POST", body: { code: "QSM", pin: "222222" } })).json.token;
}, 90_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("kiosk settings", () => {
  it("start from the defaults and reach the kiosk through the shop info", async () => {
    expect((await call("/api/shop/info")).json.kiosk).toEqual({ idleMinutes: 1, signinBlock: true, chips: { earn: true, rate: true, stamps: true } });
  });

  it("the brand owner saves them, partially, and the kiosk sees the change", async () => {
    const r = await call("/api/settings/kiosk", { body: { idleMinutes: 3, chips: { rate: false } }, staff: owner });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ idleMinutes: 3, signinBlock: true, chips: { earn: true, rate: false, stamps: true } });
    const r2 = await call("/api/settings/kiosk", { body: { signinBlock: false }, staff: owner });
    expect(r2.json).toEqual({ idleMinutes: 3, signinBlock: false, chips: { earn: true, rate: false, stamps: true } });
    expect((await call("/api/shop/info")).json.kiosk).toEqual(r2.json);
    expect((await call("/api/settings/kiosk", { staff: owner })).json).toEqual(r2.json);
  });

  it("ignores values that are not allowed", async () => {
    const before = (await call("/api/settings/kiosk", { staff: owner })).json;
    const r = await call("/api/settings/kiosk", { body: { idleMinutes: 99, signinBlock: "yes", chips: { earn: "no", bogus: true } }, staff: owner });
    expect(r.json).toEqual(before);
  });

  it("is for the whole brand and needs a login", async () => {
    expect((await call("/api/settings/kiosk", { body: { idleMinutes: 5 }, staff: scoped })).status).toBe(403);
    expect((await call("/api/settings/kiosk", { body: { idleMinutes: 5 } })).status).toBe(401);
    expect((await call("/api/settings/kiosk")).status).toBe(401);
  });
});
