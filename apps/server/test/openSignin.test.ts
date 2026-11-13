import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// The temporary open sign-in for the event: a phone number is enough. Off unless SHOP_OPEN_SIGNIN=1.

let db: Db;
let stop: () => Promise<void>;
let on: Awaited<ReturnType<typeof buildApp>>;
let off: Awaited<ReturnType<typeof buildApp>>;
let baseOn = "";
let baseOff = "";
let till = "";
let mgr = "";
let ip = 0;

async function call(base: string, url: string, o: { body?: object; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.body ? "POST" : "GET",
    headers: { "x-forwarded-for": `192.0.2.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), "x-device-token": till, ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  const common = { config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true };
  process.env.SHOP_OPEN_SIGNIN = "1";
  on = await buildApp(common);
  delete process.env.SHOP_OPEN_SIGNIN;
  off = await buildApp(common);
  await on.listen({ port: 0, host: "127.0.0.1" });
  await off.listen({ port: 0, host: "127.0.0.1" });
  baseOn = `http://127.0.0.1:${(on.server.address() as { port: number }).port}`;
  baseOff = `http://127.0.0.1:${(off.server.address() as { port: number }).port}`;
  till = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Laptop"))!.token;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  mgr = (await call(baseOn, "/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
  await call(baseOn, "/api/members/import", { body: { source: "test", rows: [{ name: "Mei Lin", phone: "9123 4567", credit: "50" }] }, staff: mgr });
}, 120_000);
afterAll(async () => {
  await on?.close();
  await off?.close();
  await stop?.();
});

describe("temporary open sign-in", () => {
  it("is off by default: the shop asks for the text, and the open route does not exist", async () => {
    expect((await call(baseOff, "/api/shop/info")).json.auth.phone?.open).toBeUndefined();
    expect((await call(baseOff, "/api/shop/auth/phone/open", { body: { phone: "6591234567" } })).status).toBe(404);
  });

  it("when on, a member's phone number signs them in as that member, with their credit", async () => {
    expect((await call(baseOn, "/api/shop/info")).json.auth.phone).toMatchObject({ open: true });
    const r = await call(baseOn, "/api/shop/auth/phone/open", { body: { phone: "6591234567" } });
    expect(r.status).toBe(200);
    expect(r.json.member.name).toBe("Mei Lin");
    expect(r.json.created).toBe(false);
    const me = await call(baseOn, "/api/shop/me", { staff: r.json.token });
    expect(me.json.creditCents).toBe(5000);
  });

  it("a number that is not on the list gets a new member with no credit, and a bad number is refused", async () => {
    const r = await call(baseOn, "/api/shop/auth/phone/open", { body: { phone: "6598887777" } });
    expect(r.json.created).toBe(true);
    expect((await call(baseOn, "/api/shop/me", { staff: r.json.token })).json.creditCents).toBe(0);
    expect((await call(baseOn, "/api/shop/auth/phone/open", { body: { phone: "123" } })).status).toBe(400);
  });
});
