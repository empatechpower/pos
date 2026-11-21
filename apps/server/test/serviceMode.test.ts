import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORDER_LIMIT_IP = "60";
process.env.QUEUE_CACHE_MS = "0";
process.env.SHOP_TABLES = "1-3"; // the old rule: a table list means table service, until an outlet is set
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { PrintStore } from "../src/print.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let scoped = "";

async function call(url: string, o: { method?: string; body?: object; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(device ? { "x-device-token": device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const order = (body: object, outlet?: string) => call("/api/shop/orders", { body: { items: [{ productId: "kaya-toast", qty: 1 }], customerPhone: "", ...(outlet ? { outletId: outlet } : {}), ...body } });
const info = (outlet?: string) => call(`/api/shop/info${outlet ? `?outlet=${outlet}` : ""}`);

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true, print: new PrintStore(db, "bp") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  owner = (await call("/api/auth/login", { body: { code: "OWN", pin: "999999" } })).json.token;
  await call("/api/outlets/QS", { method: "PUT", body: { name: "Counter shop", serviceMode: "qsr" }, staff: owner });
  await call("/api/outlets/TS", { method: "PUT", body: { name: "Table shop", serviceMode: "tsr" }, staff: owner });
  await createStaff(db, { merchantId: "bp", code: "QSM", name: "Quin", role: "manager", pin: "222222", outletId: "QS" });
  scoped = (await call("/api/auth/login", { body: { code: "QSM", pin: "222222" } })).json.token;
}, 90_000);

afterAll(async () => {
  await app.close();
  await stop();
});

describe("quick service (QSR): no table", () => {
  it("offers dine in and take away and no table list", async () => {
    const r = await info("QS");
    expect(r.json.serviceMode).toBe("qsr");
    expect(r.json.tables).toEqual([]);
    expect(r.json.channels.map((c: any) => c.kind).sort()).toEqual(["delivery", "dine_in", "takeaway"]);
  });
  it("takes a dine-in order and a take-away order with no table", async () => {
    expect((await order({ channelId: "dine-in" }, "QS")).status).toBe(200);
    expect((await order({ channelId: "take-away" }, "QS")).status).toBe(200);
  });
});

describe("table service (TSR): a table is a must", () => {
  it("offers dine in only, with the table list", async () => {
    const r = await info("TS");
    expect(r.json.serviceMode).toBe("tsr");
    expect(r.json.tables).toEqual(["Table 1", "Table 2", "Table 3"]);
    expect(r.json.channels.map((c: any) => c.kind)).toEqual(["dine_in"]);
  });
  it("refuses a dine-in order with no table, takes one with a table, and refuses take away", async () => {
    expect((await order({ channelId: "dine-in" }, "TS")).json.error).toBe("choose your table");
    expect((await order({ channelId: "dine-in", spot: "Table 9" }, "TS")).json.error).toBe("choose your table");
    expect((await order({ channelId: "dine-in", spot: "Table 2" }, "TS")).status).toBe(200);
    expect((await order({ channelId: "take-away", spot: "Table 2" }, "TS")).json.error).toBe("this shop takes dine-in orders only");
  });
});

describe("an outlet that has not chosen a mode follows the table list", () => {
  it("the original outlet is table service while the server has a table list", async () => {
    expect((await info()).json.serviceMode).toBe("tsr");
  });
  it("switching an outlet to QSR takes the table away; switching back brings it back", async () => {
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", serviceMode: "qsr" }, staff: owner })).status).toBe(200);
    expect((await info()).json.serviceMode).toBe("qsr");
    expect((await order({ channelId: "dine-in" })).status).toBe(200);
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", serviceMode: "tsr" }, staff: owner })).status).toBe(200);
    expect((await order({ channelId: "dine-in" })).json.error).toBe("choose your table");
  });
  it("refuses a mode that is neither", async () => {
    expect((await call("/api/outlets/QS", { method: "PUT", body: { name: "Counter shop", serviceMode: "buffet" }, staff: owner })).status).toBe(400);
  });
});

describe("service charge is an option", () => {
  const total = async () => (await order({ channelId: "dine-in" }, "QS")).json.totalCents as number;
  it("can be switched off and on by the brand owner, and the dine-in total follows", async () => {
    const on = (await call("/api/settings", { method: "PUT", body: { serviceChargeOn: true }, staff: owner })).json;
    expect(on.serviceChargeOn).toBe(true);
    const withService = await total();
    const off = (await call("/api/settings", { method: "PUT", body: { serviceChargeOn: false }, staff: owner })).json;
    expect(off.serviceChargeOn).toBe(false);
    const without = await total();
    expect(without).toBeLessThan(withService);
    expect((await call("/api/settings", { staff: owner })).json.serviceChargeOn).toBe(false);
  });
  it("promotion stacking and what points may pay are owner options too", async () => {
    const r = (await call("/api/settings", { method: "PUT", body: { stackable: false, pointsItemsEligibleOnly: true, pointsDeductService: false, pointsDeductTax: false }, staff: owner })).json;
    expect(r).toMatchObject({ stackable: false, pointsItemsEligibleOnly: true, pointsDeductService: false, pointsDeductTax: false });
    expect((await call("/api/settings", { staff: owner })).json).toMatchObject({ stackable: false, pointsDeductService: false });
    const back = (await call("/api/settings", { method: "PUT", body: { stackable: true, pointsItemsEligibleOnly: false, pointsDeductService: true, pointsDeductTax: true }, staff: owner })).json;
    expect(back).toMatchObject({ stackable: true, pointsItemsEligibleOnly: false, pointsDeductService: true, pointsDeductTax: true });
    expect((await call("/api/settings", { method: "PUT", body: { stackable: "no" }, staff: owner })).status).toBe(400);
    expect((await call("/api/settings", { method: "PUT", body: { stackable: false }, staff: scoped })).status).toBe(403);
  });
  it("a store login cannot change it", async () => {
    expect((await call("/api/settings", { method: "PUT", body: { serviceChargeOn: true }, staff: scoped })).status).toBe(403);
  });
  it("must be true or false", async () => {
    expect((await call("/api/settings", { method: "PUT", body: { serviceChargeOn: "yes" }, staff: owner })).status).toBe(400);
  });
});
