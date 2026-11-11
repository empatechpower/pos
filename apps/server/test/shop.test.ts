import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, newId, reduceOrder, visibleToKitchen } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { PrintStore } from "../src/print.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let proxied: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let baseP = "";
let till = { token: "", id: "" };
let mgr = "";
let cashier = "";
let store: PgEventStore;
let print: PrintStore;

async function call(url: string, o: { method?: string; body?: unknown; raw?: Buffer; type?: string; device?: string; staff?: string; root?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch((o.root ?? base) + url, {
    method: o.method ?? (o.body !== undefined || o.raw ? "POST" : "GET"),
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.type ? { "content-type": o.type } : {}), ...(o.device ? { "x-device-token": o.device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}), ...o.headers },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const staffCall = (url: string, o: Parameters<typeof call>[1] = {}) => call(url, { ...o, device: till.token, staff: mgr });
// Every call comes from its own address (through the trusting proxy instance) unless a test says otherwise,
// because ordering is limited per address and these tests place many orders.
let ip = 0;
const order = (body: object, root = baseP, headers?: Record<string, string>) => call("/api/shop/orders", { body, root, headers: headers ?? { "x-forwarded-for": `192.0.2.${++ip}` } });
const kaya = (qty = 1) => ({ productId: "kaya-toast", qty });
const events = async (orderId: string) => store.eventsForOrder(orderId);
let n = 0;
const tillEvent = (orderId: string, extra: object) => ({ id: `te${++n}`, orderId, deviceId: till.id, ts: Date.now() + n, seq: n, ...extra });
const tillPush = (orderId: string, ...extra: object[]) => call("/api/sync/push", { body: { events: extra.map((e) => tillEvent(orderId, e)) }, device: till.token });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  store = new PgEventStore(db, "bp", "EV");
  print = new PrintStore(db, "bp");
  const common = { config, db, logger: false, store, catalog: cat, catalogAdmin: cat, print };
  app = await buildApp(common);
  proxied = await buildApp({ ...common, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  await proxied.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  baseP = `http://127.0.0.1:${(proxied.server.address() as { port: number }).port}`;
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  const e = (await enroll(db, "bp", c.code, "Till"))!;
  till = { token: e.token, id: e.device.id };
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" }, device: till.token })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" }, device: till.token })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await proxied?.close();
  await stop?.();
});

describe("the shop front", () => {
  it("is public and gives a page what it needs to dress itself", async () => {
    const r = await call("/api/shop/info");
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("Bailey & Patch");
    expect(r.json.channels.map((c: any) => c.id)).toEqual(["dine-in", "take-away", "grab"]);
    expect(r.json.brand).toMatchObject({ primary: "#ea7016", logoUrl: null });
    expect(JSON.stringify(r.json)).not.toMatch(/token|pin|secret/i);
  });
});

describe("placing an order", () => {
  it("with a phone number the collection number is its last 5 digits; a clash gets A, B; a freed number is reused", async () => {
    const mk = (phone: string) => order({ channelId: "take-away", items: [kaya()], customerPhone: phone });
    const a = await mk("+65 9333 6666");
    expect(a.json.queueNumber).toBe("36666");
    const b = await mk("+65 9333 6666");
    expect(b.json.queueNumber).toBe("36666A");
    const c = await mk("+65 9333 6666");
    expect(c.json.queueNumber).toBe("36666B");
    // order a completes: its number is free again
    await tillPush(a.json.orderId, { type: "StageSet", stage: "completed" });
    const d = await mk("+65 9333 6666");
    expect(d.json.queueNumber).toBe("36666");
  });

  it("without a phone number it falls back to the daily W number", async () => {
    const r = await order({ channelId: "take-away", items: [kaya()] });
    expect(r.json.queueNumber).toBe("W001");
  });

  it("is created from the server's prices, held for staff, and numbered from the phone", async () => {
    const r = await order({ channelId: "take-away", items: [kaya(2)], customerName: "Sam", customerPhone: "9123 4567" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ queueNumber: "34567", totalCents: 400, status: "received" });
    const o = reduceOrder(r.json.orderId, await events(r.json.orderId))!;
    expect(o).toMatchObject({ source: "online", channelName: "Take away", customerName: "Sam", customerPhone: "9123 4567" });
    expect(o.lines).toHaveLength(1);
    expect(visibleToKitchen(o, config)).toBe(false); // held until a member of staff accepts it
  });

  it("ignores any price the customer sends", async () => {
    const r = await order({ channelId: "take-away", items: [{ ...kaya(1), unitCents: 1, priceCents: 1, price: 0 }], total: 1, totalCents: 1 });
    expect(r.json.totalCents).toBe(200);
    expect(reduceOrder(r.json.orderId, await events(r.json.orderId))!.lines[0]!.unitCents).toBe(200);
  });

  it("charges the channel's service charge and the channel's pricebook", async () => {
    const dine = await order({ channelId: "dine-in", items: [kaya(1)] });
    expect(dine.json.totalCents).toBe(218); // 200 + 9%
    const grab = await order({ channelId: "grab", items: [kaya(1)] });
    expect(grab.json.totalCents).toBe(230); // Grab price, no service charge
  });

  it("tells the customer when prices changed since they looked, and places nothing", async () => {
    const before = (await db.query("SELECT count(*) FROM events WHERE type='OrderOpened'")).rows[0].count;
    const r = await order({ channelId: "take-away", items: [kaya(1)], expectedTotalCents: 150 });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "price_changed", totalCents: 200 });
    expect((await db.query("SELECT count(*) FROM events WHERE type='OrderOpened'")).rows[0].count).toBe(before);
    expect((await order({ channelId: "take-away", items: [kaya(1)], expectedTotalCents: 200 })).status).toBe(200);
  });

  it("rejects bad input in plain terms", async () => {
    const bad = async (body: object) => (await order(body)).status;
    expect(await bad({})).toBe(400);
    expect(await bad({ channelId: "nope", items: [kaya()] })).toBe(400);
    expect(await bad({ channelId: "take-away", items: [] })).toBe(400);
    for (const qty of [0, -2, 1.5, 21, "x"]) expect(await bad({ channelId: "take-away", items: [{ productId: "kaya-toast", qty }] })).toBe(400);
    expect(await bad({ channelId: "take-away", items: [{ productId: "ghost", qty: 1 }] })).toBe(400);
    expect(await bad({ channelId: "take-away", items: Array.from({ length: 31 }, () => kaya()) })).toBe(400);
    expect(await bad({ channelId: "take-away", items: [kaya()], customerPhone: "call me maybe" })).toBe(400);
    expect(await bad({ channelId: "take-away", items: "kaya" })).toBe(400);
  });

  it("refuses a sold-out item and a switched-off channel", async () => {
    await staffCall("/api/catalog/products", { body: { id: "kopi", name: "Coffee", category: "Drinks", soldOut: true } });
    expect((await order({ channelId: "take-away", items: [{ productId: "kopi", qty: 1 }] })).json.error).toBe("unavailable");
    await staffCall("/api/catalog/products", { body: { id: "kopi", name: "Coffee", category: "Drinks", soldOut: false } });
    await staffCall("/api/catalog/channels", { body: { id: "grab", name: "Grab", kind: "delivery", serviceCharge: false, active: false } });
    expect((await order({ channelId: "grab", items: [kaya()] })).json.error).toBe("channel_off");
    expect((await call("/api/shop/info")).json.channels.map((c: any) => c.id)).not.toContain("grab");
    await staffCall("/api/catalog/channels", { body: { id: "grab", name: "Grab", kind: "delivery", serviceCharge: false, active: true } });
  });

  it("cleans what the customer typed before it reaches staff screens and printers", async () => {
    const r = await order({ channelId: "dine-in", items: [kaya()], customerName: "  Eve\u0007\u001b[31m   <b>x</b>  " + "z".repeat(100), spot: "Table 5<script>alert(1)</script>" });
    const o = reduceOrder(r.json.orderId, await events(r.json.orderId))!;
    expect(o.customerName!.length).toBeLessThanOrEqual(40);
    expect(o.customerName).not.toMatch(/[\u0000-\u001f]/);
    expect(o.spot).not.toMatch(/[<>()]/);
    const take = await order({ channelId: "take-away", items: [kaya()], spot: "Table 9" });
    expect(reduceOrder(take.json.orderId, await events(take.json.orderId))!.spot).toBeUndefined(); // spot only means something for dine in
  });

  it("gives 20 simultaneous customers 20 different numbers", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": `10.0.0.${i + 1}` })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const nums = rs.map((r) => r.json.queueNumber as string);
    expect(new Set(nums).size).toBe(20);
  });

  it("limits how many orders one address can place", async () => {
    const hits: number[] = [];
    for (let i = 0; i < 12; i++) hits.push((await order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": "203.0.113.9" })).status);
    expect(hits.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(hits.slice(10)).toEqual([429, 429]);
    expect((await order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": "203.0.113.10" })).status).toBe(200); // someone else is fine
  });
});

describe("the customer's status page", () => {
  it("follows the order from received to queued as staff act", async () => {
    const o = (await order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": "198.51.100.1" })).json;
    const status = async () => (await call(`/api/shop/orders/${o.orderId}`)).json;
    expect((await status()).status).toBe("received");
    await tillPush(o.orderId, { type: "OrderAccepted" });
    expect((await status()).status).toBe("awaiting_payment");
    await tillPush(o.orderId, { type: "PaymentRecorded", paymentId: "pp", method: "cash", amountCents: 200, confirmed: true });
    expect((await status()).status).toBe("queued");
    await tillPush(o.orderId, { type: "StageSet", stage: "ready" });
    const s = await status();
    expect(s).toMatchObject({ status: "ready", queueNumber: o.queueNumber, totalCents: 200, paidCents: 200, items: [{ name: "Kaya Toast", qty: 1, unitCents: 200 }] });
  });

  it("shows a cancelled order as cancelled", async () => {
    const o = (await order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": "198.51.100.2" })).json;
    await tillPush(o.orderId, { type: "StageSet", stage: "cancelled" });
    expect((await call(`/api/shop/orders/${o.orderId}`)).json.status).toBe("cancelled");
  });

  it("does not reveal an order that is not an online order, or does not exist", async () => {
    const posOrder = newId();
    await tillPush(posOrder, { type: "OrderOpened", fulfilment: "takeaway", queueNumber: "A001" }, { type: "ItemAdded", lineId: "l", productId: "kaya-toast", name: "Kaya Toast", unitCents: 200, qty: 1 });
    expect((await call(`/api/shop/orders/${posOrder}`)).status).toBe(404);
    expect((await call("/api/shop/orders/not-a-real-id")).status).toBe(404);
  });

  it("the customer's order shows up on the tills through ordinary sync", async () => {
    const o = (await order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": "198.51.100.3" })).json;
    const pulled = (await call("/api/sync/pull?after=0", { device: till.token })).json.events as Array<{ event: { orderId: string; type: string; deviceId: string } }>;
    const mine = pulled.filter((p) => p.event.orderId === o.orderId);
    expect(mine.map((m) => m.event.type)).toEqual(["OrderOpened", "ItemAdded"]);
    expect(mine[0]!.event.deviceId).toBe("shop");
  });
});

describe("printing follows acceptance", () => {
  it("nothing prints until staff accept (and, in fast serve, it is paid), then ticket and receipt are queued", async () => {
    await print.savePrinter({ id: "k", name: "Kitchen", outletId: "EV", language: "escpos", roles: ["kitchen", "receipt"], categories: [], widthChars: 42, drawer: false, labelWidthMm: null, labelHeightMm: null, dpi: 203, connection: { host: "10.0.0.1", port: 9100 }, agentDeviceId: null, active: true });
    const o = (await order({ channelId: "take-away", items: [kaya()] }, baseP, { "x-forwarded-for": "198.51.100.4" })).json;
    const jobs = async () => (await db.query("SELECT doc_type FROM print_jobs WHERE order_id=$1", [o.orderId])).rows.map((r) => r.doc_type).sort();
    expect(await jobs()).toEqual([]);
    await tillPush(o.orderId, { type: "OrderAccepted" });
    expect(await jobs()).toEqual([]); // accepted but unpaid: fast serve still waits
    await tillPush(o.orderId, { type: "PaymentRecorded", paymentId: "pq", method: "cash", amountCents: 200, confirmed: true });
    expect(await jobs()).toEqual(["kitchen", "receipt"]);
    const title = (await db.query("SELECT title FROM print_jobs WHERE order_id=$1 LIMIT 1", [o.orderId])).rows[0].title;
    expect(title).toBe(o.queueNumber);
  });
});

describe("the shop look", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  it("anyone can read it, only a manager can change it", async () => {
    expect((await call("/api/brand")).json.primary).toBe("#ea7016");
    expect((await call("/api/brand", { method: "PUT", body: { primary: "#112233", accent: "#ffffff" } })).status).toBe(401);
    expect((await call("/api/brand", { method: "PUT", body: { primary: "#112233", accent: "#ffffff" }, device: till.token, staff: cashier })).status).toBe(403);
  });

  it("saves colours and picks readable text for them", async () => {
    const r = await staffCall("/api/brand", { method: "PUT", body: { primary: "#FFE000", accent: "#FFF8CC" } });
    expect(r.json).toMatchObject({ primary: "#ffe000", accent: "#fff8cc", ink: "#21252a" });
    const dark = await staffCall("/api/brand", { method: "PUT", body: { primary: "#1a237e", accent: "#e8eaf6" } });
    expect(dark.json.ink).toBe("#ffffff");
  });

  it("refuses anything that is not a plain hex colour (no CSS smuggling)", async () => {
    for (const primary of ["red", "#fff", "#ea7016;background:url(//evil)", "javascript:alert(1)", "#gggggg", ""]) {
      expect((await staffCall("/api/brand", { method: "PUT", body: { primary, accent: "#ffffff" } })).status).toBe(400);
    }
    expect((await call("/api/brand")).json.primary).toBe("#1a237e");
  });

  it("accepts a real PNG logo, serves it safely, and bumps the version", async () => {
    const r = await staffCall("/api/brand/logo", { method: "PUT", raw: PNG, type: "image/png" });
    expect(r.status).toBe(200);
    expect(r.json.logoUrl).toBe("/api/brand/logo?v=1");
    const logo = await call("/api/brand/logo");
    expect(logo.buf.equals(PNG)).toBe(true);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(logo.headers.get("content-security-policy")).toContain("sandbox");
    expect((await staffCall("/api/brand/logo", { method: "PUT", raw: PNG, type: "image/png" })).json.logoUrl).toBe("/api/brand/logo?v=2");
    expect((await call("/api/shop/info")).json.brand.logoUrl).toBe("/api/brand/logo?v=2");
  });

  it("refuses SVG, GIF, text, an image claiming to be another type, and oversized files", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const gif = Buffer.from("GIF89a" + "x".repeat(20));
    expect((await staffCall("/api/brand/logo", { method: "PUT", raw: svg, type: "image/png" })).status).toBe(400); // lies about its type
    expect((await staffCall("/api/brand/logo", { method: "PUT", raw: gif, type: "image/png" })).status).toBe(400);
    expect((await staffCall("/api/brand/logo", { method: "PUT", raw: svg, type: "image/svg+xml" })).status).toBe(415);
    expect((await staffCall("/api/brand/logo", { method: "PUT", raw: Buffer.from("hello"), type: "text/plain" })).status).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(310 * 1024)]);
    expect([400, 413]).toContain((await staffCall("/api/brand/logo", { method: "PUT", raw: big, type: "image/png" })).status);
    expect((await call("/api/brand/logo")).buf.equals(PNG)).toBe(true); // the good logo is untouched
  });

  it("audits who changed it", async () => {
    const entries = (await staffCall("/api/audit")).json.entries as Array<{ action: string; staff_code: string }>;
    expect(entries.some((e) => e.action === "brand.colors" && e.staff_code === "MGR")).toBe(true);
    expect(entries.some((e) => e.action === "brand.logo")).toBe(true);
  });
});
