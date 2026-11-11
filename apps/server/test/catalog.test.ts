import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, resolvePrice, type Catalog } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let cat: PgCatalogStore;
let base = "";
let device = "";
let mgr = "";
let cashier = "";

async function call(method: string, url: string, o: { body?: object; staff?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(o.body ? { "content-type": "application/json" } : {}), "x-device-token": device, ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}), ...o.headers },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, etag: res.headers.get("etag") };
}
const getCatalog = async () => (await call("GET", "/api/catalog")).json as Catalog;
const put = (url: string, body: object, staff = mgr) => call("PUT", url, { body, staff });
const post = (url: string, body: object, staff = mgr) => call("POST", url, { body, staff });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("POST", "/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
  cashier = (await call("POST", "/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("reading the catalog", () => {
  it("is public, complete, and priced per channel", async () => {
    const c = (await fetch(`${base}/api/catalog`)).status; // no device token, no staff
    expect(c).toBe(200);
    const cat = await getCatalog();
    expect(cat.products.length).toBeGreaterThan(5);
    const kaya = (ctx: string) => resolvePrice(cat, "kaya-toast", { outletId: "EV", channelId: ctx })?.priceCents;
    expect(kaya("dine-in")).toBe(200);
    expect(kaya("grab")).toBe(230); // 200 + 15%, rounded up to 5c
  });

  it("seeding twice does not overwrite later changes", async () => {
    await put("/api/catalog/pricebooks/standard/prices/kopi", { priceCents: 999 });
    await cat.ensureSeeded(seedCatalog());
    expect(resolvePrice(await getCatalog(), "kopi", { outletId: "EV", channelId: "dine-in" })?.priceCents).toBe(999);
    await put("/api/catalog/pricebooks/standard/prices/kopi", { priceCents: 220 });
  });

  it("answers 304 for an unchanged catalog and 200 once something changes", async () => {
    const first = await call("GET", "/api/catalog");
    expect((await call("GET", "/api/catalog", { headers: { "if-none-match": first.etag! } })).status).toBe(304);
    await put("/api/catalog/pricebooks/standard/prices/teh", { priceCents: 245 });
    const after = await call("GET", "/api/catalog", { headers: { "if-none-match": first.etag! } });
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(first.etag);
  });
});

describe("who may change it", () => {
  it("refuses no session and cashiers; allows managers", async () => {
    const url = "/api/catalog/pricebooks/standard/prices/teh";
    expect((await call("PUT", url, { body: { priceCents: 250 } })).status).toBe(401);
    expect((await put(url, { priceCents: 250 }, cashier)).status).toBe(403);
    expect((await put(url, { priceCents: 250 })).status).toBe(200);
  });

  it("needs an enrolled device as well", async () => {
    const res = await fetch(`${base}/api/catalog/pricebooks/standard/prices/teh`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${mgr}` },
      body: JSON.stringify({ priceCents: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("price changes", () => {
  it("applies, bumps the version, and audits old → new with who did it", async () => {
    const before = (await getCatalog()).version;
    const r = await put("/api/catalog/pricebooks/standard/prices/nasi-lemak", { priceCents: 720 });
    expect(r.json.version).toBe(before + 1);
    expect(r.json.previous).toBe(690);
    const audit = (await call("GET", "/api/audit", { staff: mgr })).json.entries as Array<{ action: string; staff_code: string; detail: any }>;
    const e = audit.find((a) => a.action === "catalog.price" && a.detail.productId === "nasi-lemak");
    expect(e?.staff_code).toBe("MGR");
    expect(e?.detail).toMatchObject({ previous: 690, priceCents: 720 });
  });

  it("rejects fractional, negative and non-numeric prices without changing anything", async () => {
    const before = (await getCatalog()).version;
    for (const priceCents of [4.5, -1, "2.00", undefined]) {
      expect((await put("/api/catalog/pricebooks/standard/prices/teh", { priceCents })).status).toBe(400);
    }
    expect((await getCatalog()).version).toBe(before);
  });

  it("rejects unknown products and pricebooks", async () => {
    expect((await put("/api/catalog/pricebooks/standard/prices/ghost", { priceCents: 100 })).status).toBe(400);
    expect((await put("/api/catalog/pricebooks/nope/prices/teh", { priceCents: 100 })).status).toBe(400);
  });

  it("removing a channel price (null) makes the item unsellable there, with no fallback (A-1)", async () => {
    await put("/api/catalog/pricebooks/grab/prices/teh", { priceCents: null });
    const c = await getCatalog();
    expect(resolvePrice(c, "teh", { outletId: "EV", channelId: "grab" })).toBeNull();
  });

  it("20 simultaneous changes: none lost, version rises by exactly 20", async () => {
    const c = await getCatalog();
    const ids = c.products.map((p) => p.id);
    const start = c.version;
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => put(`/api/catalog/pricebooks/standard/prices/${ids[i % ids.length]}`, { priceCents: 1000 + i })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await getCatalog()).version).toBe(start + 20);
  });
});

describe("outlets, channels and pricebooks", () => {
  it("reproduces the client's example: same item, one price at Regal, another at LIDO", async () => {
    await put("/api/catalog/pricebooks/standard/prices/soft-egg", { priceCents: 170 });
    const made = (await post("/api/catalog/pricebooks", { name: "LIDO" })).json;
    await put(`/api/catalog/pricebooks/${made.id}/prices/soft-egg`, { priceCents: 220 });
    expect((await put("/api/catalog/assignments", { pricebookId: made.id, outletId: "LIDO" })).status).toBe(200);
    const c = await getCatalog();
    expect(resolvePrice(c, "soft-egg", { outletId: "Regal", channelId: "take-away" })?.priceCents).toBe(170);
    expect(resolvePrice(c, "soft-egg", { outletId: "LIDO", channelId: "take-away" })?.priceCents).toBe(220);
  });

  it("changing the default pricebook changes unassigned contexts", async () => {
    const book = (await post("/api/catalog/pricebooks", { name: "Weekend" })).json;
    for (const p of (await getCatalog()).products) await put(`/api/catalog/pricebooks/${book.id}/prices/${p.id}`, { priceCents: 111 });
    expect((await put("/api/catalog/default-pricebook", { pricebookId: book.id })).status).toBe(200);
    expect(resolvePrice(await getCatalog(), "kopi", { outletId: "EV", channelId: "dine-in" })?.priceCents).toBe(111);
    await put("/api/catalog/default-pricebook", { pricebookId: "standard" });
  });

  it("an assignment to a missing pricebook is refused and leaves everything as it was", async () => {
    const before = await getCatalog();
    const r = await put("/api/catalog/assignments", { pricebookId: "ghost", channelId: "dine-in" });
    expect(r.status).toBe(400);
    expect(r.json.problems.join(" ")).toMatch(/missing pricebook|violates|foreign/i);
    expect((await getCatalog()).version).toBe(before.version);
    expect((await getCatalog()).assignments).toEqual(before.assignments);
  });

  it("a hide-pricebook channel sells only what it prices", async () => {
    const book = (await post("/api/catalog/pricebooks", { name: "Event", missing: "hide" })).json;
    await put(`/api/catalog/pricebooks/${book.id}/prices/kopi`, { priceCents: 100 });
    const ch = (await post("/api/catalog/channels", { name: "Movie Event", kind: "other", serviceCharge: false })).json;
    await put("/api/catalog/assignments", { pricebookId: book.id, channelId: ch.id });
    const c = await getCatalog();
    expect(resolvePrice(c, "kopi", { outletId: "EV", channelId: ch.id })?.priceCents).toBe(100);
    expect(resolvePrice(c, "nasi-lemak", { outletId: "EV", channelId: ch.id })).toBeNull();
  });

  it("channels can be renamed and their service charge toggled", async () => {
    const r = await post("/api/catalog/channels", { id: "take-away", name: "Pick up", kind: "takeaway", serviceCharge: true });
    expect(r.status).toBe(200);
    const ch = (await getCatalog()).channels.find((c) => c.id === "take-away");
    expect(ch).toMatchObject({ name: "Pick up", serviceCharge: true });
    await post("/api/catalog/channels", { id: "take-away", name: "Take away", kind: "takeaway", serviceCharge: false });
  });

  it("rejects a channel with a bad kind or no name", async () => {
    expect((await post("/api/catalog/channels", { name: "X", kind: "teleport" })).status).toBe(400);
    expect((await post("/api/catalog/channels", { name: "  ", kind: "other" })).status).toBe(400);
  });

  it("removing an assignment returns that context to the default", async () => {
    expect((await post("/api/catalog/assignments/remove", { channelId: "grab" })).status).toBe(200);
    expect(resolvePrice(await getCatalog(), "kaya-toast", { outletId: "EV", channelId: "grab" })?.pricebookId).toBe("standard");
  });
});

describe("adding and editing items", () => {
  it("a new item needs a price, then appears in the default pricebook", async () => {
    expect((await post("/api/catalog/products", { name: "Teh Tarik", category: "Drinks" })).status).toBe(400);
    const r = await post("/api/catalog/products", { name: "Teh Tarik", category: "Drinks", priceCents: 260 });
    expect(r.status).toBe(200);
    expect(resolvePrice(await getCatalog(), r.json.id, { outletId: "EV", channelId: "dine-in" })?.priceCents).toBe(260);
  });

  it("marks an item sold out without touching its price", async () => {
    await post("/api/catalog/products", { id: "kopi", name: "Coffee", category: "Drinks", soldOut: true });
    const c = await getCatalog();
    expect(c.products.find((p) => p.id === "kopi")?.soldOut).toBe(true);
    expect(resolvePrice(c, "kopi", { outletId: "EV", channelId: "dine-in" })).not.toBeNull();
  });
});
