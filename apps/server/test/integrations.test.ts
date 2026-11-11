import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, confirmedPaid, orderTotals, reduceOrder } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { verifyStripeSignature, type Integrations } from "../src/integrations.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bare: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let baseBare = "";
let mailed: Awaited<ReturnType<typeof buildApp>>;
let baseMailed = "";
let store: PgEventStore;
let till = { token: "", id: "" };
let ip = 0;

/** What the outside services would say. Tests change these to play different people. */
const fake = {
  profile: { sub: "g-1", email: "gina@example.com", email_verified: true, name: "Gina" } as Record<string, unknown>,
  tokenOk: true,
  stripeBodies: [] as string[],
  refunds: [] as { body: string; key: string | null }[],
  mails: [] as any[],
};
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("/token")) return fake.tokenOk ? new Response(JSON.stringify({ access_token: "at" })) : new Response("no", { status: 400 });
  if (u.includes("userinfo")) return new Response(JSON.stringify(fake.profile));
  if (u.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
    fake.stripeBodies.push(String(init?.body));
    return new Response(JSON.stringify({ id: `cs_${fake.stripeBodies.length}`, url: `https://pay.example/cs_${fake.stripeBodies.length}` }));
  }
  if (u === "https://api.stripe.com/v1/refunds") {
    fake.refunds.push({ body: String(init?.body), key: new Headers(init?.headers).get("idempotency-key") });
    return new Response(JSON.stringify({ id: "re_1" }));
  }
  if (u === "https://api.resend.com/emails") {
    fake.mails.push({ auth: new Headers(init?.headers).get("authorization"), ...JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "m_1" }));
  }
  return new Response("?", { status: 500 });
}) as typeof fetch;

const integrations: Integrations = {
  publicUrl: "https://shop.example",
  google: { clientId: "gid", clientSecret: "gsec" },
  microsoft: { clientId: "mid", clientSecret: "msec" },
  sms: { number: "+65 8799 6394", webhookSecret: "s3cret" },
  stripe: { secretKey: "sk_test", webhookSecret: "whsec" },
  fetch: fakeFetch,
};

async function call(url: string, o: { method?: string; body?: unknown; bearer?: string; root?: string; raw?: string; type?: string; headers?: Record<string, string>; manual?: boolean; device?: string } = {}) {
  const res = await fetch((o.root ?? base) + url, {
    method: o.method ?? (o.body !== undefined || o.raw !== undefined ? "POST" : "GET"),
    redirect: o.manual ? "manual" : "follow",
    headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.type ? { "content-type": o.type } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(o.device ? { "x-device-token": o.device } : {}), ...o.headers },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, location: res.headers.get("location") };
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  store = new PgEventStore(db, "bp", "EV");
  const common = { config, db, logger: false, store, catalog: cat, catalogAdmin: cat, trustProxy: true };
  app = await buildApp({ ...common, integrations });
  bare = await buildApp({ ...common, integrations: { publicUrl: "https://shop.example" } });
  mailed = await buildApp({ ...common, integrations: { publicUrl: "https://shop.example", mail: { apiKey: "re_key", from: "Bailey & Patch <orders@shop.example>" }, fetch: fakeFetch } });
  await mailed.listen({ port: 0, host: "127.0.0.1" });
  baseMailed = `http://127.0.0.1:${(mailed.server.address() as { port: number }).port}`;
  await app.listen({ port: 0, host: "127.0.0.1" });
  await bare.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  baseBare = `http://127.0.0.1:${(bare.server.address() as { port: number }).port}`;
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  const e = (await enroll(db, "bp", c.code, "Till"))!;
  till = { token: e.token, id: e.device.id };
}, 120_000);
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await mailed?.close();
  await stop?.();
});

const emailSignIn = async (email: string) => {
  const s = await call("/api/shop/auth/email/start", { body: { email } });
  return (await call("/api/shop/auth/email/verify", { body: { email, code: s.json.devCode } })).json;
};
const place = (body: object = {}, bearer?: string) => call("/api/shop/orders", { bearer, body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 5 }], customerPhone: "9123 4567", ...body } });
let n = 0;
const tillPush = (orderId: string, extra: object, root?: string) => call("/api/sync/push", { root, device: till.token, body: { events: [{ id: `ti${++n}`, orderId, deviceId: till.id, ts: Date.now() + n, seq: 1000 + n, ...extra }] } });
const orderState = async (id: string) => reduceOrder(id, await store.eventsForOrder(id))!;

describe("what the shop says it can do", () => {
  it("lists only the features that are set up", async () => {
    const on = (await call("/api/shop/info")).json;
    expect(on.auth).toMatchObject({ google: true, microsoft: true, phone: { number: "+65 8799 6394" } });
    expect(on.payments).toEqual({ online: true, methods: ["card", "paynow"] });
    const off = (await call("/api/shop/info", { root: baseBare })).json;
    expect(off.auth.google).toBe(false);
    expect(off.auth.microsoft).toBe(false);
    expect(off.payments).toEqual({ online: false, methods: [] });
  });

  it("refuses a provider that is not set up", async () => {
    expect((await call("/api/shop/auth/oauth/google/start", { root: baseBare, manual: true })).status).toBe(404);
    expect((await call("/api/shop/auth/oauth/facebook/start", { manual: true })).status).toBe(404);
  });
});

describe("Google and Microsoft sign-in", () => {
  const go = async (provider: string) => {
    const start = await call(`/api/shop/auth/oauth/${provider}/start`, { manual: true });
    expect(start.status).toBe(302);
    const url = new URL(start.location!);
    return { url, state: url.searchParams.get("state")! };
  };
  const finish = async (provider: string, state: string, code = "c1") => {
    const cb = await call(`/api/shop/auth/oauth/${provider}/callback?code=${code}&state=${state}`, { manual: true });
    return { cb, ticket: new URLSearchParams(new URL(cb.location!).hash.split("?")[1] ?? "").get("ticket") };
  };

  it("sends the browser to the provider with PKCE and our return address", async () => {
    const { url } = await go("google");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("gid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://shop.example/api/shop/auth/oauth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("signs a new person in through a one-time ticket, with the welcome points", async () => {
    fake.profile = { sub: "g-new", email: "gina@example.com", email_verified: true, name: "Gina" };
    const { state } = await go("google");
    const { cb, ticket } = await finish("google", state);
    expect(cb.location).toMatch(/^https:\/\/shop\.example\/#\/shop\?ticket=/);
    const t = await call("/api/shop/auth/ticket", { body: { ticket } });
    expect(t.status).toBe(200);
    expect(t.json.member).toMatchObject({ email: "gina@example.com", name: "Gina", pointsBalance: 500 });
    const me = await call("/api/shop/me", { bearer: t.json.token });
    expect(me.json.member.email).toBe("gina@example.com");
    // The ticket works once.
    expect((await call("/api/shop/auth/ticket", { body: { ticket } })).status).toBe(401);
  });

  it("recognises the same person next time, and does not credit the welcome points again", async () => {
    const { state } = await go("google");
    const { ticket } = await finish("google", state);
    const t = await call("/api/shop/auth/ticket", { body: { ticket } });
    expect(t.json.member.pointsBalance).toBe(500);
  });

  it("joins an existing email account only when Google vouches for the email", async () => {
    const existing = await emailSignIn("sam@example.com");
    fake.profile = { sub: "g-sam", email: "sam@example.com", email_verified: true, name: "Sam" };
    let { state } = await go("google");
    let r = await finish("google", state);
    expect((await call("/api/shop/auth/ticket", { body: { ticket: r.ticket } })).json.member.id).toBe(existing.member.id);

    // Microsoft does not say the email is verified, so it never takes over an existing account.
    fake.profile = { sub: "m-sam", email: "sam@example.com", name: "Mallory" };
    ({ state } = await go("microsoft"));
    r = await finish("microsoft", state);
    const t = await call("/api/shop/auth/ticket", { body: { ticket: r.ticket } });
    expect(t.json.member.id).not.toBe(existing.member.id);
    expect(t.json.member.email).toBeNull();
  });

  it("refuses a forged, repeated or failed callback", async () => {
    expect((await call("/api/shop/auth/oauth/google/callback?code=x&state=forged", { manual: true })).location).toContain("login_error=expired");
    const { state } = await go("google");
    await finish("google", state);
    expect((await call(`/api/shop/auth/oauth/google/callback?code=c&state=${state}`, { manual: true })).location).toContain("login_error=expired"); // state is single use
    const second = await go("google");
    fake.tokenOk = false;
    expect((await call(`/api/shop/auth/oauth/google/callback?code=c&state=${second.state}`, { manual: true })).location).toContain("login_error=failed");
    fake.tokenOk = true;
    expect((await call("/api/shop/auth/oauth/google/callback?error=access_denied", { manual: true })).location).toContain("login_error=cancelled");
  });
});

describe("phone sign-in by text message", () => {
  const inbound = (from: string, body: string, secret = "s3cret") => call(`/api/shop/auth/phone/inbound?secret=${secret}`, { raw: new URLSearchParams({ From: from, Body: body }).toString(), type: "application/x-www-form-urlencoded" });

  it("proves a number when its owner texts the code, then hands over one session", async () => {
    const s = await call("/api/shop/auth/phone/start", { body: { phone: "+65 9123 4567" } });
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ to: "+65 8799 6394", expiresInSeconds: 300 });
    expect(s.json.code).toMatch(/^\d{6}$/);
    expect((await call(`/api/shop/auth/phone/${s.json.id}`)).json.state).toBe("pending");

    // A text from some other number, or with the wrong code, proves nothing.
    await inbound("+6598765432", s.json.code);
    await inbound("+6591234567", "000000");
    expect((await call(`/api/shop/auth/phone/${s.json.id}`)).json.state).toBe("pending");

    const hit = await inbound("+6591234567", `Hi ${s.json.code}`);
    expect(hit.status).toBe(200);
    expect(hit.text).toBe("<Response/>");
    const done = await call(`/api/shop/auth/phone/${s.json.id}`);
    expect(done.json.state).toBe("verified");
    expect(done.json.member).toMatchObject({ phone: "+6591234567", email: null, pointsBalance: 500 });
    expect((await call("/api/shop/me", { bearer: done.json.token })).status).toBe(200);
    expect((await call(`/api/shop/auth/phone/${s.json.id}`)).status).toBe(410); // collected once

    // The same number later is the same member.
    const s2 = await call("/api/shop/auth/phone/start", { body: { phone: "6591234567" } });
    await inbound("+6591234567", s2.json.code);
    expect((await call(`/api/shop/auth/phone/${s2.json.id}`)).json.member.id).toBe(done.json.member.id);
  });

  it("ignores texts without the provider's secret, and a code used twice", async () => {
    const s = await call("/api/shop/auth/phone/start", { body: { phone: "6581112222" } });
    expect((await inbound("+6581112222", s.json.code, "wrong")).status).toBe(403);
    expect((await call(`/api/shop/auth/phone/${s.json.id}`)).json.state).toBe("pending");
    await inbound("+6581112222", s.json.code);
    await call(`/api/shop/auth/phone/${s.json.id}`);
    // The code was spent: a second text with it opens nothing new.
    await inbound("+6581112222", s.json.code);
    expect((await call(`/api/shop/auth/phone/${s.json.id}`)).status).toBe(410);
  });

  it("expires, and starting again retires the older code", async () => {
    const a = await call("/api/shop/auth/phone/start", { body: { phone: "6583334444" } });
    const b = await call("/api/shop/auth/phone/start", { body: { phone: "6583334444" } });
    expect((await call(`/api/shop/auth/phone/${a.json.id}`)).json.state).toBe("expired");
    await db.query("UPDATE sms_challenges SET expires_at = now() - interval '1 second' WHERE id::text=$1", [b.json.id]);
    expect((await call(`/api/shop/auth/phone/${b.json.id}`)).json.state).toBe("expired");
    expect((await call("/api/shop/auth/phone/start", { body: { phone: "123" } })).status).toBe(400);
  });

  it("can be tried in development without an SMS provider", async () => {
    const s = await call("/api/shop/auth/phone/start", { body: { phone: "6585556666" }, root: baseBare });
    expect(s.status).toBe(200);
    expect(s.json.to).toBe("+65 8000 0000");
    await call("/api/shop/auth/phone/simulate", { body: { phone: "6585556666", code: s.json.code }, root: baseBare });
    expect((await call(`/api/shop/auth/phone/${s.json.id}`, { root: baseBare })).json.state).toBe("verified");
  });
});

describe("cancelling and order history", () => {
  it("lets a customer cancel an unpaid order, and gives back what it spent", async () => {
    const m = await emailSignIn("cancel@example.com");
    const o = await place({ usePoints: "max" }, m.token);
    expect(o.json.pointsUsed).toBeGreaterThan(0);
    expect((await call("/api/shop/me", { bearer: m.token })).json.member.pointsBalance).toBe(500 - o.json.pointsUsed);
    expect((await call(`/api/shop/orders/${o.json.orderId}`)).json.canCancel).toBe(true);

    const c = await call(`/api/shop/orders/${o.json.orderId}/cancel`, { method: "POST" });
    expect(c.json.status).toBe("cancelled");
    expect((await call(`/api/shop/orders/${o.json.orderId}`)).json.status).toBe("cancelled");
    expect((await call("/api/shop/me", { bearer: m.token })).json.member.pointsBalance).toBe(500);
    expect((await call(`/api/shop/orders/${o.json.orderId}/cancel`, { method: "POST" })).json.status).toBe("cancelled"); // again is harmless
  });

  it("will not cancel once the kitchen has started or money has been paid", async () => {
    const a = await place();
    await tillPush(a.json.orderId, { type: "OrderAccepted" });
    await tillPush(a.json.orderId, { type: "StageSet", stage: "preparing" });
    expect((await call(`/api/shop/orders/${a.json.orderId}/cancel`, { method: "POST" })).status).toBe(409);

    const b = await place();
    await tillPush(b.json.orderId, { type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: 100, confirmed: true });
    expect((await call(`/api/shop/orders/${b.json.orderId}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await call("/api/shop/orders/nope/cancel", { method: "POST" })).status).toBe(404);
  });

  it("lists a member's own orders, newest first, and nobody else's", async () => {
    const m = await emailSignIn("history@example.com");
    const other = await emailSignIn("other@example.com");
    const first = await place({}, m.token);
    const second = await place({ channelId: "dine-in", spot: "T4" }, m.token);
    await place({}, other.token);
    const h = await call("/api/shop/me/orders", { bearer: m.token });
    expect(h.json.orders.map((x: any) => x.orderId)).toEqual([second.json.orderId, first.json.orderId]);
    expect(h.json.orders[0]).toMatchObject({ status: "received", itemCount: 5, queueNumber: second.json.queueNumber });
    expect((await call("/api/shop/me/orders")).status).toBe(401);
  });

  it("keeps notification choices, off for promos until the member says yes", async () => {
    const m = await emailSignIn("prefs@example.com");
    expect(m.member.prefs).toEqual({ orderUpdates: true, promos: false });
    const p = await call("/api/shop/me", { method: "PATCH", bearer: m.token, body: { orderUpdates: false, promos: true } });
    expect(p.json.member.prefs).toEqual({ orderUpdates: false, promos: true });
    expect((await call("/api/shop/me", { bearer: m.token })).json.member.prefs).toEqual({ orderUpdates: false, promos: true });
    // A name change alone leaves the choices alone.
    expect((await call("/api/shop/me", { method: "PATCH", bearer: m.token, body: { name: "Pru" } })).json.member.prefs).toEqual({ orderUpdates: false, promos: true });
  });

  it("keeps a profile change", async () => {
    const m = await emailSignIn("profile@example.com");
    const p = await call("/api/shop/me", { method: "PATCH", bearer: m.token, body: { name: "Pat", phone: "+65 9000 1111" } });
    expect(p.json.member).toMatchObject({ name: "Pat", phone: "+65 9000 1111" });
  });
});

describe("emailed sign-in codes", () => {
  it("emails the code and never hands it back to the page", async () => {
    const r = await call("/api/shop/auth/email/start", { body: { email: "mia@example.com" }, root: baseMailed });
    expect(r.json).toEqual({ sent: true });
    const m = fake.mails.at(-1);
    expect(m).toMatchObject({ auth: "Bearer re_key", from: "Bailey & Patch <orders@shop.example>", to: ["mia@example.com"] });
    const code = /\b(\d{6})\b/.exec(m.text)![1];
    expect(m.subject).toContain(code);
    const v = await call("/api/shop/auth/email/verify", { body: { email: "mia@example.com", code }, root: baseMailed });
    expect(v.json.token).toBeTruthy();
  });

  it("emails a member once when the order is ready, unless they turned updates off", async () => {
    const signIn = async (email: string) => {
      await call("/api/shop/auth/email/start", { body: { email }, root: baseMailed });
      const code = /\b(\d{6})\b/.exec(fake.mails.at(-1).text)![1];
      return (await call("/api/shop/auth/email/verify", { body: { email, code }, root: baseMailed })).json;
    };
    const ready = async (token: string) => {
      const o = await call("/api/shop/orders", { bearer: token, root: baseMailed, body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 5 }], customerPhone: "9123 4567" } });
      await tillPush(o.json.orderId, { type: "OrderAccepted" }, baseMailed);
      await tillPush(o.json.orderId, { type: "PaymentRecorded", paymentId: `c${++n}`, method: "cash", amountCents: o.json.totalCents, confirmed: true }, baseMailed);
      await tillPush(o.json.orderId, { type: "StageSet", stage: "ready" }, baseMailed);
      await tillPush(o.json.orderId, { type: "StageSet", stage: "ready" }, baseMailed); // the same news twice
      return o.json;
    };
    const a = await signIn("ready@example.com");
    const before = fake.mails.length;
    const oa = await ready(a.token);
    const sent = fake.mails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["ready@example.com"] });
    expect(sent[0].subject).toContain(String(oa.queueNumber));

    const b = await signIn("quiet@example.com");
    await call("/api/shop/me", { method: "PATCH", bearer: b.token, body: { orderUpdates: false }, root: baseMailed });
    const mid = fake.mails.length;
    await ready(b.token);
    expect(fake.mails.length).toBe(mid);
  });

  it("without mail set up the code still comes back for development", async () => {
    const r = await call("/api/shop/auth/email/start", { body: { email: "dev@example.com" } });
    expect(r.json.devCode).toMatch(/^\d{6}$/);
  });
});

describe("paying online", () => {
  const sign = (body: string, secret = "whsec", t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const hook = (event: object, header?: string) => {
    const raw = JSON.stringify(event);
    return call("/api/shop/stripe/webhook", { raw, type: "application/json", headers: { "stripe-signature": header ?? sign(raw) } });
  };
  const paid = (orderId: string, session: string, amount: number, extra: object = {}) => ({ type: "checkout.session.completed", data: { object: { id: session, payment_status: "paid", amount_total: amount, currency: "sgd", client_reference_id: orderId, metadata: { method: "paynow" }, ...extra } } });

  it("starts a card or PayNow payment for exactly what is owed", async () => {
    const o = await place();
    const r = await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "paynow" } });
    expect(r.json.url).toMatch(/^https:\/\/pay\.example\/cs_/);
    const sent = new URLSearchParams(fake.stripeBodies.at(-1));
    expect(sent.get("line_items[0][price_data][unit_amount]")).toBe(String(o.json.totalCents));
    expect(sent.get("line_items[0][price_data][currency]")).toBe("sgd");
    expect(sent.get("payment_method_types[0]")).toBe("paynow");
    expect(sent.get("client_reference_id")).toBe(o.json.orderId);
    expect(sent.get("success_url")).toBe(`https://shop.example/#/shop/order/${o.json.orderId}`);
    expect((await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "bitcoin" } })).status).toBe(400);
    expect((await call("/api/shop/orders/nope/pay", { body: { method: "card" } })).status).toBe(404);
    expect((await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "card" }, root: baseBare })).status).toBe(404);
    expect((await call(`/api/shop/orders/${o.json.orderId}`)).json.canPayOnline).toBe(true);
    expect((await call(`/api/shop/orders/${o.json.orderId}`, { root: baseBare })).json.canPayOnline).toBe(false);
  });

  it("records a confirmed payment once, and the order then counts as paid", async () => {
    const m = await emailSignIn("payer@example.com");
    const o = await place({}, m.token);
    const body = paid(o.json.orderId, "cs_live_1", o.json.totalCents);
    expect((await hook(body)).json).toEqual({ received: true });
    expect((await hook(body)).status).toBe(200); // Stripe repeats itself
    const st = await orderState(o.json.orderId);
    expect(st.payments).toEqual([{ paymentId: "stripe:cs_live_1", method: "paynow", amountCents: o.json.totalCents, confirmed: true }]);
    expect(confirmedPaid(st)).toBe(orderTotals(st, config).total);
    expect((await call(`/api/shop/orders/${o.json.orderId}`)).json).toMatchObject({ paidCents: o.json.totalCents, canPayOnline: false, canCancel: false });
    expect((await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "card" } })).status).toBe(409);
    // Paying earns points for a member, through the same path as paying at the till.
    expect((await call("/api/shop/me", { bearer: m.token })).json.member.pointsBalance).toBe(500 + Math.floor(o.json.totalCents / 100));
  });

  it("does not believe an unsigned, stale or mismatched message", async () => {
    const o = await place();
    const raw = JSON.stringify(paid(o.json.orderId, "cs_x", o.json.totalCents));
    expect((await call("/api/shop/stripe/webhook", { raw, type: "application/json" })).status).toBe(400);
    expect((await hook(JSON.parse(raw), sign(raw, "wrong-secret"))).status).toBe(400);
    expect((await hook(JSON.parse(raw), sign(raw, "whsec", Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    // Right signature, wrong amount / currency / not yet paid / unknown order: acknowledged but nothing recorded.
    await hook(paid(o.json.orderId, "cs_y", o.json.totalCents - 1));
    await hook(paid(o.json.orderId, "cs_z", o.json.totalCents, { currency: "usd" }));
    await hook(paid(o.json.orderId, "cs_w", o.json.totalCents, { payment_status: "unpaid" }));
    await hook(paid("no-such-order", "cs_v", 100));
    expect((await orderState(o.json.orderId)).payments).toEqual([]);
  });

  it("does not take a payment for an order that was cancelled, and gives it back", async () => {
    const o = await place();
    await call(`/api/shop/orders/${o.json.orderId}/cancel`, { method: "POST" });
    const before = fake.refunds.length;
    await hook(paid(o.json.orderId, "cs_late", o.json.totalCents, { payment_intent: "pi_late" }));
    await hook(paid(o.json.orderId, "cs_late", o.json.totalCents, { payment_intent: "pi_late" })); // Stripe repeats itself
    expect((await orderState(o.json.orderId)).payments).toEqual([]);
    expect(fake.refunds.length).toBe(before + 2);
    const r = fake.refunds.at(-1)!;
    expect(new URLSearchParams(r.body).get("payment_intent")).toBe("pi_late");
    expect(r.key).toBe("refund-cs_late"); // the same key both times, so Stripe refunds once
  });

  it("gives back a payment whose amount does not fit, but not one that was recorded", async () => {
    const o = await place();
    const before = fake.refunds.length;
    await hook(paid(o.json.orderId, "cs_short", o.json.totalCents - 1, { payment_intent: "pi_short" }));
    expect(fake.refunds.length).toBe(before + 1);
    await hook(paid(o.json.orderId, "cs_ok", o.json.totalCents, { payment_intent: "pi_ok" }));
    await hook(paid(o.json.orderId, "cs_ok", o.json.totalCents, { payment_intent: "pi_ok" }));
    expect(fake.refunds.length).toBe(before + 1);
    expect((await orderState(o.json.orderId)).payments).toHaveLength(1);
  });

  it("verifies signatures the way Stripe signs them", () => {
    const body = Buffer.from("{}");
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", "k").update(`${t}.{}`).digest("hex");
    expect(verifyStripeSignature(body, `t=${t},v1=bad,v1=${v1}`, "k")).toBe(true); // a rotating secret sends two
    expect(verifyStripeSignature(body, `t=${t},v1=${v1}`, "other")).toBe(false);
    expect(verifyStripeSignature(body, undefined, "k")).toBe(false);
  });
});
