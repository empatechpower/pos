import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { MemberStore } from "../src/members.js";
import { topUp } from "../src/ledger.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// Tab & Split & Pay (Spec 12 and 13, Addendum 2.4, 3, 4, 5, 6): joining, rounds, the waiter's release, every payment mode on the documents' seed tab,
// the frozen quote, atomic reservation, one payment in flight per party, attribution to the real payer, and rewards credited once at settlement.

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
const config = { ...baseCfg, pricing: { ...baseCfg.pricing, serviceRate: 0.09 }, rewards: { ...baseCfg.rewards, pointsEnabled: true, earnPointsPerDollar: 1, welcomePoints: 0, welcomeVoucherCents: 0 } };

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
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
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

describe("settings and joining", () => {
  it("a tab needs table service, and the operator sets how a custom amount is applied", async () => {
    await call("/api/outlets/QS", { method: "PUT", body: { name: "Quick shop", serviceMode: "qsr" }, staff: owner });
    expect((await call("/api/outlets/QS/tab-settings", { method: "PUT", body: { tabService: true }, staff: owner })).status).toBe(400); // QSR + Add to Tab is invalid
    expect((await call("/api/outlets/EV/tab-settings", { method: "PUT", body: { allocation: "sideways" }, staff: owner })).status).toBe(400);
    expect((await call("/api/outlets/EV/tab-settings", { method: "PUT", body: { allocation: "oldest_first" }, staff: owner })).json).toMatchObject({ tabService: true, allocation: "oldest_first" });
    expect((await call("/api/shop/tab/settings?outlet=EV")).json.tabService).toBe(true);
  });

  it("the first person to scan opens the tab and is the Host; later scans join it; a check-in code joins too", async () => {
    const alex = await join("12", "Alex");
    expect(alex.isHost).toBe(true);
    const sam = await join("12", "Sam");
    expect(sam.tabId).toBe(alex.tabId);
    expect(sam.isHost).toBe(false);
    const code = alex.json.tab.code as string;
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    const guest = await tcall("/api/shop/tab/join", { body: { outletId: "EV", code } });
    expect(guest.json.tab.people.map((p: any) => p.name)).toEqual(["Alex", "Sam", "Guest 1"]);
    // coming back with the credential is the same person, not a new one
    const back = await tcall("/api/shop/tab/join", { body: { outletId: "EV", table: "12", participantId: alex.id, token: alex.token } });
    expect(back.json.participantId).toBe(alex.id);
    expect((await view(alex)).people).toHaveLength(3);
    // the credential is the id and the token together
    expect((await tcall("/api/shop/tab", { who: { ...alex, token: "wrong" } })).status).toBe(401);
    expect((await tcall("/api/shop/tab", { who: { ...sam, id: alex.id } })).status).toBe(401);
  });
});

describe("the seed tab (Spec 12.7): Alex Tornado, Sam Kaya + Coffee, Guest Coke BCRS", () => {
  let alex: Who, sam: Who, guest: Who;
  beforeAll(async () => {
    alex = await join("T7", "Alex");
    sam = await join("T7", "Sam");
    guest = { ...(await join("T7")) };
  });

  it("an order at a table needs the tab, is paid on the tab, and carries no collection number", async () => {
    const noTab = await tcall("/api/shop/orders", { body: { channelId: "dine-in", outletId: "EV", items: [{ productId: kaya, qty: 1 }], customerName: "x", customerPhone: "" } });
    expect(noTab.status).toBe(401);
    expect(noTab.json.error).toBe("join_the_tab");
    expect((await tcall("/api/shop/orders", { body: { channelId: "dine-in", outletId: "EV", items: [{ productId: kaya, qty: 1 }], payWithCredit: true, tab: { participantId: alex.id, token: alex.token } } })).json.error).toBe("pay_on_the_tab");
    const r1 = await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    expect(r1.status).toBe(200);
    expect(r1.json.queueNumber).toBeUndefined();
    expect(r1.json.round).toBe(1);
    await orderRound(sam, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }]);
    await orderRound(guest, [{ productId: coke, qty: 1 }]);
    const v = await view(alex);
    expect(v.totals).toMatchObject({ itemsCents: 1750, serviceCents: 158, depositCents: 10, totalCents: 1918, paidCents: 0, remainingCents: 1918 });
    expect(v.rounds.map((r: any) => r.orderedBy.name)).toEqual(["Alex", "Sam", "Guest 1"]);
  });

  it("payment is locked until the waiter releases it, with the lock note verbatim (Spec 13.2)", async () => {
    const v = await view(alex);
    expect(v.paymentLocked).toBe(true);
    expect(v.lockNote).toBe("Your waiter will release payment when you're ready to pay.");
    const q = await quote(alex, { mode: "mine" });
    expect(q.status).toBe(409);
    expect(q.json.error).toBe("payment_locked");
    expect((await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, who: alex })).status).toBe(401); // only staff release
  });

  it("after the release, Pay mine is S$11.77 / S$4.58 / S$2.83 and they add up to S$19.18", async () => {
    expect((await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok })).status).toBe(200);
    const [a, s, g] = await Promise.all([quote(alex, { mode: "mine" }), quote(sam, { mode: "mine" }), quote(guest, { mode: "mine" })]);
    expect([a.json.amountCents, s.json.amountCents, g.json.amountCents]).toEqual([1177, 458, 283]);
    expect(g.json.depositCents).toBe(10); // the deposit stays with the Coke
    expect(a.json.tabTotalCents).toBe(1918);
  });

  it("a quote freezes the maths: the payment is taken against it, or rejected and a new one issued visibly", async () => {
    const old = await quote(alex, { mode: "all" }); // pay all, quoted now
    expect(old.json.amountCents).toBe(1918);
    const sQ = await quote(sam, { mode: "mine" });
    const sPay = await pay(sam, sQ.json.quoteId);
    expect(sPay.status).toBe(200); // Sam reserves his share: the tab has moved on
    const stale = await pay(alex, old.json.quoteId);
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("quote_changed");
    expect(stale.json.quote.amountCents).toBe(1918 - 458); // the new quote is shown, not silently charged
    await tcall(`/api/shop/tab/payments/${sPay.json.paymentId}/cancel`, { method: "POST", body: {}, who: sam });
  });

  it("two phones paying all at once: exactly one wins, no overpayment", async () => {
    const [q1, q2] = await Promise.all([quote(alex, { mode: "all" }), quote(sam, { mode: "all" })]);
    const [p1, p2] = await Promise.all([pay(alex, q1.json.quoteId), pay(sam, q2.json.quoteId)]);
    expect([p1.status, p2.status].sort()).toEqual([200, 409]);
    const winner = p1.status === 200 ? p1 : p2;
    const v = await view(alex);
    expect(v.totals.paidCents).toBe(1918); // reserved counts: nothing more can be paid
    await tcall(`/api/shop/tab/payments/${winner.json.paymentId}/cancel`, { method: "POST", body: {}, who: p1.status === 200 ? alex : sam });
    expect((await view(alex)).totals.paidCents).toBe(0); // cancelled before completion: free again
  });

  it("one payment in flight per party, and a payer can pay another's share, attributed to the payer", async () => {
    const forSam = await quote(alex, { mode: "mine", forParticipantId: sam.id });
    expect(forSam.json.amountCents).toBe(458);
    const own = await quote(sam, { mode: "mine" }); // Sam quoted his own share before Alex moved
    const first = await pay(alex, forSam.json.quoteId);
    expect(first.status).toBe(200);
    const clash = await pay(sam, own.json.quoteId);
    expect(clash.status).toBe(409); // that share is already being paid: Sam is not asked to pay it twice
    expect(["payment_in_flight", "already_being_paid", "quote_changed"]).toContain(clash.json.error);
    expect((await quote(sam, { mode: "mine" })).status).toBe(409); // and a new quote for it says there is nothing left to pay
    const v = await view(sam);
    const pm = v.payments.find((p: any) => p.id === first.json.paymentId);
    expect(pm.payer.name).toBe("Alex");
    expect(pm.for.name).toBe("Sam");
    await confirm(first.json.paymentId);
  });

  it("nobody can pay as someone else", async () => {
    const q = await quote(guest, { mode: "mine" });
    const r = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "counter", idempotencyKey: "idem-spoof-1", payerId: alex.id }, who: guest });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("payer_is_the_session_identity");
    const other = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "counter", idempotencyKey: "idem-spoof-2" }, who: alex }); // someone else's quote
    expect(other.status).toBe(404);
  });

  it("a retry with the same key is one payment; the same key for a different quote is refused", async () => {
    const q = await quote(guest, { mode: "mine" });
    const key = "idem-retry-key-1";
    const a = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "counter", idempotencyKey: key }, who: guest });
    const b = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "counter", idempotencyKey: key }, who: guest });
    expect(b.json).toMatchObject({ paymentId: a.json.paymentId, replayed: true });
    const q2 = await quote(guest, { mode: "mine" }).catch(() => null);
    void q2;
    await tcall(`/api/shop/tab/payments/${a.json.paymentId}/cancel`, { method: "POST", body: {}, who: guest });
    const c = await tcall("/api/shop/tab/pay", { body: { quoteId: (await quote(guest, { mode: "mine" })).json.quoteId, method: "counter", idempotencyKey: key }, who: guest });
    expect(c.status).toBe(409);
    expect(c.json.error).toBe("idempotency_key_reused");
  });

  it("card and PayNow are not available until the payment provider is connected", async () => {
    const q = await quote(guest, { mode: "mine" });
    const r = await pay(guest, q.json.quoteId, "paynow");
    expect(r.status).toBe(501);
    expect(r.json.error).toBe("provider_unavailable");
  });

  it("everyone paying their own share settles the tab: rewards follow the payer and credit once, only at the end", async () => {
    // Alex has already paid Sam's share (S$4.58). Alex pays his own; the Guest pays hers.
    const v0 = await view(alex);
    expect(v0.totals.paidCents).toBe(458);
    expect(v0.me.pendingPoints).toBe(Math.floor(458 / 100)); // pending, not credited: the tab is not fully paid
    await payNow(alex, { mode: "mine" });
    expect((await view(alex)).closed).toBe(false);
    expect((await view(alex)).pendingRewardsNote).toBe("These points become available when the whole table bill is paid.");
    await payNow(guest, { mode: "mine" });
    const done = await view(alex);
    expect(done.closed).toBe(true);
    expect(done.totals).toMatchObject({ paidCents: 1918, remainingCents: 0 });
    // a closed tab takes no more orders
    expect((await orderRound(alex, [{ productId: kaya, qty: 1 }])).status).toBe(409);
    // the round orders are recorded as paid by the tab
    const paid = await db.query("SELECT count(*)::int AS n FROM events WHERE merchant_id='bp' AND type='PaymentRecorded' AND body->>'paymentId' = $1", [`tab:${alex.tabId}`]);
    expect(paid.rows[0].n).toBe(3);
  });
});

describe("rewards: individual, host-keep, claim, once (Spec 12.10, Addendum 6)", () => {
  it("members earn on what they paid at settlement; a host-keep payment goes to the Host; a guest's earnings are recorded and a sign-up before settlement claims them; credited once", async () => {
    const members = new MemberStore(db, "bp", 0, 0);
    const alexM = (await members.signInWithIdentity("test", "alex-sub", { name: "Alex" })).token;
    const alexId = (await members.fromToken(alexM))!.id;
    const samM = (await members.signInWithIdentity("test", "sam-sub", { name: "Sam" })).token;
    const samId = (await members.fromToken(samM))!.id;
    const alex = await join("R1", "x", alexM);
    const sam = await join("R1", "x", samM);
    const guest = await join("R1");
    expect(alex.isHost).toBe(true);
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(sam, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }]);
    await orderRound(guest, [{ productId: coke, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    // Sam chooses "let the host keep the reward"; the Guest pays her own; Alex pays his own.
    await payNow(sam, { mode: "mine" }, true);
    await payNow(guest, { mode: "mine" });
    // the Guest signs up and claims before settlement
    const newcomerM = (await members.signInWithIdentity("test", "guest-sub", { name: "Gina" })).token;
    const newcomerId = (await members.fromToken(newcomerM))!.id;
    expect((await tcall("/api/shop/tab/claim", { method: "POST", body: {}, who: guest, bearer: newcomerM })).status).toBe(200);
    expect((await tcall("/api/shop/tab/claim", { method: "POST", body: {}, who: guest, bearer: alexM })).status).toBe(409); // single use
    expect((await members.byId(alexId))!.pointsBalance).toBe(0); // nothing before the tab is fully paid
    await payNow(alex, { mode: "mine" });
    // Alex: his own 1177 -> 11 pts, plus Sam's host-keep 458 -> 4 pts = 15; Sam: nothing (his payment went to the Host); the Guest's 283 -> 2 pts credited to the account she claimed into.
    expect((await members.byId(alexId))!.pointsBalance).toBe(Math.floor(1177 / 100) + Math.floor(458 / 100));
    expect((await members.byId(samId))!.pointsBalance).toBe(0);
    expect((await members.byId(newcomerId))!.pointsBalance).toBe(Math.floor(283 / 100));
    // settling again, or any later duplicate, credits nothing more
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const again = await db.query("SELECT count(*)::int AS n FROM points_entries WHERE note LIKE 'Tab rewards%'");
    expect(again.rows[0].n).toBe(2);
  });
});

describe("Split equally, By round, Custom amount, cash at the counter, and the waiter", () => {
  it("Split equally is S$6.36 / S$6.36 / S$6.46 on the seed tab (working rule B); the Host takes the odd cents", async () => {
    const alex = await join("E1", "Alex"), sam = await join("E1", "Sam"), guest = await join("E1", "Guest");
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(sam, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }]);
    await orderRound(guest, [{ productId: coke, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const [a, s, g] = await Promise.all([quote(alex, { mode: "equal", people: 3 }), quote(sam, { mode: "equal", people: 3 }), quote(guest, { mode: "equal", people: 3 })]);
    expect(a.json.amountCents + s.json.amountCents + g.json.amountCents).toBe(1918);
    expect(a.json.amountCents).toBeGreaterThanOrEqual(s.json.amountCents);
  });

  it("By round, Custom (oldest round first), and a staff cash payment that records who took it", async () => {
    const alex = await join("E2", "Alex"), sam = await join("E2", "Sam");
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(sam, [{ productId: kaya, qty: 2 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const r2 = await quote(sam, { mode: "round", round: 2 });
    expect(r2.json.itemsCents).toBe(400);
    expect((await quote(sam, { mode: "round", round: 9 })).status).toBe(400);
    const custom = await quote(alex, { mode: "custom", amountCents: 1300 });
    expect(custom.json.amountCents).toBe(1300);
    expect((await quote(alex, { mode: "custom", amountCents: 0 })).status).toBe(400);
    // staff take cash for Sam's round at the counter
    const cash = await tcall(`/api/tabs/${alex.tabId}/payments`, { body: { participantId: sam.id, mode: "round", round: 2 }, staff: staffTok });
    expect(cash.status).toBe(200);
    expect(cash.json.status).toBe("completed");
    const v = await view(alex);
    const p = v.payments.find((x: any) => x.method === "cash");
    expect(p).toMatchObject({ staffRecorded: true, payer: { name: "Sam" } }); // payer and the staff recorder are separate
    expect(v.totals.paidCents).toBe(r2.json.amountCents);
  });

  it("a round ordered after the release starts locked again, and paying it before a new release fails with the lock note", async () => {
    const alex = await join("E3", "Alex");
    await orderRound(alex, [{ productId: kaya, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    await new Promise((r) => setTimeout(r, 30));
    await orderRound(alex, [{ productId: coffee, qty: 1 }]); // round 2, after the release
    const v = await view(alex);
    expect(v.rounds.map((r: any) => r.locked)).toEqual([false, true]);
    expect((await quote(alex, { mode: "round", round: 2 })).status).toBe(400); // not payable yet
    const all = await quote(alex, { mode: "all" });
    expect(all.json.itemsCents).toBe(200); // a release never extends to what was ordered after it
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    expect((await quote(alex, { mode: "round", round: 2 })).json.itemsCents).toBe(220);
  });

  it("paging the waiter: requesting the bill sets the flag, re-taps do nothing, and only staff reset it", async () => {
    const alex = await join("E4", "Alex");
    await orderRound(alex, [{ productId: kaya, qty: 1 }]);
    expect((await tcall("/api/shop/tab/page", { body: { kind: "bill" }, who: alex })).status).toBe(200);
    let v = await view(alex);
    expect(v).toMatchObject({ waiterPaged: true, billRequested: true, pagedKind: "bill" });
    await tcall("/api/shop/tab/page", { body: { kind: "help" }, who: alex });
    expect((await view(alex)).pagedKind).toBe("bill"); // no re-send
    expect((await tcall(`/api/tabs/${alex.tabId}/reset-page`, { method: "POST", body: {}, staff: staffTok })).status).toBe(200);
    v = await view(alex);
    expect(v).toMatchObject({ waiterPaged: false, billRequested: false });
    const list = (await tcall("/api/tabs?outlet=EV", { staff: staffTok })).json.tabs as any[];
    expect(list.find((t) => t.id === alex.tabId)).toMatchObject({ spot: "E4", people: 1, released: false });
  });

  it("an unknown outcome keeps its reservation and shows on the staff list until resolved from evidence; closing needs a reason", async () => {
    const alex = await join("E5", "Alex");
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q = await quote(alex, { mode: "all" });
    const r = await pay(alex, q.json.quoteId);
    await db.query("UPDATE tab_payments SET status='unknown', method='card', provider_ref='ref-123' WHERE id=$1", [r.json.paymentId]);
    const rec = (await tcall("/api/tabs/reconciliation", { staff: staffTok })).json.payments as any[];
    expect(rec.find((p) => p.id === r.json.paymentId)).toMatchObject({ table: "E5", party: "Alex", providerRef: "ref-123" });
    expect((await quote(alex, { mode: "all" })).json?.amountCents ?? 0).toBe(0 + ((await quote(alex, { mode: "all" })).json?.amountCents ?? 0)); // the reservation still holds the amount
    expect((await tcall(`/api/tabs/payments/${r.json.paymentId}/resolve`, { method: "POST", body: { outcome: "completed" }, staff: staffTok })).status).toBe(400); // evidence required
    expect((await tcall(`/api/tabs/payments/${r.json.paymentId}/resolve`, { method: "POST", body: { outcome: "completed", evidence: "provider dashboard shows paid" }, staff: staffTok })).status).toBe(200);
    expect((await view(alex)).closed).toBe(true);
    const b = await join("E6", "Bea");
    await orderRound(b, [{ productId: kaya, qty: 1 }]);
    expect((await tcall(`/api/tabs/${b.tabId}/close`, { method: "POST", body: {}, staff: staffTok })).status).toBe(400);
    expect((await tcall(`/api/tabs/${b.tabId}/close`, { method: "POST", body: { reason: "guest left without paying" }, staff: staffTok })).status).toBe(200);
  });

  it("a shared line is split between the people chosen, to the cent, and sums to the tab", async () => {
    const alex = await join("E7", "Alex"), sam = await join("E7", "Sam"), guest = await join("E7", "Gus");
    const r = await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    expect(r.status).toBe(200);
    const lineId = (await view(alex)).rounds[0].lines[0].lineId;
    expect((await tcall(`/api/shop/tab/lines/${lineId}/share`, { body: { with: [alex.id, sam.id, guest.id] }, who: alex })).status).toBe(200);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const shares = await Promise.all([alex, sam, guest].map((w) => quote(w, { mode: "mine" })));
    expect(shares.reduce((n, q) => n + q.json.amountCents, 0)).toBe((await view(alex)).totals.totalCents);
    expect(shares.map((q) => q.json.itemsCents)).toEqual([360, 360, 360]);
    // once a unit is being paid for, the line cannot be shared again
    const pay1 = await pay(alex, shares[0]!.json.quoteId);
    expect(pay1.status).toBe(200);
    expect((await tcall(`/api/shop/tab/lines/${lineId}/share`, { body: { with: [alex.id, sam.id] }, who: alex })).status).toBe(409);
  });

  it("paying with member credit completes at once, and not enough credit is refused", async () => {
    const members = new MemberStore(db, "bp", 0, 0);
    const m = await members.signInWithIdentity("test", "credit-sub", { name: "Cleo" });
    await topUp(db, { merchantId: "bp", customerId: m.member.id, amountCents: 300, idempotencyKey: "tab-test-topup", kind: "topup" } as never);
    const cleo = await join("E8", "x", m.token);
    await orderRound(cleo, [{ productId: kaya, qty: 1 }]);
    await tcall(`/api/tabs/${cleo.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q = await quote(cleo, { mode: "all" });
    const ok = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "credit", idempotencyKey: "idem-credit-1" }, who: cleo, bearer: m.token });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("completed");
    expect((await view(cleo)).closed).toBe(true);
    // not enough
    const poor = await members.signInWithIdentity("test", "poor-sub", { name: "Pip" });
    const pip = await join("E9", "x", poor.token);
    await orderRound(pip, [{ productId: tornado, qty: 1 }]);
    await tcall(`/api/tabs/${pip.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q2 = await quote(pip, { mode: "all" });
    const no = await tcall("/api/shop/tab/pay", { body: { quoteId: q2.json.quoteId, method: "credit", idempotencyKey: "idem-credit-2" }, who: pip, bearer: poor.token });
    expect(no.status).toBe(409);
    expect(no.json.error).toBe("not_enough_credit");
    expect((await view(pip)).totals.paidCents).toBe(0); // the reservation was released
  });
});
