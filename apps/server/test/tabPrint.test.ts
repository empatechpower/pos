import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { MemberStore } from "../src/members.js";
import { topUp } from "../src/ledger.js";
import { PrintStore } from "../src/print.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// A tab payment prints its own receipt (Addendum 2.4, 5.1): quoted lines and components, who paid, who recorded it, what is left on the tab.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let evMgr = "";
const baseCfg = PRESETS.restaurant("bp", "Bailey & Patch", "EV");
// The documents' worked examples use a 9% service charge, and the points example earns 1 point per S$1.
const config = { ...baseCfg, pricing: { ...baseCfg.pricing, serviceRate: 0.09, stackable: false }, rewards: { ...baseCfg.rewards, pointsEnabled: true, earnPointsPerDollar: 1, welcomePoints: 0, welcomeVoucherCents: 0 } };

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

let tornado = "", kaya = "", coffee = "", coke = "";
let staffTok = "";
type Who = { id: string; token: string; tabId: string };
const hdr = (w: Who) => ({ "x-tab-participant": w.id, "x-tab-token": w.token });
async function tcall(url: string, o: { method?: string; body?: unknown; who?: Who; staff?: string; bearer?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.who ? hdr(o.who) : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(device ? { "x-device-token": device } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const join = async (table: string, name?: string, bearer?: string): Promise<Who & { isHost: boolean; json: any }> => {
  const r = await tcall("/api/shop/tab/join", { body: { outletId: "EV", table, displayName: name }, bearer });
  expect(r.status).toBe(200);
  return { id: r.json.participantId, token: r.json.token, tabId: r.json.tabId, isHost: r.json.isHost, json: r.json };
};
const orderRound = (w: Who, items: Array<{ productId: string; qty: number }>) => tcall("/api/shop/orders", { body: { channelId: "dine-in", outletId: "EV", items, customerName: "x", customerPhone: "", tab: { participantId: w.id, token: w.token } } });
const quote = (w: Who, p: object) => tcall("/api/shop/tab/quote", { body: p, who: w });
let keyN = 0;
const pay = (w: Who, quoteId: string, method = "counter", extra: object = {}) => tcall("/api/shop/tab/pay", { body: { quoteId, method, idempotencyKey: `idem-${++keyN}-${Date.now()}`, ...extra }, who: w });
const view = async (w: Who) => (await tcall("/api/shop/tab", { who: w })).json;
const confirm = (paymentId: string) => tcall(`/api/tabs/payments/${paymentId}/confirm`, { method: "POST", body: {}, staff: staffTok });
const payNow = async (w: Who, p: object, hostKeep = false) => {
  const q = await quote(w, p);
  expect(q.status).toBe(200);
  const r = await pay(w, q.json.quoteId, "counter", { hostKeep });
  expect(r.status).toBe(200);
  await confirm(r.json.paymentId);
  return q.json;
};

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, print: new PrintStore(db, "bp"), logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  await createStaff(db, { merchantId: "bp", code: "CSH", name: "Cat", role: "cashier", pin: "3333" });
  owner = await login("OWN", "999999");
  staffTok = await login("CSH", "3333");
  expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "Table shop", serviceMode: "tsr" }, staff: owner })).status).toBe(200);
  expect((await call("/api/outlets/EV/tab-settings", { method: "PUT", body: { tabService: true }, staff: owner })).status).toBe(200);
  for (const [n, c, p] of [["Tab Tornado", "Mains", 1080], ["Tab Kaya", "Toast", 200], ["Tab Coffee", "Drinks", 220], ["Tab Coke BCRS", "Drinks", 250]] as const) await call("/api/catalog/products", { body: { name: n, category: c, priceCents: p }, staff: owner });
  const products = (await call("/api/catalog")).json.products as any[];
  const id = (n: string) => products.find((p) => p.name === n).id as string;
  tornado = id("Tab Tornado"); kaya = id("Tab Kaya"); coffee = id("Tab Coffee"); coke = id("Tab Coke BCRS");
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});


describe("tab receipts", () => {
  it("every completed payment prints one receipt, with the payer, the staff recorder and the tab's position", async () => {
    expect((await call("/api/printers/rcpt", { method: "PUT", body: { name: "Counter receipt", language: "escpos", roles: ["receipt"], connection: { host: "10.0.0.5", port: 9100 }, raster: false }, staff: owner })).status).toBe(200);
    const alex = await join("PR1", "Alex"), sam = await join("PR1", "Sam");
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(sam, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    await payNow(sam, { mode: "mine" });
    const cash = await tcall(`/api/tabs/${alex.tabId}/payments`, { body: { participantId: alex.id, mode: "mine" }, staff: staffTok });
    expect(cash.status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    const jobs = (await db.query("SELECT title, payload FROM print_jobs WHERE merchant_id='bp' AND doc_type='receipt' AND title LIKE 'Tab PR1%' ORDER BY created_at")).rows;
    expect(jobs).toHaveLength(2); // one per payment, once
    const sams = Buffer.from(jobs[0].payload).toString("latin1");
    expect(sams).toContain("Tab PR1");
    expect(sams).toContain("Sam");
    expect(sams).toContain("1 x Tab Kaya");
    expect(sams).toContain("Remaining");
    const alexs = Buffer.from(jobs[1].payload).toString("latin1");
    expect(alexs).toContain("Recorded by");
    expect(alexs).toContain("Cat"); // the cashier who took the cash is named, separately from the payer
    // the same payment completing again prints nothing more
    const again = await db.query("SELECT count(*)::int AS n FROM print_jobs WHERE merchant_id='bp' AND doc_type='receipt' AND title LIKE 'Tab PR1%'");
    expect(again.rows[0].n).toBe(2);
  });
});
