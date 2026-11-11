import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, reduceOrder, resolvePrice, type Catalog } from "@pos/core";
import { buildApp } from "../src/app.js";
import { BrandStore } from "../src/brand.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { PrintStore } from "../src/print.js";
import { loadBaileyPatch } from "../src/seed.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
const seed = loadBaileyPatch()!;
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let till = "";
let mgr = "";
let cashier = "";
let store: PgEventStore;

async function call(url: string, o: { method?: string; body?: unknown; raw?: Buffer; type?: string; staff?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body !== undefined || o.raw ? "POST" : "GET"),
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.type ? { "content-type": o.type } : {}), "x-device-token": till, ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}), ...o.headers },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
let ip = 0;
const order = (body: object) => call("/api/shop/orders", { body, headers: { "x-forwarded-for": `198.18.0.${++ip}` } });
const catalog = async () => (await call("/api/catalog")).json as Catalog;
const staffPost = (url: string, body: object, o: { method?: string } = {}) => call(url, { body, staff: mgr, method: o.method });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seed.catalog, seed.images);
  await new BrandStore(db, "bp").seedIfEmpty(seed.brand);
  store = new PgEventStore(db, "bp", "EV");
  app = await buildApp({ config, db, logger: false, store, catalog: cat, catalogAdmin: cat, print: new PrintStore(db, "bp"), trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const e = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!;
  till = e.token;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
}, 180_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("the Bailey & Patch menu", () => {
  it("loads all 132 items in 19 categories with a photo on every one", async () => {
    const c = await catalog();
    expect(c.products).toHaveLength(132);
    expect(new Set(c.products.map((p) => p.category)).size).toBe(19);
    expect(c.products.every((p) => (p.imageVersion ?? 0) >= 1)).toBe(true);
    expect(c.products.filter((p) => p.soldOut)).toHaveLength(6);
    expect(c.products.map((p) => p.category).filter((x, i, a) => a.indexOf(x) === i)[0]).toBe("Toast"); // the prototype's order
  });

  it("carries the prototype's prices, rules and names", async () => {
    const c = await catalog();
    const price = (id: string) => resolvePrice(c, id, { outletId: "EV", channelId: "dine-in" })?.priceCents;
    expect(price("p0")).toBe(200); // Kaya Toast
    expect(price("p6")).toBe(220); // Coffee, Hot
    expect(c.products.find((p) => p.id === "p0")).toMatchObject({ name: "Kaya Toast", altName: "咖椰面包", description: "Homemade kaya on crisp toasted bread" });
    expect(c.products.filter((p) => p.pointsExempt).every((p) => p.category === "Beer / Whisky")).toBe(true);
    expect(c.products.filter((p) => p.pointsExempt).length).toBeGreaterThan(0);
  });

  it("has 18 items with Variants plus the Karaage rice add-ons, shaped as the spec describes", async () => {
    const c = await catalog();
    expect(c.products.filter((p) => p.options).map((p) => p.id).sort()).toEqual(["p6", "p7", "p8", "p10", "p11", "p12", "p13", "p15", "p16", "p18", "p27", "p31", "p34", "p115", "p118", "p119", "p109", "p117", "p68"].sort());
    expect(c.products.filter((p) => p.options?.some((g) => g.variant))).toHaveLength(18);
    const coffee = c.products.find((p) => p.id === "p6")!;
    expect(coffee.options![0]!.choices.map((x) => [x.name, x.priceCents])).toEqual([["Hot", 0], ["Iced", 80]]); // S$2.20 / S$3.00
    const karaage = c.products.find((p) => p.id === "p68")!;
    expect(karaage.options!.map((g) => [g.name, g.kind])).toEqual([["Egg style", "single"], ["Extras", "qty"]]);
    expect(karaage.options![1]!.choices.map((x) => [x.name, x.priceCents])).toEqual([["Sunny Side Egg", 200], ["Braised Egg (1pc)", 180], ["Jasmine Rice", 160]]);
    expect(c.products.find((p) => p.id === "p117")!.options!.find((g) => g.id === "flavour")!.choices.find((x) => x.id === "strawberry-paradise")!.soldOut).toBe(true);
  });

  it("starts the shop with the prototype's colours, tagline, logo and café photo", async () => {
    const info = (await call("/api/shop/info")).json;
    expect(info.brand).toMatchObject({ primary: "#e1523e", accent: "#ea7016", tagline: "Where every tail tells a tale" });
    expect(info.brand.logoUrl).toMatch(/^\/api\/brand\/logo\?v=/);
    expect(info.brand.heroUrl).toMatch(/^\/api\/brand\/hero\?v=/);
    expect((await call("/api/brand/hero")).headers.get("content-type")).toBe("image/jpeg");
  });

  it("seeding again changes nothing", async () => {
    const cat = new PgCatalogStore(db, "bp");
    const before = (await catalog()).version;
    await cat.ensureSeeded(seed.catalog, seed.images);
    expect((await catalog()).version).toBe(before);
  });
});

describe("item photos", () => {
  it("are public, typed, and safe to serve", async () => {
    const r = await call("/api/products/p1/image");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.buf.length).toBeGreaterThan(1000);
    expect((await fetch(`${base}/api/products/p1/image`)).status).toBe(200); // no device token needed
    expect((await call("/api/products/nope/image")).status).toBe(404);
  });

  it("only a manager can replace one; the type is checked by content", async () => {
    const url = "/api/catalog/products/p1/image";
    expect((await call(url, { method: "PUT", raw: PNG, type: "image/png" })).status).toBe(401);
    expect((await call(url, { method: "PUT", raw: PNG, type: "image/png", staff: cashier })).status).toBe(403);
    const v0 = (await catalog()).products.find((p) => p.id === "p1")!.imageVersion!;
    const ok = await call(url, { method: "PUT", raw: PNG, type: "image/png", staff: mgr });
    expect(ok.status).toBe(200);
    expect(ok.json.imageVersion).toBe(v0 + 1);
    expect((await call("/api/products/p1/image")).headers.get("content-type")).toBe("image/png");
    expect((await catalog()).products.find((p) => p.id === "p1")!.imageVersion).toBe(v0 + 1);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await call(url, { method: "PUT", raw: svg, type: "image/png", staff: mgr })).status).toBe(400);
    expect((await call(url, { method: "PUT", raw: svg, type: "image/svg+xml", staff: mgr })).status).toBe(415);
    expect((await call("/api/catalog/products/ghost/image", { method: "PUT", raw: PNG, type: "image/png", staff: mgr })).status).toBe(400);
    expect([400, 413]).toContain((await call(url, { method: "PUT", raw: Buffer.concat([PNG, Buffer.alloc(310 * 1024)]), type: "image/png", staff: mgr })).status);
  });
});

describe("editing items without wiping them", () => {
  it("marking an item sold out keeps its description, name in another language and options", async () => {
    const before = (await catalog()).products.find((p) => p.id === "p68")!;
    const r = await staffPost("/api/catalog/products", { id: "p68", name: before.name, category: before.category, soldOut: true });
    expect(r.status).toBe(200);
    const after = (await catalog()).products.find((p) => p.id === "p68")!;
    expect(after.soldOut).toBe(true);
    expect(after.description).toBe(before.description);
    expect(after.altName).toBe(before.altName);
    expect(after.options).toEqual(before.options);
    await staffPost("/api/catalog/products", { id: "p68", name: before.name, category: before.category, soldOut: false });
  });

  it("an empty string or empty list clears a field on purpose", async () => {
    await staffPost("/api/catalog/products", { id: "p6", name: "Coffee", category: "Coffee & Tea", description: "", options: [] });
    const p = (await catalog()).products.find((x) => x.id === "p6")!;
    expect(p.description).toBeUndefined();
    expect(p.options).toBeUndefined();
  });

  it("new options are validated as a whole, and a bad set changes nothing", async () => {
    const v = (await catalog()).version;
    const bad = await staffPost("/api/catalog/products", { id: "p7", name: "x", category: "Toast", options: [{ id: "g", name: "G", kind: "single", required: true, choices: [{ id: "a", name: "A", priceCents: -5 }] }] });
    expect(bad.status).toBe(400);
    expect(bad.json.problems.join()).toMatch(/invalid price/);
    expect((await catalog()).version).toBe(v);
    const good = await staffPost("/api/catalog/products", { id: "p6", name: "Coffee", category: "Coffee & Tea", options: [{ id: "temp", name: "Hot or cold", kind: "single", required: true, choices: [{ id: "hot", name: "Hot", priceCents: 0, default: true }, { id: "cold", name: "Cold", priceCents: 80 }] }] });
    expect(good.status).toBe(200);
  });
});

describe("ordering items with options", () => {
  const coffee = (choiceId?: string) => ({ productId: "p6", qty: 1, options: choiceId ? [{ groupId: "temp", choiceId }] : [] });

  it("prices the choice on the server: Cold is S$3.00, Hot is S$2.20", async () => {
    expect((await order({ channelId: "take-away", items: [coffee("hot")] })).json.totalCents).toBe(220);
    expect((await order({ channelId: "take-away", items: [coffee("cold")] })).json.totalCents).toBe(300);
  });

  it("will not take a Coffee without saying hot or cold", async () => {
    const r = await order({ channelId: "take-away", items: [coffee()] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("missing_required");
  });

  it("ignores a name or price the customer sends for an option", async () => {
    const r = await order({ channelId: "take-away", items: [{ productId: "p6", qty: 1, options: [{ groupId: "temp", choiceId: "cold", priceCents: 0, name: "Free", price: 0 }] }] });
    expect(r.json.totalCents).toBe(300);
  });

  it("refuses sold-out and unknown choices", async () => {
    expect((await order({ channelId: "take-away", items: [{ productId: "p117", qty: 1, options: [{ groupId: "flavour", choiceId: "strawberry-paradise" }] }] })).json.error).toBe("option_sold_out");
    expect((await order({ channelId: "take-away", items: [{ productId: "p6", qty: 1, options: [{ groupId: "temp", choiceId: "boiling" }] }] })).json.error).toBe("unknown_option");
    expect((await order({ channelId: "take-away", items: [{ productId: "p0", qty: 1, options: [{ groupId: "temp", choiceId: "hot" }] }] })).json.error).toBe("unknown_option"); // Kaya Toast has no options
  });

  it("a customised karaage rice: choice free, extras per unit, frozen onto the order", async () => {
    const r = await order({
      channelId: "take-away",
      items: [{ productId: "p68", qty: 1, options: [{ groupId: "egg", choiceId: "sunny" }, { groupId: "extras", choiceId: "sunny-egg", qty: 2 }, { groupId: "extras", choiceId: "jasmine-rice" }] }],
    });
    expect(r.status).toBe(200);
    const base = (await catalog()).pricebooks.find((b) => b.id === "takeaway")!.prices.p68!;
    expect(r.json.totalCents).toBe(base + 2 * 200 + 160);
    const o = reduceOrder(r.json.orderId, await store.eventsForOrder(r.json.orderId))!;
    expect(o.lines[0]!.options).toEqual([
      { group: "Egg style", name: "Sunny side", qty: 1, priceCents: 0 },
      { group: "Extras", name: "Sunny Side Egg", qty: 2, priceCents: 200 },
      { group: "Extras", name: "Jasmine Rice", qty: 1, priceCents: 160 },
    ]);
    const status = (await call(`/api/shop/orders/${r.json.orderId}`)).json;
    expect(status.items[0].options).toEqual(["Sunny side", "Sunny Side Egg x2", "Jasmine Rice"]);
  });

  it("hot and cold are separate lines on one order", async () => {
    const r = await order({ channelId: "take-away", items: [coffee("hot"), coffee("cold")] });
    expect(r.json.totalCents).toBe(520);
    expect(reduceOrder(r.json.orderId, await store.eventsForOrder(r.json.orderId))!.lines).toHaveLength(2);
  });

  it("the kitchen ticket says which", async () => {
    await new PrintStore(db, "bp").savePrinter({ id: "k", name: "Kitchen", outletId: "EV", language: "escpos", roles: ["kitchen"], categories: [], widthChars: 42, drawer: false, labelWidthMm: null, labelHeightMm: null, dpi: 203, connection: { host: "10.0.0.1", port: 9100 }, agentDeviceId: null, active: true });
    const r = await order({ channelId: "take-away", items: [coffee("cold")] });
    const dev = (await db.query("SELECT id FROM devices LIMIT 1")).rows[0].id;
    const mk = (extra: object, n: number) => ({ id: `acc${n}${r.json.orderId}`, orderId: r.json.orderId, deviceId: dev, ts: Date.now() + n, seq: n, ...extra });
    await call("/api/sync/push", { body: { events: [mk({ type: "OrderAccepted" }, 1), mk({ type: "PaymentRecorded", paymentId: "pm", method: "cash", amountCents: 300, confirmed: true }, 2)] } });
    const job = (await db.query("SELECT payload FROM print_jobs WHERE order_id=$1 AND doc_type='kitchen'", [r.json.orderId])).rows[0];
    expect(job.payload.toString("latin1")).toContain("- Cold");
  });
});

describe("the shop look", () => {
  it("a manager sets the tagline and a promotion; blank clears it; control characters are stripped", async () => {
    const r = await call("/api/brand/content", { method: "PUT", body: { tagline: "Pets welcome", promoTitle: "Weekday set", promoBody: "Any toast + coffee\u0007 for S$4" }, staff: mgr });
    expect(r.json).toMatchObject({ tagline: "Pets welcome", promoTitle: "Weekday set", promoBody: "Any toast + coffee for S$4" });
    const cleared = await call("/api/brand/content", { method: "PUT", body: { tagline: "", promoTitle: "", promoBody: "" }, staff: mgr });
    expect(cleared.json).toMatchObject({ tagline: null, promoTitle: null, promoBody: null });
    expect((await call("/api/brand/content", { method: "PUT", body: { tagline: "x".repeat(81) }, staff: mgr })).status).toBe(400);
    expect((await call("/api/brand/content", { method: "PUT", body: { tagline: "x" }, staff: cashier })).status).toBe(403);
  });

  it("the hero photo is checked like the logo", async () => {
    expect((await call("/api/brand/hero", { method: "PUT", raw: PNG, type: "image/png", staff: mgr })).status).toBe(200);
    expect((await call("/api/brand/hero")).headers.get("content-type")).toBe("image/png");
    expect((await call("/api/brand/hero", { method: "PUT", raw: Buffer.from("GIF89a" + "x".repeat(20)), type: "image/png", staff: mgr })).status).toBe(400);
    expect((await call("/api/brand/hero", { method: "PUT", raw: PNG, type: "image/png" })).status).toBe(401);
  });
});
