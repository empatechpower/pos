import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, type OrderEvent } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// Handout 4.6: a member attached at the till owns the order (history, points earned), and their points can pay at the till.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let deviceId = "";
let mgr = "";
let cashier = "";
let memberId = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

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
const ev = (orderId: string, body: object) => ({ id: `m-${++n}`, orderId, deviceId, ts: Date.now() + n, seq: n, ...body }) as unknown as OrderEvent;
const push = (events: OrderEvent[]) => call("/api/sync/push", { body: { events } });
const summary = async () => (await call(`/api/members/${memberId}/summary`, { staff: cashier })).json;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const till = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!;
  device = till.token; deviceId = till.device.id;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "CAT", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "CAT", pin: "3333" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("a member at the till", () => {
  it("a cashier adds a member and finds them again by phone", async () => {
    const made = await call("/api/members", { body: { name: "Mei Ling", phone: "+65 8123 4567" }, staff: cashier });
    expect(made.status).toBe(200);
    memberId = made.json.member.id;
    const found = await call("/api/members?q=81234567", { staff: cashier });
    expect(found.json.members.map((m: any) => m.id)).toContain(memberId);
    const s = await summary();
    expect(s.member).toMatchObject({ id: memberId, name: "Mei Ling" });
    expect(s.rewards.pointsEnabled).toBe(true);
    expect(s.recent).toEqual([]);
  });

  it("an order attached to them shows in their history and earns points when it is paid", async () => {
    const before = (await summary()).member.points as number;
    expect((await push([
      ev("mo-1", { type: "OrderOpened", fulfilment: "takeaway" }),
      ev("mo-1", { type: "ItemAdded", lineId: "l1", productId: "x", name: "Kaya Toast", unitCents: 1250, qty: 2 }),
      ev("mo-1", { type: "MemberAttached", memberId, byName: "Cat" }),
      ev("mo-1", { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 2500, confirmed: true }),
    ])).status).toBe(200);
    const s = await summary();
    expect(s.recent[0]).toMatchObject({ orderId: "mo-1", totalCents: 2500, status: "paid", items: "2× Kaya Toast" });
    expect(s.member.points).toBe(before + 25); // 1 point per dollar paid
  });

  it("a made-up member id is dropped: the order belongs to nobody", async () => {
    await push([
      ev("mo-2", { type: "OrderOpened", fulfilment: "takeaway" }),
      ev("mo-2", { type: "ItemAdded", lineId: "l1", productId: "x", name: "Tea", unitCents: 200, qty: 1 }),
      ev("mo-2", { type: "MemberAttached", memberId: "11111111-2222-3333-4444-555555555555" }),
    ]);
    const r = await db.query("SELECT count(*)::int AS n FROM member_orders WHERE order_id='mo-2'");
    expect(r.rows[0].n).toBe(0);
  });

  it("points pay at the till: taken once, the total falls, and cancelling the order gives them back", async () => {
    expect((await call(`/api/members/${memberId}/points`, { body: { points: 1000, note: "test top-up", idempotencyKey: "t1" }, staff: mgr })).status).toBe(200);
    const start = (await summary()).member.points as number;
    const take = await call(`/api/members/${memberId}/redeem`, { body: { points: 300, orderId: "mo-3" }, staff: cashier });
    expect(take.status).toBe(200);
    expect(take.json.points).toBe(start - 300);
    // the same request again (a retry after a dropped connection) takes nothing more
    expect((await call(`/api/members/${memberId}/redeem`, { body: { points: 300, orderId: "mo-3" }, staff: cashier })).json).toMatchObject({ points: start - 300, replayed: true });
    await push([
      ev("mo-3", { type: "OrderOpened", fulfilment: "takeaway" }),
      ev("mo-3", { type: "ItemAdded", lineId: "l1", productId: "x", name: "Set Lunch", unitCents: 1000, qty: 1 }),
      ev("mo-3", { type: "MemberAttached", memberId }),
      ev("mo-3", { type: "PointsRedeemed", points: 300 }),
      ev("mo-3", { type: "PaymentRecorded", paymentId: "p3", method: "cash", amountCents: 700, confirmed: true }),
    ]);
    const paid = await summary();
    expect(paid.recent[0]).toMatchObject({ orderId: "mo-3", totalCents: 700, status: "paid" });
    expect(paid.member.points).toBe(start - 300 + 7); // earned on the S$7.00 actually paid
    await push([ev("mo-3", { type: "StageSet", stage: "cancelled" })]);
    expect((await summary()).member.points).toBeGreaterThanOrEqual(start); // the 300 came back
  });

  it("more points than they have is refused, and nothing is taken", async () => {
    const have = (await summary()).member.points as number;
    const r = await call(`/api/members/${memberId}/redeem`, { body: { points: have + 1, orderId: "mo-4" }, staff: cashier });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("not_enough_points");
    expect((await summary()).member.points).toBe(have);
    expect((await call(`/api/members/${memberId}/redeem`, { body: { points: 0, orderId: "mo-4" }, staff: cashier })).status).toBe(400);
  });
});

describe("member prices in a pricebook", () => {
  it("a manager sets one, it is served with the menu, and it can be cleared", async () => {
    const cat = (await call("/api/catalog")).json;
    const book = cat.defaultPricebookId as string;
    const item = (cat.products as any[]).find((p) => cat.pricebooks.find((b: any) => b.id === book).prices[p.id] >= 100);
    const price = cat.pricebooks.find((b: any) => b.id === book).prices[item.id] as number;
    const set = await call(`/api/catalog/pricebooks/${book}/bulk`, { body: { memberPrices: { [item.id]: price - 20 } }, staff: mgr });
    expect(set.status).toBe(200);
    expect((await call("/api/catalog")).json.pricebooks.find((b: any) => b.id === book).memberPrices[item.id]).toBe(price - 20);
    // never above the price, and a cashier cannot set one
    expect((await call(`/api/catalog/pricebooks/${book}/bulk`, { body: { memberPrices: { [item.id]: price + 1 } }, staff: mgr })).status).toBe(400);
    expect((await call(`/api/catalog/pricebooks/${book}/bulk`, { body: { memberPrices: { [item.id]: 1 } }, staff: cashier })).status).toBe(403);
    expect((await call(`/api/catalog/pricebooks/${book}/bulk`, { body: { memberPrices: { [item.id]: null } }, staff: mgr })).status).toBe(200);
    expect((await call("/api/catalog")).json.pricebooks.find((b: any) => b.id === book).memberPrices?.[item.id]).toBeUndefined();
  });
});

