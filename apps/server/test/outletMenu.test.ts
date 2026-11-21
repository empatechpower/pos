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

// Backend handout section 8: menus are published per outlet. Fixture 10: the same product, two outlets, each with its own price and rules.

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
const bowl = {
  groups: [
    { id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar", value: 450 }, options: [{ id: "salmon", name: "Salmon", priceCents: 750 }, { id: "chicken", name: "Chicken", priceCents: 450 }] },
    { id: "supp", name: "Supplements", minSelect: 1, maxSelect: 6, options: [{ id: "broc", name: "Broccoli", priceCents: 150 }] },
  ],
};
let bowlId = "";
let teaId = "";

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  await createStaff(db, { merchantId: "bp", code: "EVM", name: "Eve", role: "manager", pin: "222222", outletId: "EV" });
  owner = await login("OWN", "999999");
  evMgr = await login("EVM", "222222");
  expect((await call("/api/outlets/CBD", { method: "PUT", body: { name: "CBD shop", serviceMode: "qsr" }, staff: owner })).status).toBe(200);
  expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "Enabling Village", serviceMode: "qsr" }, staff: owner })).status).toBe(200);
  const tea = await call("/api/catalog/products", { body: { name: "Menu Tea", category: "Drinks", priceCents: 250 }, staff: owner });
  expect(tea.status).toBe(200);
  const b = await call("/api/catalog/products", { body: { name: "Menu Bowl", category: "Bowls", priceCents: 1350, builder: bowl }, staff: owner });
  expect(b.status).toBe(200);
  const products = (await call("/api/catalog")).json.products as any[];
  teaId = products.find((p) => p.name === "Menu Tea").id;
  bowlId = products.find((p) => p.name === "Menu Bowl").id;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

const menuOf = async (outlet: string) => (await call(`/api/shop/menu?outlet=${outlet}`)).json;
const order = (outlet: string, productId: string, qty = 1) =>
  call("/api/shop/orders", { body: { channelId: "take-away", outletId: outlet, items: [{ productId, qty }], customerName: "T", customerPhone: "" } });

describe("per-outlet menus on the server", () => {
  it("lists the outlets with their prep time, kept when another field is saved", async () => {
    expect((await call("/api/outlets/CBD", { method: "PUT", body: { name: "CBD shop", prepMinutes: 15 }, staff: owner })).status).toBe(200);
    expect((await call("/api/outlets/CBD", { method: "PUT", body: { name: "CBD shop", address: "1 Raffles Place" }, staff: owner })).status).toBe(200);
    const stores = (await call("/api/shop/stores")).json.stores as any[];
    expect(stores.find((s) => s.id === "CBD")).toMatchObject({ name: "CBD shop", prepMinutes: 15, address: "1 Raffles Place" });
    expect(stores.find((s) => s.id === "CBD").directionsUrl).toContain("1%20Raffles%20Place");
    expect(stores.find((s) => s.id === "EV").prepMinutes).toBeNull();
    expect((await call("/api/outlets/CBD", { method: "PUT", body: { name: "CBD shop", prepMinutes: -5 }, staff: owner })).status).toBe(400);
    expect((await call("/api/outlets/CBD", { method: "PUT", body: { name: "CBD shop", prepMinutes: 1.5 }, staff: owner })).status).toBe(400);
  });

  it("an item switched off at one outlet is gone from its menu and cannot be ordered there, while the other outlet still sells it", async () => {
    const v0 = (await menuOf("CBD")).menuVersion;
    expect((await call(`/api/outlets/CBD/menu/${teaId}`, { method: "PUT", body: { off: true }, staff: owner })).status).toBe(200);
    const cbd = await menuOf("CBD");
    expect(cbd.products.some((p: any) => p.id === teaId)).toBe(false);
    expect(cbd.menuVersion).toBeGreaterThan(v0); // a phone sees the change at its next check
    expect(cbd.outletId).toBe("CBD");
    expect(cbd.prepMinutes).toBe(15);
    expect((await menuOf("EV")).products.some((p: any) => p.id === teaId)).toBe(true);
    expect((await call("/api/shop/menu/version?outlet=CBD")).json.version).toBe(cbd.menuVersion);
    const refused = await order("CBD", teaId);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("unavailable");
    expect((await order("EV", teaId)).status).toBe(200);
    // switched back on: it is back, and with nothing left to override the override is gone
    expect((await call(`/api/outlets/CBD/menu/${teaId}`, { method: "PUT", body: { off: false }, staff: owner })).status).toBe(200);
    expect((await menuOf("CBD")).products.some((p: any) => p.id === teaId)).toBe(true);
    expect((await call("/api/outlets/CBD/menu", { staff: owner })).json.menu[teaId]).toBeUndefined();
  });

  it("sold out is per outlet and can differ from the brand; the same menu answers a conditional request with 304", async () => {
    expect((await call(`/api/outlets/EV/menu/${teaId}`, { method: "PUT", body: { soldOut: true }, staff: owner })).status).toBe(200);
    expect((await menuOf("EV")).products.find((p: any) => p.id === teaId).soldOut).toBe(true);
    expect((await menuOf("CBD")).products.find((p: any) => p.id === teaId).soldOut).toBeUndefined();
    expect((await order("EV", teaId)).status).toBe(400);
    expect((await order("CBD", teaId)).status).toBe(200);
    const res = await fetch(`${base}/api/shop/menu?outlet=EV`, { headers: { "x-forwarded-for": "198.51.100.200" } });
    const etag = res.headers.get("etag")!;
    expect((await fetch(`${base}/api/shop/menu?outlet=EV`, { headers: { "if-none-match": etag, "x-forwarded-for": "198.51.100.201" } })).status).toBe(304);
    expect((await call(`/api/outlets/EV/menu/${teaId}`, { method: "PUT", body: { soldOut: null }, staff: owner })).status).toBe(200);
  });

  it("fixture 10: the same product has each outlet's own price and its own build rules", async () => {
    const book = (await call("/api/catalog/pricebooks", { body: { name: "CBD prices", missing: "show" }, staff: owner })).json;
    expect((await call("/api/catalog/assignments", { method: "PUT", body: { pricebookId: book.id, outletId: "CBD" }, staff: owner })).status).toBe(200);
    expect((await call(`/api/catalog/pricebooks/${book.id}/prices/${bowlId}`, { method: "PUT", body: { priceCents: 1550 }, staff: owner })).status).toBe(200);
    // CBD asks for two supplements, the brand's rules ask for one
    const cbdRules = { ...bowl, groups: [bowl.groups[0], { ...bowl.groups[1], minSelect: 2 }] };
    expect((await call(`/api/outlets/CBD/menu/${bowlId}`, { method: "PUT", body: { builder: cbdRules }, staff: owner })).status).toBe(200);
    const ev = await menuOf("EV");
    const cbd = await menuOf("CBD");
    const priceAt = (m: any, outlet: string) => m.pricebooks.find((b: any) => b.id === (m.assignments.find((a: any) => a.outletId === outlet)?.pricebookId ?? m.defaultPricebookId)).prices[bowlId];
    expect(priceAt(ev, "EV")).toBe(1350);
    expect(priceAt(cbd, "CBD")).toBe(1550);
    expect(ev.products.find((p: any) => p.id === bowlId).builder.groups[1].minSelect).toBe(1);
    expect(cbd.products.find((p: any) => p.id === bowlId).builder.groups[1].minSelect).toBe(2);
    // the brand's own rules are untouched
    expect(((await call("/api/catalog")).json.products as any[]).find((p) => p.id === bowlId).builder.groups[1].minSelect).toBe(1);
  });

  it("sold-out options are per outlet; unknown options and items are refused", async () => {
    expect((await call(`/api/outlets/EV/menu/${bowlId}`, { method: "PUT", body: { soldOutOptions: ["salmon"] }, staff: owner })).status).toBe(200);
    const salmonAt = (m: any) => m.products.find((p: any) => p.id === bowlId).builder.groups[0].options.find((o: any) => o.id === "salmon");
    expect(salmonAt(await menuOf("EV")).soldOut).toBe(true);
    expect(salmonAt(await menuOf("CBD")).soldOut).toBeUndefined();
    const bad = await call(`/api/outlets/EV/menu/${bowlId}`, { method: "PUT", body: { soldOutOptions: ["pork"] }, staff: owner });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toContain("not one of this item");
    expect((await call(`/api/outlets/EV/menu/nope`, { method: "PUT", body: { off: true }, staff: owner })).status).toBe(400);
    expect((await call(`/api/outlets/EV/menu/${bowlId}`, { method: "PUT", body: { off: "yes" }, staff: owner })).status).toBe(400);
    expect((await call(`/api/outlets/ghost/menu/${bowlId}`, { method: "PUT", body: { off: true }, staff: owner })).status).toBe(404);
  });

  it("an outlet manager changes only their own outlet", async () => {
    expect((await call(`/api/outlets/EV/menu/${teaId}`, { method: "PUT", body: { soldOut: true }, staff: evMgr })).status).toBe(200);
    expect((await call(`/api/outlets/CBD/menu/${teaId}`, { method: "PUT", body: { soldOut: true }, staff: evMgr })).status).toBe(403);
    expect((await call("/api/outlets/CBD/menu", { staff: evMgr })).status).toBe(403);
    expect((await call("/api/outlets/EV/menu", { staff: evMgr })).status).toBe(200);
    expect((await call(`/api/outlets/EV/menu/${teaId}`, { method: "PUT", body: { soldOut: true } })).status).toBe(401);
  });
});
