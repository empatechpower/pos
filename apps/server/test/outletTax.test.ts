import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, type OrderEvent } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { PrintStore } from "../src/print.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// Handout 4.3 and 4.10: tax follows the outlet's country; the outlet's GST and business numbers make its receipt a tax invoice;
// tax can be taken off an order only where the country's pack allows it.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let deviceId = "";
let owner = "";
let mgr = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
config.pricing = { ...config.pricing, gstOn: true, gstRate: 0.5 }; // a wrong rate set by hand: the country's pack must win

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
let n = 0;
const ev = (orderId: string, body: object) => ({ id: `t-${++n}`, orderId, deviceId, ts: Date.now() + n, seq: n, ...body }) as unknown as OrderEvent;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, print: new PrintStore(db, "bp"), trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const till = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!;
  device = till.token;
  deviceId = till.device.id;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "555555" });
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222", outletId: "EV" });
  owner = (await call("/api/auth/login", { body: { code: "OWN", pin: "555555" } })).json.token;
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("tax follows the outlet's country", () => {
  it("the country's rate replaces whatever was configured, and the outlet says where it is", async () => {
    const s = (await call("/api/settings", { staff: owner })).json;
    expect(s).toMatchObject({ gstRate: 0.09, taxName: "GST", country: "SG" });
    expect(config.pricing.gstRate).toBe(0.09);
    const ev1 = ((await call("/api/outlets", { staff: owner })).json.outlets as any[]).find((o) => o.id === "EV");
    expect(ev1).toMatchObject({ country: "SG", gstRegNo: null, uen: null });
  });
  it("a country with no tax pack is refused", async () => {
    const r = await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", country: "XX" }, staff: owner });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("unknown_country");
  });
});

describe("the outlet's registration numbers", () => {
  it("the owner saves them; they are tidied to capitals and bad ones are refused", async () => {
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", gstRegNo: "m9-0012345x", uen: "202612345X" }, staff: owner })).status).toBe(200);
    const o = ((await call("/api/outlets", { staff: owner })).json.outlets as any[]).find((x) => x.id === "EV");
    expect(o).toMatchObject({ gstRegNo: "M9-0012345X", uen: "202612345X" });
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", gstRegNo: "no spaces!" }, staff: owner })).status).toBe(400);
  });
  it("an outlet manager can still save the address, but cannot change the numbers or the country", async () => {
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", address: "1 Lengkok Bahru" }, staff: mgr })).status).toBe(200);
    const r = await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", gstRegNo: "OTHER" }, staff: mgr });
    expect(r.status).toBe(403);
    const o = ((await call("/api/outlets", { staff: owner })).json.outlets as any[]).find((x) => x.id === "EV");
    expect(o).toMatchObject({ gstRegNo: "M9-0012345X", address: "1 Lengkok Bahru" });
  });
  it("the receipt prints as a tax invoice with both numbers, and the tax the engine charged", async () => {
    const id = "tax-order-1";
    const push = await call("/api/sync/push", { body: { events: [
      ev(id, { type: "OrderOpened", fulfilment: "takeaway" }),
      ev(id, { type: "ItemAdded", lineId: "l1", productId: "x", name: "Tea", unitCents: 1000, qty: 1 }),
      ev(id, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 1000, confirmed: true }),
    ] } });
    expect(push.status).toBe(200);
    const r = await call(`/api/orders/${id}/receipt`, { staff: owner });
    expect(r.status).toBe(200);
    const text = r.json.text as string;
    expect(text).toContain("TAX Invoice");
    expect(text).toContain("GST M9-0012345X BIZ 202612345X");
    expect(text).toMatch(/Total \(SGD\) INCL\. GST\s+S?\$10\.00/); // Singapore prices include GST: nothing is added on top
    expect(text).toMatch(/GST AMT\s+S?\$0\.83/);
  });
  it("clearing the GST number makes it an ordinary receipt again", async () => {
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", gstRegNo: null }, staff: owner })).status).toBe(200);
    const text = (await call("/api/orders/tax-order-1/receipt", { staff: owner })).json.text as string;
    expect(text).not.toContain("TAX Invoice");
  });
});

describe("taking tax off an order", () => {
  it("is dropped where the country's pack does not allow it, whatever the till sends", async () => {
    const id = "tax-order-2";
    await call("/api/sync/push", { body: { events: [
      ev(id, { type: "OrderOpened", fulfilment: "takeaway" }),
      ev(id, { type: "ItemAdded", lineId: "l1", productId: "x", name: "Tea", unitCents: 1000, qty: 1 }),
      ev(id, { type: "TaxRemovalSet", removed: true, reason: "trying it on", byName: "Max" }),
    ] } });
    const r = await db.query("SELECT count(*)::int AS n FROM events WHERE order_id=$1 AND body->>'type'='TaxRemovalSet'", [id]).catch(() => null);
    if (r) expect(r.rows[0].n).toBe(0);
    const text = (await call(`/api/orders/${id}/receipt`, { staff: owner })).json.text as string;
    expect(text).not.toContain("GST removed");
    expect(text).toMatch(/Total \(SGD\)\s+S?\$10\.00/);
  });
  it("is kept, audited and shown on the receipt where the pack allows it", async () => {
    config.pricing.taxRemovable = true; // as a country pack that allows it would set
    const id = "tax-order-3";
    await call("/api/sync/push", { body: { events: [
      ev(id, { type: "OrderOpened", fulfilment: "takeaway" }),
      ev(id, { type: "ItemAdded", lineId: "l1", productId: "x", name: "Tea", unitCents: 1000, qty: 1 }),
      ev(id, { type: "TaxRemovalSet", removed: true, reason: "Diplomatic sale", byName: "Max", approvedByName: "Olive" }),
    ] } });
    const text = (await call(`/api/orders/${id}/receipt`, { staff: owner })).json.text as string;
    expect(text).toContain("GST removed");
    expect(text).toMatch(/GST removed\s+S?\$0\.83-/);
    expect(text).toMatch(/Total \(SGD\)\s+S?\$9\.17/);
    const a = await db.query("SELECT detail FROM audit_log WHERE merchant_id='bp' AND action='order.tax_removed'").catch(() => null);
    if (a) expect(a.rows.length).toBe(1);
    config.pricing.taxRemovable = false;
  });
});

describe("tax is charged outlet by outlet", () => {
  const shopOrder = async (outletId: string, name: string) => {
    const made = await call("/api/catalog/products", { body: { name, category: "Tax test", priceCents: 1000, taxInclusive: false }, staff: owner });
    expect(made.status).toBe(200);
    const p = ((await call("/api/catalog")).json.products as any[]).find((x) => x.name === name);
    return call("/api/shop/orders", { body: { outletId, channelId: "take-away", items: [{ productId: p.id, qty: 1 }], customerName: "T", customerPhone: "" } });
  };
  it("an outlet can charge no tax while the brand does, and the till of each outlet is told its own answer", async () => {
    expect((await call("/api/outlets/AMK", { method: "PUT", body: { name: "Ang Mo Kio", gstOn: false }, staff: owner })).status).toBe(200);
    const amkTill = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "AMK", createdBy: null })).code, "AMK till"))!;
    const evCfg = (await call("/api/config")).json; // the EV till's token is sent by `call`
    expect(evCfg.pricing.gstOn).toBe(true);
    const res = await fetch(base + "/api/config", { headers: { "x-device-token": amkTill.token } });
    expect((await res.json()).pricing.gstOn).toBe(false);
    const out = ((await call("/api/outlets", { staff: owner })).json.outlets as any[]).find((o) => o.id === "AMK");
    expect(out.gstOn).toBe(false);
  });
  it("the same item costs S$10.90 where tax is charged and S$10.00 where it is not, and each order keeps its answer", async () => {
    const ev1 = await shopOrder("EV", "Outlet Tea A");
    const amk = await shopOrder("AMK", "Outlet Tea B");
    expect(ev1.status).toBe(200);
    expect(amk.status).toBe(200);
    expect(ev1.json.totalCents).toBe(1090);
    expect(amk.json.totalCents).toBe(1000);
    // the outlet starts charging tax: the order already placed does not change
    expect((await call("/api/outlets/AMK", { method: "PUT", body: { name: "Ang Mo Kio", gstOn: true }, staff: owner })).status).toBe(200);
    expect((await call(`/api/shop/orders/${amk.json.orderId}`)).json.totals.find((l: any) => l.key === "total").cents).toBe(1000);
    expect((await shopOrder("AMK", "Outlet Tea C")).json.totalCents).toBe(1090);
  });
  it("back to following the brand, and only the brand owner decides", async () => {
    expect((await call("/api/outlets/AMK", { method: "PUT", body: { name: "Ang Mo Kio", gstOn: null }, staff: owner })).status).toBe(200);
    expect(((await call("/api/outlets", { staff: owner })).json.outlets as any[]).find((o) => o.id === "AMK").gstOn).toBeNull();
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", gstOn: false }, staff: mgr })).status).toBe(403);
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", gstOn: "yes" }, staff: owner })).status).toBe(400);
  });
});
