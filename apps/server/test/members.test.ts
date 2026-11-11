import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, orderTotals, reduceOrder } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { MemberStore } from "../src/members.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
config.rewards.stampCard = { enabled: true, target: 2, minPaidCents: 500, rewardTitle: "Free S$3", rewardCents: 300 };
let db: Db;
let stop: () => Promise<void>;
let proxied: Awaited<ReturnType<typeof buildApp>>;
let baseP = "";
let store: PgEventStore;
let till = { token: "", id: "" };
let ip = 0;

async function call(url: string, o: { method?: string; body?: unknown; bearer?: string; device?: string } = {}) {
  const res = await fetch(baseP + url, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(o.device ? { "x-device-token": o.device } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function signIn(email: string, name?: string) {
  const s = await call("/api/shop/auth/email/start", { body: { email } });
  const v = await call("/api/shop/auth/email/verify", { body: { email, code: s.json.devCode, name } });
  return v;
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  store = new PgEventStore(db, "bp", "EV");
  proxied = await buildApp({ config, db, logger: false, store, catalog: cat, catalogAdmin: cat, trustProxy: true });
  await proxied.listen({ port: 0, host: "127.0.0.1" });
  baseP = `http://127.0.0.1:${(proxied.server.address() as { port: number }).port}`;
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  const e = (await enroll(db, "bp", c.code, "Till"))!;
  till = { token: e.token, id: e.device.id };
}, 120_000);
afterAll(async () => {
  await proxied?.close();
  await stop?.();
});

const kaya = (qty = 1) => ({ productId: "kaya-toast", qty });
const place = (body: object, bearer?: string) => call("/api/shop/orders", { body: { channelId: "take-away", items: [kaya(5)], customerPhone: "9123 4567", ...body }, bearer });

describe("customer accounts", () => {
  it("a new email becomes a member with the welcome points, once", async () => {
    const a = await signIn("Ann@Example.com", "Ann");
    expect(a.status).toBe(200);
    expect(a.json.created).toBe(true);
    expect(a.json.member).toMatchObject({ email: "ann@example.com", name: "Ann", pointsBalance: 500 });
    const b = await signIn("ann@example.com");
    expect(b.json.created).toBe(false);
    expect(b.json.member.pointsBalance).toBe(500); // never re-credited
    const me = await call("/api/shop/me", { bearer: b.json.token });
    expect(me.json.member.pointsBalance).toBe(500);
    expect(me.json.history).toHaveLength(1);
  });

  it("a wrong or reused code does not sign in", async () => {
    const s = await call("/api/shop/auth/email/start", { body: { email: "bob@example.com" } });
    expect((await call("/api/shop/auth/email/verify", { body: { email: "bob@example.com", code: "000000" } })).status).toBe(401);
    const ok = await call("/api/shop/auth/email/verify", { body: { email: "bob@example.com", code: s.json.devCode } });
    expect(ok.status).toBe(200);
    expect((await call("/api/shop/auth/email/verify", { body: { email: "bob@example.com", code: s.json.devCode } })).status).toBe(401); // single use
  });

  it("five wrong codes lock that code", async () => {
    const s = await call("/api/shop/auth/email/start", { body: { email: "cy@example.com" } });
    for (let i = 0; i < 5; i++) await call("/api/shop/auth/email/verify", { body: { email: "cy@example.com", code: "111111" } });
    expect((await call("/api/shop/auth/email/verify", { body: { email: "cy@example.com", code: s.json.devCode } })).status).toBe(401);
  });

  it("refuses a bad email, and /me needs a session", async () => {
    expect((await call("/api/shop/auth/email/start", { body: { email: "nope" } })).status).toBe(400);
    expect((await call("/api/shop/me")).status).toBe(401);
    expect((await call("/api/shop/me", { bearer: "garbage" })).status).toBe(401);
  });

  it("logout ends the session", async () => {
    const v = await signIn("dee@example.com");
    await call("/api/shop/auth/logout", { body: {}, bearer: v.json.token });
    expect((await call("/api/shop/me", { bearer: v.json.token })).status).toBe(401);
  });
});

describe("points on orders", () => {
  it("a guest cannot use points", async () => {
    expect((await place({ usePoints: "max" })).status).toBe(401);
  });

  it("spending points lowers the total, is frozen on the order, and leaves the balance reduced", async () => {
    const v = await signIn("eve@example.com");
    const t = v.json.token;
    const full = await place({}, t);
    expect(full.json.totalCents).toBe(1000); // 5 x 2.00
    const r = await place({ usePoints: 200 }, t);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ pointsUsed: 200, totalCents: 800 });
    const o = reduceOrder(r.json.orderId, await store.eventsForOrder(r.json.orderId))!;
    expect(o.pointsRedeemed).toBe(200);
    expect(orderTotals(o, config).total).toBe(800);
    expect((await call("/api/shop/me", { bearer: t })).json.member.pointsBalance).toBe(300);
  });

  it("'max' spends what is usable, never more than the balance, and the minimum is enforced", async () => {
    const t = (await signIn("fay@example.com")).json.token; // 500 points
    expect((await place({ usePoints: 50 }, t)).json.error).toBe("points_too_low");
    const r = await place({ usePoints: "max" }, t);
    expect(r.json.pointsUsed).toBe(500);
    expect(r.json.totalCents).toBe(500);
    expect((await place({ usePoints: "max" }, t)).json.pointsUsed ?? 0).toBe(0); // nothing left; ordered at full price
  });

  it("cancelling an order gives the points back, once", async () => {
    const t = (await signIn("gus@example.com")).json.token;
    const r = await place({ usePoints: 300 }, t);
    expect((await call("/api/shop/me", { bearer: t })).json.member.pointsBalance).toBe(200);
    const ev = { id: "cx1", orderId: r.json.orderId, deviceId: till.id, ts: Date.now(), seq: 1, type: "StageSet", stage: "cancelled" };
    await call("/api/sync/push", { body: { events: [ev] }, device: till.token });
    await call("/api/sync/push", { body: { events: [{ ...ev, id: "cx2", seq: 2 }] }, device: till.token });
    expect((await call("/api/shop/me", { bearer: t })).json.member.pointsBalance).toBe(500);
  });

  it("points are earned on what is actually paid, once, only when fully paid", async () => {
    const t = (await signIn("hal@example.com")).json.token;
    const r = await place({ usePoints: 200, items: [kaya(10)] }, t); // 10 x 2.00 = 20.00 - 2.00 = 18.00
    expect(r.json.totalCents).toBe(1800);
    const pay = (id: string, amountCents: number) => ({ id, orderId: r.json.orderId, deviceId: till.id, ts: Date.now(), seq: 5, type: "PaymentRecorded", paymentId: id, method: "cash", amountCents, confirmed: true });
    await call("/api/sync/push", { body: { events: [pay("p1", 1000)] }, device: till.token });
    expect((await call("/api/shop/me", { bearer: t })).json.member.pointsBalance).toBe(300); // part-paid: nothing yet
    await call("/api/sync/push", { body: { events: [pay("p2", 800)] }, device: till.token });
    await call("/api/sync/push", { body: { events: [pay("p3", 1)] }, device: till.token }); // later event: still once
    expect((await call("/api/shop/me", { bearer: t })).json.member.pointsBalance).toBe(300 + 18); // floor(18.01 paid) x 1 pt per S$1
  });
});

describe("coupons", () => {
  const wallet = async (t: string) => (await call("/api/shop/me", { bearer: t })).json.coupons as Array<{ id: string; title: string; amountCents: number; minSpendCents: number }>;

  it("a new member gets the S$2 welcome voucher with no minimum spend, once", async () => {
    const v = await signIn("ivy@example.com");
    const w = await wallet(v.json.token);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ amountCents: 200, minSpendCents: 0 });
    expect(await wallet((await signIn("ivy@example.com")).json.token)).toHaveLength(1); // signing in again grants nothing
  });

  it("using it takes S$2 off, uses it up, and a second order cannot reuse it", async () => {
    const t = (await signIn("jon@example.com")).json.token;
    const [c] = await wallet(t);
    const r = await place({ couponId: c!.id }, t);
    expect(r.json).toMatchObject({ totalCents: 800, couponDiscountCents: 200 }); // 5 x 2.00 - 2.00
    const o = reduceOrder(r.json.orderId, await store.eventsForOrder(r.json.orderId))!;
    expect(o.coupon).toMatchObject({ amountCents: 200 });
    expect(orderTotals(o, config).total).toBe(800);
    expect(await wallet(t)).toHaveLength(0);
    expect((await place({ couponId: c!.id }, t)).json.error).toBe("coupon_not_available");
  });

  it("minimum spend is on the items subtotal only: service and deposit do not count", async () => {
    const t = (await signIn("kai@example.com")).json.token;
    const me = (await call("/api/shop/me", { bearer: t })).json.member;
    await new MemberStore(db, "bp", 0, 0).grantCoupon(me.id, "min20", { title: "S$3 off, min S$20", amountCents: 300, minSpendCents: 2000 });
    const c = (await wallet(t)).find((x) => x.minSpendCents === 2000)!;
    const low = await place({ couponId: c.id, items: [kaya(9)] }, t); // items S$18.00
    expect(low.status).toBe(400);
    expect(low.json).toMatchObject({ error: "coupon_not_eligible", shortfallCents: 200 });
    expect((await wallet(t)).some((x) => x.id === c.id)).toBe(true); // still there
    const ok = await place({ couponId: c.id, items: [kaya(10)] }, t); // items S$20.00
    expect(ok.status).toBe(200);
    expect(ok.json.totalCents).toBe(1700);
  });

  it("works together with points (promotions stack by default)", async () => {
    const t = (await signIn("lee@example.com")).json.token;
    const [c] = await wallet(t);
    const r = await place({ couponId: c!.id, usePoints: 300 }, t);
    expect(r.json).toMatchObject({ couponDiscountCents: 200, pointsUsed: 300, totalCents: 500 });
  });

  it("cancelling the order releases the coupon again", async () => {
    const t = (await signIn("mia@example.com")).json.token;
    const [c] = await wallet(t);
    const r = await place({ couponId: c!.id }, t);
    expect(await wallet(t)).toHaveLength(0);
    await call("/api/sync/push", { body: { events: [{ id: "cc1", orderId: r.json.orderId, deviceId: till.id, ts: Date.now(), seq: 1, type: "StageSet", stage: "cancelled" }] }, device: till.token });
    expect(await wallet(t)).toHaveLength(1);
  });

  it("a guest cannot use a coupon, and a made-up id is refused", async () => {
    expect((await place({ couponId: "00000000-0000-0000-0000-000000000000" })).status).toBe(401);
    const t = (await signIn("ned@example.com")).json.token;
    expect((await place({ couponId: "00000000-0000-0000-0000-000000000000" }, t)).json.error).toBe("coupon_not_available");
  });
});

describe("stamp cards", () => {
  const pay = (orderId: string, id: string, amountCents: number) =>
    call("/api/sync/push", { body: { events: [{ id, orderId, deviceId: till.id, ts: Date.now(), seq: 7, type: "PaymentRecorded", paymentId: id, method: "cash", amountCents, confirmed: true }] }, device: till.token });
  const me = async (t: string) => (await call("/api/shop/me", { bearer: t })).json;

  it("a paid order that reaches the minimum earns a stamp; a full card gives the reward voucher and starts again", async () => {
    const t = (await signIn("ora@example.com")).json.token;
    expect((await me(t)).stamps).toMatchObject({ count: 0, target: 2 });
    const a = await place({ items: [kaya(5)] }, t); // S$10.00
    await pay(a.json.orderId, "s1", 1000);
    expect((await me(t)).stamps.count).toBe(1);
    await pay(a.json.orderId, "s1b", 1); // a later payment on the same order does not stamp again
    expect((await me(t)).stamps.count).toBe(1);
    const b = await place({ items: [kaya(5)] }, t);
    await pay(b.json.orderId, "s2", 1000);
    const m = await me(t);
    expect(m.stamps).toMatchObject({ count: 0, completed: 1 });
    expect(m.coupons.some((c: any) => c.title === "Free S$3" && c.amountCents === 300)).toBe(true);
  });

  it("an order below the minimum, or a free one, earns no stamp", async () => {
    const t = (await signIn("pat@example.com")).json.token;
    const small = await place({ items: [kaya(1)] }, t); // S$2.00 < S$5.00
    await pay(small.json.orderId, "s3", 200);
    expect((await me(t)).stamps.count).toBe(0);
    const [c] = (await me(t)).coupons;
    const free = await place({ items: [kaya(1)], couponId: c.id }, t); // covered by the welcome voucher
    expect(free.json.totalCents).toBe(0);
    expect((await me(t)).stamps.count).toBe(0);
  });

  it("is not reported when the merchant has no stamp card", async () => {
    config.rewards.stampCard.enabled = false;
    const t = (await signIn("quin@example.com")).json.token;
    expect((await me(t)).stamps).toBeNull();
    config.rewards.stampCard.enabled = true;
  });
});
