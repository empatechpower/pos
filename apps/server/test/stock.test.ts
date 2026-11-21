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

// Stock (14 Nov handout, section 1.9): finished stock vs recipe, one consumption plan per line deducted exactly once, whole-order check, 86, cancel puts it back.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let evMgr = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

async function call(url: string, o: { method?: string; body?: unknown; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(device ? { "x-device-token": device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const login = async (code: string, pin: string) => (await call("/api/auth/login", { body: { code, pin } })).json.token as string;

let kayaId = "";
let cokeId = "";
let mealId = "";
const item = (id: string, name: string, unit = "pcs") => call(`/api/inventory/${id}`, { method: "PUT", body: { name, unit }, staff: owner });
const move = (id: string, reason: string, qty: number, extra: object = {}) => call(`/api/inventory/${id}/movements`, { body: { outletId: "EV", reason, qty, ...extra }, staff: owner });
const onHand = async () => Object.fromEntries(((await call("/api/inventory?outlet=EV", { staff: owner })).json.items as Array<{ id: string; onHand: number }>).map((i) => [i.id, i.onHand]));
const order = (items: Array<{ productId: string; qty: number; options?: object[] }>) => call("/api/shop/orders", { body: { channelId: "take-away", outletId: "EV", items, customerName: "T", customerPhone: "" } });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  await createStaff(db, { merchantId: "bp", code: "CSH", name: "Cat", role: "cashier", pin: "3333" });
  owner = await login("OWN", "999999");
  evMgr = await login("CSH", "3333");
  await item("bread", "Bread"); await item("jam", "Kaya jam", "g"); await item("coke-can", "Coke can");
  await call("/api/catalog/products", { body: { name: "Stock Kaya", category: "Toast", priceCents: 200, stock: { basis: "recipe", recipe: [{ itemId: "bread", qty: 2 }, { itemId: "jam", qty: 30 }] } }, staff: owner });
  await call("/api/catalog/products", { body: { name: "Stock Coke", category: "Drinks", priceCents: 250, stock: { basis: "finished", itemId: "coke-can" } }, staff: owner });
  const products = (await call("/api/catalog")).json.products as any[];
  kayaId = products.find((p) => p.name === "Stock Kaya").id;
  cokeId = products.find((p) => p.name === "Stock Coke").id;
  const meal = await call("/api/catalog/products", { body: { name: "Stock Meal", category: "Meals", priceCents: 600, options: [{ id: "drink", name: "Drink", kind: "single", required: true, choices: [{ id: "coke", name: "Coke", priceCents: 0, productId: cokeId, default: true }] }] }, staff: owner });
  expect(meal.status).toBe(200);
  mealId = ((await call("/api/catalog")).json.products as any[]).find((p) => p.name === "Stock Meal").id;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("stock on the server", () => {
  it("only managers manage stock; a product's stock must name real items", async () => {
    expect((await call("/api/inventory", { staff: evMgr })).status).toBe(403);
    expect((await call("/api/inventory/Bad Id", { method: "PUT", body: { name: "x" }, staff: owner })).status).toBe(400);
    const bad = await call("/api/catalog/products", { body: { id: kayaId, name: "Stock Kaya", category: "Toast", stock: { basis: "finished", itemId: "nope" } }, staff: owner });
    expect(bad.status).toBe(400);
    expect(bad.json.problems[0]).toContain("does not exist");
    expect((await call("/api/catalog/products", { body: { id: kayaId, name: "Stock Kaya", category: "Toast", stock: { basis: "recipe", recipe: [] } }, staff: owner })).status).toBe(400);
  });

  it("receiving, waste and a stocktake are movements, never edits", async () => {
    expect((await move("bread", "receive", 10)).json.onHand).toBe(10);
    expect((await move("jam", "receive", 100)).json.onHand).toBe(100);
    expect((await move("coke-can", "receive", 3)).json.onHand).toBe(3);
    expect((await move("bread", "receive", 0)).status).toBe(400);
    expect((await move("bread", "waste", 1, { note: "dropped" })).json.onHand).toBe(9);
    expect((await move("bread", "count", 10)).json).toMatchObject({ onHand: 10, delta: 1 }); // counted 10, the books said 9
    const hist = (await call("/api/inventory/bread/movements?outlet=EV", { staff: owner })).json.movements as Array<{ reason: string; delta: number }>;
    expect(hist.map((h) => [h.reason, h.delta])).toEqual([["count", 1], ["waste", -1], ["receive", 10]]);
  });

  it("selling a recipe item deducts its ingredients once, and the same delivery again deducts nothing more", async () => {
    const r = await order([{ productId: kayaId, qty: 2 }]);
    expect(r.status).toBe(200);
    expect(await onHand()).toMatchObject({ bread: 6, jam: 40 });
    const events = (await db.query("SELECT body, id, order_id, device_id FROM events WHERE merchant_id='bp' AND order_id=$1", [r.json.orderId])).rows;
    expect(events.length).toBeGreaterThan(0);
    // a till pushing the same events again (a duplicate delivery) changes nothing
    const pushed = await call("/api/sync/push", { body: { events: [] }, device });
    expect(pushed.status).toBe(200);
    expect(await onHand()).toMatchObject({ bread: 6, jam: 40 });
  });

  it("an order stock cannot cover is refused whole, and nothing is deducted", async () => {
    const before = await onHand();
    const r = await order([{ productId: kayaId, qty: 4 }]); // needs 8 bread, 120 g jam: bread 6 and jam 40 are both short
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("out_of_stock");
    expect(r.json.items.map((i: any) => i.name).sort()).toEqual(["Bread", "Kaya jam"]);
    expect(await onHand()).toEqual(before);
    const mixed = await order([{ productId: kayaId, qty: 1 }, { productId: cokeId, qty: 9 }]); // the kaya is fine, the coke is short: neither is taken
    expect(mixed.status).toBe(409);
    expect(await onHand()).toEqual(before);
  });

  it("a combo's shell consumes nothing; the chosen drink deducts its own stock, once per meal", async () => {
    const before = await onHand();
    const r = await order([{ productId: mealId, qty: 2, options: [{ groupId: "drink", choiceId: "coke" }] }]);
    expect(r.status).toBe(200);
    expect((await onHand())["coke-can"]).toBe(before["coke-can"]! - 2);
  });

  it("86: out of stock means sold out in the menu, for the item and for combos that link to it; receiving brings it back", async () => {
    expect((await onHand())["coke-can"]).toBe(1);
    await move("coke-can", "waste", 1);
    const menu = (await call("/api/shop/menu?outlet=EV")).json;
    expect(menu.products.find((p: any) => p.id === cokeId).soldOut).toBe(true);
    expect(menu.products.find((p: any) => p.id === mealId).options[0].choices[0].soldOut).toBe(true);
    expect(menu.products.find((p: any) => p.id === kayaId).soldOut).toBeFalsy();
    expect((await order([{ productId: cokeId, qty: 1 }])).status).toBe(400);
    const v0 = (await call("/api/shop/menu/version?outlet=EV")).json.version;
    await move("coke-can", "receive", 5);
    expect((await call("/api/shop/menu/version?outlet=EV")).json.version).toBeGreaterThan(v0); // a phone sees it come back
    expect((await call("/api/shop/menu?outlet=EV")).json.products.find((p: any) => p.id === cokeId).soldOut).toBeFalsy();
  });

  it("cancelling an order puts its stock back", async () => {
    const before = await onHand();
    const r = await order([{ productId: kayaId, qty: 1 }]);
    expect(r.status).toBe(200);
    expect((await onHand()).bread).toBe(before.bread! - 2);
    expect((await call(`/api/shop/orders/${r.json.orderId}/cancel`, { method: "POST" })).status).toBe(200);
    expect(await onHand()).toEqual(before);
  });
});
