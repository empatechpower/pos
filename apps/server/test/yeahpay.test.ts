import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, confirmedPaid, orderTotals, reduceOrder } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { PgEventStore } from "../src/pgStore.js";
import { loadIntegrations, verifyYeahpayCallback, yeahpaySignature, YEAHPAY_LIVE, YEAHPAY_TEST, type Integrations } from "../src/integrations.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let store: PgEventStore;
let ip = 0;

const sent: { url: string; headers: Headers; body: any; raw: string }[] = [];
const fake = { ok: true };
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const raw = String(init?.body ?? "");
  sent.push({ url: u, headers: new Headers(init?.headers), body: raw ? JSON.parse(raw) : null, raw });
  if (!fake.ok) return new Response(JSON.stringify({ code: 1001, message: "bad" }));
  if (u.endsWith("/order/unifiedOrder")) return new Response(JSON.stringify({ code: 0, message: "Success", data: { tdCode: "00020101021226PAYNOWQR", leshuaOrderId: "L1" } }));
  if (u.endsWith("/cardOrder/getRedirectUrl")) return new Response(JSON.stringify({ code: 0, message: "Success", data: { url: "https://cashier.example.yeahpay.sg/h5?token=abc" } }));
  if (u.endsWith("/unified/reversalOperation")) return new Response(JSON.stringify({ code: 0, message: "Success", data: {} }));
  return new Response("?", { status: 500 });
}) as typeof fetch;

const integrations: Integrations = {
  publicUrl: "https://shop.example",
  yeahpay: { appId: "1000122333", apiKey: "k3y", merchantId: "4569329268", baseUrl: YEAHPAY_LIVE },
  fetch: fakeFetch,
};
const NOTIFY = "https://shop.example/api/shop/yeahpay/notify";

async function call(url: string, o: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + url, {
    method: o.body !== undefined || o.raw !== undefined ? "POST" : "GET",
    headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.raw !== undefined ? { "content-type": "application/json" } : {}), ...o.headers },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  store = new PgEventStore(db, "bp", "EV");
  app = await buildApp({ config, db, logger: false, store, catalog: cat, catalogAdmin: cat, trustProxy: true, integrations });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}, 120_000);
afterAll(async () => { await app?.close(); await stop?.(); });

const place = () => call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 5 }], customerPhone: "9123 4567" } });
const orderState = async (id: string) => reduceOrder(id, await store.eventsForOrder(id))!;

/** A callback as YeahPay would send it: signed with the key over the callback address and the exact body. */
const callback = (notice: object, over: { key?: string; timestamp?: string; url?: string } = {}) => {
  const raw = JSON.stringify(notice);
  const timestamp = over.timestamp ?? String(Date.now());
  const nonce = "abc123";
  const signature = yeahpaySignature({ url: over.url ?? NOTIFY, appId: "1000122333", timestamp, nonce, body: raw, apiKey: over.key ?? "k3y" });
  return call("/api/shop/yeahpay/notify", { raw, headers: { appId: "1000122333", timestamp, nonce, version: "1.0", algorithm: "SHA-512", signature } });
};
const paidNotice = (orderId: string, leshua: string, amount: number, extra: object = {}) => ({ amount: String(amount), attach: orderId, leshuaOrderId: leshua, merchantId: "4569329268", payWay: "PayNowPay", status: "2", thirdOrderId: "REF1", tradeType: "NATIVE", currency: "SGD", settlementAmount: String(amount), ...extra });

describe("YeahPay signing", () => {
  it("matches the worked example in YeahPay's own documentation", () => {
    const body = '{\n "merchantId": "4569329268"\n}';
    const sig = yeahpaySignature({ url: "/acceptance-open-api/order/unifiedOrder", appId: "1000122333", timestamp: "1694082355494", nonce: "FGHUdssdfs5sEDF", body, apiKey: "1Ed1pKTPDkbkX6xptxZMzUXdMuWnFkxdqV27g+3UhBA=" });
    expect(sig).toBe("KjCHuCjVSySmzO2797jJDERsuJgeKMWgIKhFreesCqVfSJNHPKfJxYtGFz6P417dx0yv3IvD+SgMXlDWY1+A+w==");
  });

  it("is switched on only by its settings, and can point at the test address", () => {
    expect(loadIntegrations({}).yeahpay).toBeUndefined();
    expect(loadIntegrations({ YEAHPAY_APP_ID: "a", YEAHPAY_API_KEY: "k" }).yeahpay).toBeUndefined();
    const on = loadIntegrations({ YEAHPAY_APP_ID: "a", YEAHPAY_API_KEY: "k", YEAHPAY_MERCHANT_ID: "m" }).yeahpay!;
    expect(on.baseUrl).toBe(YEAHPAY_LIVE);
    expect(loadIntegrations({ YEAHPAY_APP_ID: "a", YEAHPAY_API_KEY: "k", YEAHPAY_MERCHANT_ID: "m", YEAHPAY_ENV: "test" }).yeahpay!.baseUrl).toBe(YEAHPAY_TEST);
  });

  it("rejects a callback with a wrong key, wrong address, tampered body or an old timestamp", () => {
    const raw = '{"status":"2"}';
    const mk = (o: { key?: string; url?: string; timestamp?: string }) => ({ url: NOTIFY, rawBody: raw, headers: { appid: "1000122333", timestamp: o.timestamp ?? String(Date.now()), nonce: "n", signature: yeahpaySignature({ url: o.url ?? NOTIFY, appId: "1000122333", timestamp: o.timestamp ?? "", nonce: "n", body: raw, apiKey: o.key ?? "k3y" }) } });
    const ts = String(Date.now());
    expect(verifyYeahpayCallback(integrations, mk({ timestamp: ts }))).toBe(true);
    expect(verifyYeahpayCallback(integrations, mk({ timestamp: ts, key: "other" }))).toBe(false);
    expect(verifyYeahpayCallback(integrations, mk({ timestamp: ts, url: "https://evil.example/x" }))).toBe(false);
    expect(verifyYeahpayCallback(integrations, { ...mk({ timestamp: ts }), rawBody: '{"status":"2","x":1}' })).toBe(false);
    const old = String(Date.now() - 3_600_000);
    expect(verifyYeahpayCallback(integrations, mk({ timestamp: old }))).toBe(false);
  });
});

describe("paying with YeahPay", () => {
  it("tells the shop what it can do", async () => {
    expect((await call("/api/shop/info")).json.payments).toEqual({ online: true, methods: ["card", "paynow"], paynowQr: false });
  });

  it("asks for a PayNow QR for exactly what is owed, with signed headers", async () => {
    const o = await place();
    sent.length = 0;
    const r = await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "paynow", display: "qr" } });
    expect(r.json.url).toBe("00020101021226PAYNOWQR");
    const s = sent.at(-1)!;
    expect(s.url).toBe(`${YEAHPAY_LIVE}/order/unifiedOrder`);
    expect(s.body).toMatchObject({ payWay: "PayNowPay", merchantId: "4569329268", amount: String(o.json.totalCents), currency: "SGD", jspayFlag: "NATIVE", attach: o.json.orderId, notifyUrl: NOTIFY });
    expect(s.headers.get("appid")).toBe("1000122333");
    expect(s.headers.get("algorithm")).toBe("SHA-512");
    expect(s.headers.get("version")).toBe("1.0");
    expect(s.headers.get("signature")).toBe(yeahpaySignature({ url: "/acceptance-open-api/order/unifiedOrder", appId: "1000122333", timestamp: s.headers.get("timestamp")!, nonce: s.headers.get("nonce")!, body: s.raw, apiKey: "k3y" }));
    expect(s.body.thirdOrderId).toMatch(/^[0-9a-z]+$/i);
  });

  it("sends the phone shop to YeahPay's checkout page for card", async () => {
    const o = await place();
    sent.length = 0;
    const r = await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "card" } });
    expect(r.json.url).toBe("https://cashier.example.yeahpay.sg/h5?token=abc");
    expect(sent.at(-1)!.body).toMatchObject({ merchantId: "4569329268", amount: String(o.json.totalCents), currency: "SGD", merchantReferenceNumber: o.json.orderId, callback: `https://shop.example/shop/order/${o.json.orderId}`, notifyUrl: NOTIFY });
  });

  it("reports a provider failure without recording anything", async () => {
    const o = await place();
    fake.ok = false;
    const r = await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "paynow", display: "qr" } });
    fake.ok = true;
    expect(r.status).toBe(502);
  });

  it("records a signed payment once and the order then counts as paid", async () => {
    const o = await place();
    const n = paidNotice(o.json.orderId, "L100", o.json.totalCents);
    expect((await callback(n)).text).toBe("success");
    expect((await callback(n)).text).toBe("success"); // YeahPay repeats itself
    const st = await orderState(o.json.orderId);
    expect(st.payments).toEqual([{ paymentId: "yeahpay:L100", method: "paynow", amountCents: o.json.totalCents, confirmed: true }]);
    expect(confirmedPaid(st)).toBe(orderTotals(st, config).total);
    expect((await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "card" } })).status).toBe(409);
  });

  it("finds the order from our own reference when the callback carries no note, and records a card payment", async () => {
    const o = await place();
    const ref = `${o.json.orderId.replace(/-/g, "")}abc123`;
    expect((await callback(paidNotice(o.json.orderId, "L101", o.json.totalCents, { attach: "", thirdOrderId: ref, payWay: "VISA", tradeType: "ONLINE_CARD" }))).text).toBe("success");
    expect((await orderState(o.json.orderId)).payments).toEqual([{ paymentId: "yeahpay:L101", method: "card", amountCents: o.json.totalCents, confirmed: true }]);
  });

  it("does not believe an unsigned, wrongly keyed, stale or unpaid message", async () => {
    const o = await place();
    const n = paidNotice(o.json.orderId, "L102", o.json.totalCents);
    expect((await call("/api/shop/yeahpay/notify", { raw: JSON.stringify(n) })).status).toBe(400);
    expect((await callback(n, { key: "wrong" })).status).toBe(400);
    expect((await callback(n, { timestamp: String(Date.now() - 3_600_000) })).status).toBe(400);
    await callback(paidNotice(o.json.orderId, "L103", o.json.totalCents, { status: "0" })); // not yet paid
    expect((await orderState(o.json.orderId)).payments).toEqual([]);
  });

  it("gives back a payment that does not fit the order, and records nothing", async () => {
    const o = await place();
    sent.length = 0;
    expect((await callback(paidNotice(o.json.orderId, "L104", o.json.totalCents - 1))).text).toBe("success");
    expect((await orderState(o.json.orderId)).payments).toEqual([]);
    expect(sent.at(-1)!.url).toBe(`${YEAHPAY_LIVE}/unified/reversalOperation`);
    expect(sent.at(-1)!.body).toMatchObject({ sceneType: 1, merchantId: "4569329268", leshuaOrderId: "L104", merchantRefundId: "refundL104" });
    // An unknown order is refunded too.
    sent.length = 0;
    await callback(paidNotice("00000000-0000-4000-8000-000000000000", "L105", 500));
    expect(sent.at(-1)!.body.leshuaOrderId).toBe("L105");
  });
});
