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

// Backend handout fixture 11: S$30.00 inclusive of 9% GST plus two BCRS items -> tax inside S$2.48, deposit S$0.20 on its own line, total S$30.20.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let mgr = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
config.pricing = { ...config.pricing, gstOn: true, gstRate: 0.09 };

async function call(url: string, o: { method?: string; body?: unknown; staff?: string } = {}) {
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
const product = async (name: string, priceCents: number, extra: object = {}) => {
  const r = await call("/api/catalog/products", { body: { name, category: "Tax test", priceCents, ...extra }, staff: mgr });
  expect(r.status).toBe(200);
  return ((await call("/api/catalog")).json.products as any[]).find((p) => p.name === name);
};

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("tax-inclusive items, end to end", () => {
  it("stores the flag, leaves it alone on other edits, and clears it back to the merchant default", async () => {
    const p = await product("Flag Test", 1000, { taxInclusive: true, taxGroup: "food" });
    expect(p).toMatchObject({ taxInclusive: true, taxGroup: "food" });
    expect((await call("/api/catalog/products", { body: { id: p.id, name: "Flag Test", category: "Tax test", soldOut: true }, staff: mgr })).status).toBe(200);
    expect(((await call("/api/catalog")).json.products as any[]).find((x) => x.id === p.id)).toMatchObject({ taxInclusive: true, taxGroup: "food" });
    expect((await call("/api/catalog/products", { body: { id: p.id, name: "Flag Test", category: "Tax test", taxInclusive: null, taxGroup: null }, staff: mgr })).status).toBe(200);
    const cleared = ((await call("/api/catalog")).json.products as any[]).find((x) => x.id === p.id);
    expect(cleared.taxInclusive).toBeUndefined();
    expect(cleared.taxGroup).toBeUndefined();
    expect((await call("/api/catalog/products", { body: { id: p.id, name: "Flag Test", category: "Tax test", taxInclusive: "yes" }, staff: mgr })).status).toBe(400);
  });

  it("fixture 11: the customer's bill holds S$2.48 of tax, a S$0.20 deposit line, and totals S$30.20", async () => {
    const mains = await product("Inclusive Mains", 2000, { taxInclusive: true });
    const water = await product("Inclusive Water BCRS", 500, { taxInclusive: true });
    expect(water.bcrs).toBe(true); // switched on by the name
    const o = await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: mains.id, qty: 1 }, { productId: water.id, qty: 2 }], customerName: "T", customerPhone: "" } });
    expect(o.status).toBe(200);
    expect(o.json.totalCents).toBe(3020);
    const v = (await call(`/api/shop/orders/${o.json.orderId}`)).json;
    expect(v.totalCents).toBe(3020);
    expect(v.taxIncludedCents).toBe(248);
    expect(v.totals.map((l: any) => l.key)).toEqual(["subtotal", "tax_included", "deposit", "total"]);
    expect(v.totals.find((l: any) => l.key === "tax_included")).toMatchObject({ label: "GST (included)", cents: 248 });
    expect(v.totals.find((l: any) => l.key === "deposit")).toMatchObject({ cents: 20, taxable: false });
    // the flags are frozen on the order: changing the item later does not change this bill
    expect((await call("/api/catalog/products", { body: { id: mains.id, name: "Inclusive Mains", category: "Tax test", taxInclusive: false }, staff: mgr })).status).toBe(200);
    expect((await call(`/api/shop/orders/${o.json.orderId}`)).json.totalCents).toBe(3020);
  });

  it("an item marked as priced before tax is taxed on top, and the bill says GST (not included)", async () => {
    const tea = await product("Plain Tea", 1000, { taxInclusive: false });
    const o = await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: tea.id, qty: 1 }], customerName: "T", customerPhone: "" } });
    expect(o.json.totalCents).toBe(1090);
    const v = (await call(`/api/shop/orders/${o.json.orderId}`)).json;
    expect(v.taxIncludedCents).toBe(0);
    expect(v.totals.find((l: any) => l.key === "tax_added")).toMatchObject({ label: "GST", cents: 90 });
  });

  it("an item with no flag follows the country: in Singapore the price already includes GST", async () => {
    const kopi = await product("Plain Kopi", 1090);
    const o = await call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: kopi.id, qty: 1 }], customerName: "T", customerPhone: "" } });
    expect(o.json.totalCents).toBe(1090);
    const v = (await call(`/api/shop/orders/${o.json.orderId}`)).json;
    expect(v.taxIncludedCents).toBe(90);
    expect(v.totals.find((l: any) => l.key === "tax_included")).toMatchObject({ label: "GST (included)", cents: 90 });
  });
});
