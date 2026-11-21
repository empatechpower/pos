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

// Backend handout section 10 and fixture 12: promo codes judged on the items subtotal, accepted or rejected with a reason, limits, and the cancel giving a use back.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let evMgr = "";
let clock = Date.parse("2026-11-20T10:00:00+08:00");
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
const at = (iso: string) => Date.parse(iso);

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

let cheapId = "";
let bigId = "";
const order = (items: Array<{ productId: string; qty: number }>, extra: object = {}) =>
  call("/api/shop/orders", { body: { channelId: "take-away", outletId: "EV", items, customerName: "T", customerPhone: "", ...extra } });
const validate = (items: Array<{ productId: string; qty: number }>, code: string, channelId = "take-away") =>
  call("/api/shop/promo/validate", { body: { outletId: "EV", channelId, items, code } });
const save = (code: string, body: object) => call(`/api/promos/${code}`, { method: "PUT", body: { title: "Promo", kind: "amount", value: 500, ...body }, staff: owner });

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
  await call("/api/catalog/products", { body: { name: "Promo Toast", category: "Toast", priceCents: 1950 }, staff: owner });
  await call("/api/catalog/products", { body: { name: "Promo Bowl", category: "Bowls", priceCents: 3000 }, staff: owner });
  const products = (await call("/api/catalog")).json.products as any[];
  cheapId = products.find((p) => p.name === "Promo Toast").id;
  bigId = products.find((p) => p.name === "Promo Bowl").id;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("promo codes", () => {
  it("only managers manage codes, and a code must be set up sensibly", async () => {
    expect((await call("/api/promos/NOPE", { method: "PUT", body: { title: "x", kind: "amount", value: 100 }, staff: evMgr })).status).toBe(403);
    expect((await save("AB", {})).status).toBe(400); // too short
    expect((await save("PCT", { kind: "percent", value: 150 })).status).toBe(400);
    expect((await save("PCT", { value: 0 })).status).toBe(400);
    expect((await save("PCT", { startsAt: "2026-12-02", endsAt: "2026-12-01" })).status).toBe(400);
    expect((await save("SAVE5", { title: "S$5 off", minSpendCents: 2000 })).status).toBe(200);
    const list = (await call("/api/promos", { staff: owner })).json;
    expect(list.basis).toContain("before service charge, tax and deposits");
    expect(list.promos.find((p: any) => p.code === "SAVE5")).toMatchObject({ kind: "amount", value: 500, minSpendCents: 2000, uses: 0 });
  });

  it("rejects with a reason, never silently: unknown, inactive", async () => {
    expect((await validate([{ productId: bigId, qty: 1 }], "NOSUCH")).json).toMatchObject({ ok: false, reason: "unknown" });
    await save("OFF1", { active: false });
    expect((await validate([{ productId: bigId, qty: 1 }], "off1")).json).toMatchObject({ ok: false, reason: "inactive" });
  });

  it("fixture 12: the minimum is judged on the items subtotal, not on a total that charges have lifted", async () => {
    // Items S$19.50 on dine-in: the service charge takes the total past S$20, but the minimum is on the items.
    const r = (await validate([{ productId: cheapId, qty: 1 }], "SAVE5", "dine-in")).json;
    expect(r).toMatchObject({ ok: false, reason: "below_minimum", minSpendCents: 2000, shortfallCents: 50 });
    expect(r.basis).toContain("items subtotal before service charge, tax and deposits");
    const refused = await order([{ productId: cheapId, qty: 1 }], { promoCode: "SAVE5", channelId: "dine-in" });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: "promo_rejected", reason: "below_minimum" });
    const ok = (await validate([{ productId: bigId, qty: 1 }], "save5")).json; // typed in lower case is fine
    expect(ok).toMatchObject({ ok: true, code: "SAVE5", discountCents: 500, itemsSubtotalCents: 3000 });
  });

  it("takes the discount off the order, and records it on the order", async () => {
    await save("TEN", { title: "10% off", kind: "percent", value: 10 });
    const r = await order([{ productId: bigId, qty: 1 }], { promoCode: "ten" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ totalCents: 2700, couponDiscountCents: 300, promoCode: "TEN" });
    const ev = (await db.query("SELECT body FROM events WHERE merchant_id='bp' AND order_id=$1 AND type='CouponApplied'", [r.json.orderId])).rows[0].body;
    expect(ev).toMatchObject({ title: "Code TEN", amountCents: 300 });
    expect((await call("/api/promos", { staff: owner })).json.promos.find((p: any) => p.code === "TEN")).toMatchObject({ uses: 1, discountedCents: 300 });
    const bad = await order([{ productId: bigId, qty: 1 }], { promoCode: "NOSUCH" });
    expect(bad.json).toMatchObject({ error: "promo_rejected", reason: "unknown" });
  });

  it("the window and the usage limits, and a cancelled order gives its use back", async () => {
    await save("SOON", { startsAt: "2099-01-01T00:00:00Z" });
    expect((await validate([{ productId: bigId, qty: 1 }], "SOON")).json.reason).toBe("not_started");
    await save("GONE", { endsAt: "2020-01-01T00:00:00Z" });
    expect((await validate([{ productId: bigId, qty: 1 }], "GONE")).json.reason).toBe("expired");
    await save("ONCE", { maxUses: 1 });
    const first = await order([{ productId: bigId, qty: 1 }], { promoCode: "ONCE" });
    expect(first.status).toBe(200);
    expect((await order([{ productId: bigId, qty: 1 }], { promoCode: "ONCE" })).json).toMatchObject({ error: "promo_rejected", reason: "usage_exhausted" });
    expect((await call(`/api/shop/orders/${first.json.orderId}/cancel`, { method: "POST" })).status).toBe(200);
    expect((await order([{ productId: bigId, qty: 1 }], { promoCode: "ONCE" })).status).toBe(200); // the cancelled order's use was returned
  });

  it("a per-member limit needs a signed-in member, so a guest is asked to sign in", async () => {
    await save("MEMBER1", { maxPerMember: 1 });
    expect((await validate([{ productId: bigId, qty: 1 }], "MEMBER1")).json).toMatchObject({ ok: false, reason: "sign_in_required" });
  });

  it("the stacking setting is off by default and can be changed by a manager", async () => {
    expect((await call("/api/promo/settings", { staff: owner })).json.stackWithCoupons).toBe(false);
    expect((await call("/api/promo/settings", { method: "PUT", body: { stackWithCoupons: true }, staff: owner })).json.stackWithCoupons).toBe(true);
    expect((await call("/api/promo/settings", { method: "PUT", body: { stackWithCoupons: "yes" }, staff: owner })).status).toBe(400);
    await call("/api/promo/settings", { method: "PUT", body: { stackWithCoupons: false }, staff: owner });
  });
});
