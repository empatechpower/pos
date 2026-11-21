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

describe("item names in other languages (the merchant's own words)", () => {
  const body = (extra: object) => ({ id: "p0", name: "Kaya Toast", category: "Toast", ...extra });
  const names = async () => (await catalog()).products.find((p) => p.id === "p0")!.names;

  it("saves the names as written, drops blank ones, and keeps them when another field is edited", async () => {
    expect(await names()).toBeUndefined();
    expect((await staffPost("/api/catalog/products", body({ names: { zh: "咖椰面包", ms: " Roti Kaya ", id: "  " } }))).status).toBe(200);
    expect(await names()).toEqual({ zh: "咖椰面包", ms: "Roti Kaya" });
    // A sold-out toggle, a rename or an options save does not send `names`, so they are left alone.
    expect((await staffPost("/api/catalog/products", body({ soldOut: true }))).status).toBe(200);
    expect(await names()).toEqual({ zh: "咖椰面包", ms: "Roti Kaya" });
    expect((await staffPost("/api/catalog/products", body({ soldOut: false }))).status).toBe(200);
  });

  it("an empty list clears them, and the base name is untouched throughout", async () => {
    expect((await staffPost("/api/catalog/products", body({ names: {} }))).status).toBe(200);
    expect(await names()).toBeUndefined();
    expect((await catalog()).products.find((p) => p.id === "p0")!.name).toBe("Kaya Toast");
  });

  it("refuses a name list that is not a list, and a name that is too long", async () => {
    expect((await staffPost("/api/catalog/products", body({ names: "咖椰面包" }))).status).toBe(400);
    expect((await staffPost("/api/catalog/products", body({ names: ["x"] }))).status).toBe(400);
    expect((await staffPost("/api/catalog/products", body({ names: { zh: "x".repeat(81) } }))).status).toBe(400);
    expect(await names()).toBeUndefined();
  });

  it("only a manager can set them", async () => {
    expect((await call("/api/catalog/products", { body: body({ names: { zh: "x" } }), staff: cashier })).status).toBe(403);
  });
});

describe("container deposit (BCRS) on a new item", () => {
  const make = (name: string, extra: object = {}) => staffPost("/api/catalog/products", { name, category: "Beverages", priceCents: 250, ...extra });
  const find = async (name: string) => (await catalog()).products.find((p) => p.name === name);

  it("a new item whose name says BCRS gets the deposit switched on", async () => {
    expect((await make("Test Cola 320ml BCRS")).status).toBe(200);
    expect((await find("Test Cola 320ml BCRS"))?.bcrs).toBe(true);
  });
  it("a new item without BCRS in the name does not", async () => {
    expect((await make("Test Plain Water")).status).toBe(200);
    expect((await find("Test Plain Water"))?.bcrs).toBeFalsy();
  });
  it("an explicit choice wins over the name, and a rename never switches an existing item's deposit", async () => {
    expect((await make("Test Zero BCRS", { bcrs: false })).status).toBe(200);
    expect((await find("Test Zero BCRS"))?.bcrs).toBeFalsy();
    const id = (await find("Test Plain Water"))!.id;
    expect((await staffPost("/api/catalog/products", { id, name: "Test Plain Water BCRS", category: "Beverages" })).status).toBe(200);
    expect((await find("Test Plain Water BCRS"))?.bcrs).toBeFalsy(); // the manager's rename dialog asks and sends it; the server alone never guesses
  });
});

describe("category names in other languages (the merchant's own words)", () => {
  const cats = async () => (await catalog()).categoryNames ?? {};
  const rename = (from: string, to: string, names?: unknown) => staffPost("/api/catalog/categories/rename", { from, to, ...(names !== undefined ? { names } : {}) });

  it("saves the names as written, drops blank ones, and they follow a rename", async () => {
    expect((await staffPost("/api/catalog/products", { name: "Zed Item", category: "Zed Group", priceCents: 100 })).status).toBe(200);
    expect(await cats()).not.toHaveProperty("Zed Group");
    expect((await rename("Zed Group", "Zed Group", { zh: "吐司组", ms: " Kumpulan Zed ", id: "  " })).status).toBe(200);
    expect((await cats())["Zed Group"]).toEqual({ zh: "吐司组", ms: "Kumpulan Zed" });
    expect((await rename("Zed Group", "Zed Renamed")).status).toBe(200); // no names sent: they are left as they are, and move with the category
    expect(await cats()).not.toHaveProperty("Zed Group");
    expect((await cats())["Zed Renamed"]).toEqual({ zh: "吐司组", ms: "Kumpulan Zed" });
  });

  it("an empty list clears them; bad input is refused; only a manager can set them", async () => {
    expect((await rename("Zed Renamed", "Zed Renamed", {})).status).toBe(200);
    expect(await cats()).not.toHaveProperty("Zed Renamed");
    expect((await rename("Zed Renamed", "Zed Renamed", "吐司")).status).toBe(400);
    expect((await rename("Zed Renamed", "Zed Renamed", { zh: "x".repeat(81) })).status).toBe(400);
    expect((await call("/api/catalog/categories/rename", { body: { from: "Zed Renamed", to: "Zed Renamed", names: { zh: "x" } }, staff: cashier })).status).toBe(403);
    expect(await cats()).not.toHaveProperty("Zed Renamed");
  });
});

describe("build-your-own products (rule sets stored with the product)", () => {
  const bowl = {
    variants: [
      { id: "regular", name: "Regular", groups: [
        { id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar", value: 450 }, options: [{ id: "salmon", name: "Salmon", priceCents: 750 }, { id: "chicken", name: "Chicken", priceCents: 450 }] },
        { id: "supp", name: "Supplements", minSelect: 3, maxSelect: 6, allowance: { mode: "dollar", value: 450 }, options: [{ id: "broc", name: "Broccoli", priceCents: 150, maxQty: 2 }, { id: "carr", name: "Carrots", priceCents: 150 }, { id: "brus", name: "Brussels", priceCents: 150 }] },
      ] },
      { id: "noprotein", name: "No Protein", groups: [{ id: "supp", name: "Supplements", minSelect: 6, maxSelect: 6, allowance: { mode: "dollar", value: 900 }, options: [{ id: "broc", name: "Broccoli", priceCents: 150, maxQty: 3 }, { id: "carr", name: "Carrots", priceCents: 150, maxQty: 3 }] }] },
    ],
  };
  const find = async () => (await catalog()).products.find((p) => p.name === "Test Build Bowl");
  const make = (extra: object = {}) => staffPost("/api/catalog/products", { name: "Test Build Bowl", category: "Bowls", priceCents: 1350, builder: bowl, ...extra });

  it("stores the rule sets and returns them with the menu, untouched by other edits", async () => {
    expect((await make()).status).toBe(200);
    const p = (await find())!;
    expect(p.builder).toEqual(bowl);
    // a sold-out toggle does not send the builder, so it is left alone
    expect((await staffPost("/api/catalog/products", { id: p.id, name: p.name, category: p.category, soldOut: true })).status).toBe(200);
    expect((await find())!.builder).toEqual(bowl);
    expect((await staffPost("/api/catalog/products", { id: p.id, name: p.name, category: p.category, soldOut: false })).status).toBe(200);
  });

  it("refuses a bad rule set, with what is wrong, and keeps what was there", async () => {
    const id = (await find())!.id;
    const bad = { groups: [{ id: "g", name: "G", minSelect: 4, maxSelect: 2, allowance: { mode: "dollar", value: -1 }, options: [{ id: "o", name: "O", priceCents: -5 }] }] };
    const r = await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", builder: bad });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain("maximum must be at least the minimum");
    expect((await find())!.builder).toEqual(bowl);
    expect((await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", builder: "bowl" })).status).toBe(400);
  });

  it("a product has options or a builder, not both; a builder can be removed", async () => {
    const id = (await find())!.id;
    const both = await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", options: [{ id: "o", name: "Size", kind: "single", required: true, choices: [{ id: "s", name: "S", priceCents: 0 }] }] });
    expect(both.status).toBe(400);
    expect(JSON.stringify(both.json)).toContain("options or a builder");
    expect((await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", builder: null })).status).toBe(200);
    expect((await find())!.builder).toBeUndefined();
  });

  it("an option linked to a plain menu item must not have options of its own", async () => {
    const withOptions = (await catalog()).products.find((p) => p.options?.length)!;
    const linked = (pid: string) => ({ groups: [{ id: "g", name: "G", minSelect: 0, maxSelect: 1, options: [{ id: "o", name: "O", priceCents: 0, productId: pid }] }] });
    const id = (await find())!.id;
    expect((await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", builder: linked(withOptions.id) })).status).toBe(400);
    expect((await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", builder: linked("no-such-item") })).status).toBe(400);
    const plain = (await catalog()).products.find((p) => !p.options?.length && p.name !== "Test Build Bowl")!;
    expect((await staffPost("/api/catalog/products", { id, name: "Test Build Bowl", category: "Bowls", builder: linked(plain.id) })).status).toBe(200);
  });
});
