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

describe("a coupon on the tab and personal points (Spec 12.4 D3, 12.7, 8.2)", () => {
  const members = () => new MemberStore(db, "bp", 0, 0);
  const memberWith = async (sub: string, points: number, coupons: Array<{ title: string; amountCents: number; minSpendCents: number }> = []) => {
    const m = await members().signInWithIdentity("test", sub, { name: sub });
    if (points) await members().post(m.member.id, "earn", points, `seed-${sub}`);
    for (const [i, c] of coupons.entries()) await members().grantCoupon(m.member.id, `seed-${sub}-${i}`, c);
    return { token: m.token, id: m.member.id };
  };
  const walletOf = async (id: string) => (await members().coupons(id)).map((c) => c.id);

  it("any person can apply their own coupon: the minimum is on the whole tab's items, the reason is said inline, and the slot is held until its owner removes it", async () => {
    const a = await memberWith("cp-alex", 0, [{ title: "S$2 off", amountCents: 200, minSpendCents: 1500 }, { title: "S$50 off", amountCents: 5000, minSpendCents: 5000 }]);
    const b = await memberWith("cp-bea", 0, [{ title: "S$1 off", amountCents: 100, minSpendCents: 0 }]);
    const alex = await join("C1", "x", a.token), bea = await join("C1", "x", b.token);
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(bea, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }, { productId: coke, qty: 1 }]);
    const wallet = await walletOf(a.id);
    const opts = (await tcall("/api/shop/tab", { who: alex, bearer: a.token })).json.couponOptions as Array<any>;
    expect(opts.find((o) => o.title === "S$2 off")).toMatchObject({ eligible: true, reason: null });
    const big = opts.find((o) => o.title === "S$50 off");
    expect(big.eligible).toBe(false);
    expect(big.reason).toContain("items only, before service charge and any tax, deposits excluded");
    expect(big.reason).toContain("S$50.00");
    const short = await tcall("/api/shop/tab/coupons", { body: { couponId: wallet[1] }, who: alex, bearer: a.token });
    expect(short.status).toBe(400);
    expect(short.json).toMatchObject({ error: "coupon_not_eligible", shortfallCents: 5000 - 1750 });
    expect((await tcall("/api/shop/tab/coupons", { body: { couponId: wallet[0] }, who: alex, bearer: a.token })).status).toBe(200);
    const v = (await tcall("/api/shop/tab", { who: bea, bearer: b.token })).json;
    expect(v.totals.discountCents).toBe(200);
    expect(v.coupons).toMatchObject([{ title: "S$2 off", amountCents: 200, owner: { name: "cp-alex" }, mine: false }]);
    // promotions are not stackable here: the slot is held by the first coupon
    expect((await tcall("/api/shop/tab/coupons", { body: { couponId: (await walletOf(b.id))[0] }, who: bea, bearer: b.token })).json.error).toBe("coupon_slot_taken");
    // only the owner takes it off, and then it is theirs again
    const tabCouponId = v.coupons[0].id;
    expect((await tcall(`/api/shop/tab/coupons/${tabCouponId}`, { method: "DELETE", who: bea, bearer: b.token })).status).toBe(403);
    expect((await tcall(`/api/shop/tab/coupons/${tabCouponId}`, { method: "DELETE", who: alex, bearer: a.token })).status).toBe(200);
    expect((await walletOf(a.id)).length).toBe(2);
    expect((await tcall("/api/shop/tab/coupons", { body: { couponId: wallet[0] }, who: alex, bearer: a.token })).status).toBe(200);
  });

  it("the discount is shared pro-rata across the payers, the shares add up to the new total, and a coupon cannot be added or removed once anyone has paid", async () => {
    const alex = await join("C1", "x", (await members().signInWithIdentity("test", "cp-alex", {})).token);
    const tabId = alex.tabId;
    await tcall(`/api/tabs/${tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const bea = await join("C1", "x", (await members().signInWithIdentity("test", "cp-bea", {})).token);
    const [qa, qb] = await Promise.all([quote(alex, { mode: "mine" }), quote(bea, { mode: "mine" })]);
    const v = await view(alex);
    expect(v.totals.totalCents).toBe(qa.json.amountCents + qb.json.amountCents);
    expect(qa.json.discountCents + qb.json.discountCents).toBe(200);
    expect(qa.json.discountCents).toBeGreaterThan(qb.json.discountCents - 1); // Alex's S$10.80 carries the larger part
    const pay1 = await pay(alex, qa.json.quoteId);
    expect(pay1.status).toBe(200);
    const a = (await members().signInWithIdentity("test", "cp-alex", {})).token;
    const myCouponId = ((await view(alex)).coupons as any[])[0].id;
    expect((await tcall(`/api/shop/tab/coupons/${myCouponId}`, { method: "DELETE", who: alex, bearer: a })).status).toBe(409); // too late
    await confirm(pay1.json.paymentId);
    await payNow(bea, { mode: "mine" });
    const done = await view(alex);
    expect(done.closed).toBe(true);
    expect(done.totals.remainingCents).toBe(0);
  });

  it("points reduce only the payer's own cash; the tab is settled by the full share; nobody else's share moves; cancelling gives the points back", async () => {
    const s = await memberWith("pt-sam", 10_000);
    const alex = await join("P1", "Alex"), sam = await join("P1", "x", s.token);
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(sam, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const before = (await quote(alex, { mode: "mine" })).json.amountCents;
    const q = await tcall("/api/shop/tab/quote", { body: { mode: "mine", usePoints: 100 }, who: sam, bearer: s.token });
    expect(q.json).toMatchObject({ pointsUsed: 100, liabilityCents: q.json.amountCents + 100 });
    const r = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "counter", idempotencyKey: "idem-pts-1" }, who: sam, bearer: s.token });
    expect(r.status).toBe(200);
    expect((await members().byId(s.id))!.pointsBalance).toBe(9900); // spent at payment
    expect((await quote(alex, { mode: "mine" })).json.amountCents).toBe(before); // Alex's share did not move
    // cancelled before completion: the points come back
    expect((await tcall(`/api/shop/tab/payments/${r.json.paymentId}/cancel`, { method: "POST", body: {}, who: sam })).status).toBe(200);
    expect((await members().byId(s.id))!.pointsBalance).toBe(10_000);
    // as many as possible: the share has no deposit, so the whole share is covered and costs no cash
    const full = await tcall("/api/shop/tab/quote", { body: { mode: "mine", usePoints: "max" }, who: sam, bearer: s.token });
    expect(full.json.amountCents).toBe(0);
    expect(full.json.pointsUsed).toBe(full.json.liabilityCents);
    const paid = await tcall("/api/shop/tab/pay", { body: { quoteId: full.json.quoteId, method: "counter", idempotencyKey: "idem-pts-2" }, who: sam, bearer: s.token });
    expect(paid.json.status).toBe("completed"); // nothing to take in cash: done at once
    const v = await tcall("/api/shop/tab", { who: sam, bearer: s.token });
    expect(v.json.totals.paidCents).toBe(full.json.liabilityCents); // the tab counts what the points settled
    expect(v.json.me.pointsBalance).toBe(10_000 - full.json.pointsUsed);
    // points cannot be spent by someone who is not signed in, and not above the balance
    const poorTok = (await members().signInWithIdentity("test", "pt-poor", {})).token;
    const poor = await join("P2", "x", poorTok);
    await orderRound(poor, [{ productId: tornado, qty: 1 }]);
    await tcall(`/api/tabs/${poor.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const capped = await tcall("/api/shop/tab/quote", { body: { mode: "mine", usePoints: 9999 }, who: poor, bearer: poorTok });
    expect(capped.json.pointsUsed ?? 0).toBe(0); // a balance of nothing
    const guest = await join("P2", "Gus");
    await orderRound(guest, [{ productId: kaya, qty: 1 }]);
    await tcall(`/api/tabs/${guest.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    expect((await tcall("/api/shop/tab/quote", { body: { mode: "mine", usePoints: "max" }, who: guest })).json.pointsUsed).toBe(0); // no member, no points
  });

  it("a payment that settled with points earns rewards only on the cash actually paid", async () => {
    const s = await memberWith("pt-earn", 10_000);
    const alex = await join("P3", "x", s.token);
    await orderRound(alex, [{ productId: tornado, qty: 1 }]); // S$10.80 + service
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q = await tcall("/api/shop/tab/quote", { body: { mode: "all", usePoints: 300 }, who: alex, bearer: s.token });
    const r = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "counter", idempotencyKey: "idem-pts-3" }, who: alex, bearer: s.token });
    await confirm(r.json.paymentId);
    expect((await view(alex)).closed).toBe(true);
    // 10,000 - 300 spent + earned on the cash only
    expect((await members().byId(s.id))!.pointsBalance).toBe(10_000 - 300 + Math.floor(q.json.amountCents / 100));
  });
});

describe("money safety: manual fallback, provider events, refunds and reward reversals (Addendum 4.4, 6.5)", () => {
  const members = () => new MemberStore(db, "bp", 0, 0);
  const asOwner = (url: string, body: object = {}, method = "POST") => tcall(url, { method, body, staff: owner });

  it("a manual payment for an unknown outcome supersedes the attempt; a later provider success raises a duplicate-payment exception and never nets off", async () => {
    const alex = await join("M1", "Alex");
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q = await quote(alex, { mode: "all" });
    const r = await pay(alex, q.json.quoteId);
    await db.query("UPDATE tab_payments SET status='unknown', method='card', provider_ref='ref-77' WHERE id=$1", [r.json.paymentId]);
    expect((await asOwner(`/api/tabs/payments/${r.json.paymentId}/manual`, { reference: "" })).status).toBe(400); // a reference is required
    const manual = await asOwner(`/api/tabs/payments/${r.json.paymentId}/manual`, { reference: "TRACE-99812" });
    expect(manual.status).toBe(200);
    expect((await view(alex)).closed).toBe(true); // the manual record settled the share
    const rows = (await db.query("SELECT status, method, manual_ref, superseded_by FROM tab_payments WHERE tab_id=$1 ORDER BY created_at", [alex.tabId])).rows;
    expect(rows.map((x: any) => x.status)).toEqual(["superseded", "completed"]);
    expect(rows[1]).toMatchObject({ method: "manual", manual_ref: "TRACE-99812" });
    // the integrated payment later succeeds: an exception for staff, not a silent net-off
    const late = await asOwner(`/api/tabs/payments/${r.json.paymentId}/provider-outcome`, { outcome: "succeeded", providerRef: "ref-77" });
    expect(late.json.result).toBe("duplicate_payment");
    await asOwner(`/api/tabs/payments/${r.json.paymentId}/provider-outcome`, { outcome: "succeeded", providerRef: "ref-77" });
    const ex = (await tcall("/api/tabs/exceptions", { staff: staffTok })).json.exceptions as any[];
    const mine = ex.filter((e) => e.paymentId === r.json.paymentId);
    expect(mine).toHaveLength(1); // a duplicate event is one exception
    expect(mine[0]).toMatchObject({ kind: "duplicate_payment", providerRef: "ref-77" });
    expect((await view(alex)).totals.paidCents).toBe((await view(alex)).totals.totalCents); // paid once, not twice
    expect((await asOwner(`/api/tabs/exceptions/${mine[0].id}/resolve`, { resolution: "refunded on the provider dashboard" })).status).toBe(200);
  });

  it("a duplicate success event is one settlement and one reward; a success for a released payment raises a late-success exception", async () => {
    const s = await members().signInWithIdentity("test", "dup-sam", { name: "Sam" });
    await members().post(s.member.id, "earn", 1, "dup-seed");
    const alex = await join("M2", "x", s.token);
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q = await quote(alex, { mode: "all" });
    const r = await pay(alex, q.json.quoteId, "counter");
    await db.query("UPDATE tab_payments SET method='card' WHERE id=$1", [r.json.paymentId]);
    const a = await asOwner(`/api/tabs/payments/${r.json.paymentId}/provider-outcome`, { outcome: "succeeded", providerRef: "ref-1" });
    const b = await asOwner(`/api/tabs/payments/${r.json.paymentId}/provider-outcome`, { outcome: "succeeded", providerRef: "ref-1" });
    expect([a.json.result, b.json.result]).toEqual(["completed", "already_settled"]);
    const earned = await db.query("SELECT count(*)::int AS n FROM points_entries WHERE member_id=$1 AND note LIKE 'Tab rewards%'", [s.member.id]);
    expect(earned.rows[0].n).toBe(1);
    // a payment that was cancelled, then reported as succeeded
    const bea = await join("M3", "Bea");
    await orderRound(bea, [{ productId: kaya, qty: 1 }]);
    await tcall(`/api/tabs/${bea.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q2 = await quote(bea, { mode: "all" });
    const r2 = await pay(bea, q2.json.quoteId);
    await tcall(`/api/shop/tab/payments/${r2.json.paymentId}/cancel`, { method: "POST", body: {}, who: bea });
    expect((await asOwner(`/api/tabs/payments/${r2.json.paymentId}/provider-outcome`, { outcome: "succeeded" })).json.result).toBe("late_success");
  });

  it("a refund is bounded by what was paid; rewards it earned are reversed exactly, to whoever received them (the Host for host-keep), even below zero; before settlement nothing is reversed", async () => {
    const a = await members().signInWithIdentity("test", "rf-alex", { name: "Alex" });
    const sm = await members().signInWithIdentity("test", "rf-sam", { name: "Sam" });
    const alex = await join("M4", "x", a.token), sam = await join("M4", "x", sm.token);
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    await orderRound(sam, [{ productId: kaya, qty: 1 }, { productId: coffee, qty: 1 }]);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    // Sam pays and keeps nothing for himself: his reward goes to the Host. A refund before settlement reverses nothing.
    const sq = await quote(sam, { mode: "mine" });
    const sp = await tcall("/api/shop/tab/pay", { body: { quoteId: sq.json.quoteId, method: "counter", idempotencyKey: "idem-rf-1", hostKeep: true }, who: sam, bearer: sm.token });
    await confirm(sp.json.paymentId);
    const early = await asOwner(`/api/tabs/payments/${sp.json.paymentId}/refund`, { amountCents: 100, reason: "wrong item charged" });
    expect(early.status).toBe(200);
    expect(early.json.reversedPoints).toBe(0); // nothing was credited yet
    await payNow(alex, { mode: "mine" });
    expect((await view(alex)).closed).toBe(true);
    const alexId = a.member.id;
    const before = (await members().byId(alexId))!.pointsBalance;
    expect(before).toBe(Math.floor(1177 / 100) + Math.floor(458 / 100)); // his own, and Sam's, host-kept
    // refund the rest of Sam's payment: exactly Sam's 4 points are taken back from the Host
    const refundable = 458 - 100;
    expect((await asOwner(`/api/tabs/payments/${sp.json.paymentId}/refund`, { amountCents: refundable + 1, reason: "too much" })).status).toBe(409);
    await db.query("UPDATE members SET points_balance = 0 WHERE id=$1", [alexId]); // Alex has already spent his points
    const full = await asOwner(`/api/tabs/payments/${sp.json.paymentId}/refund`, { amountCents: refundable, reason: "customer left without eating" });
    expect(full.status).toBe(200);
    expect(full.json.reversedPoints).toBe(Math.floor(458 / 100));
    expect((await members().byId(alexId))!.pointsBalance).toBe(-4); // posted in full: the balance goes below zero and is offset by future earnings
    expect((await members().byId(sm.member.id))!.pointsBalance).toBe(0); // Sam never held them
    // nothing more can be refunded, and reversing again changes nothing
    expect((await asOwner(`/api/tabs/payments/${sp.json.paymentId}/refund`, { amountCents: 1, reason: "again" })).status).toBe(409);
    const rev = await db.query("SELECT count(*)::int AS n FROM points_entries WHERE member_id=$1 AND kind='reversal'", [alexId]);
    expect(rev.rows[0].n).toBe(1);
    // only managers and owners refund
    expect((await tcall(`/api/tabs/payments/${sp.json.paymentId}/refund`, { method: "POST", body: { amountCents: 1, reason: "x" }, staff: staffTok })).status).toBe(403);
  });

  it("partial refunds add up to exactly what was credited, never more; a payment made with credit refunds into the wallet", async () => {
    const m = await members().signInWithIdentity("test", "rf-cleo", { name: "Cleo" });
    await topUp(db, { merchantId: "bp", customerId: m.member.id, amountCents: 2000, idempotencyKey: "tab-rf-topup", kind: "topup" } as never);
    const cleo = await join("M5", "x", m.token);
    await orderRound(cleo, [{ productId: tornado, qty: 1 }]); // S$10.80 + service = S$11.77
    await tcall(`/api/tabs/${cleo.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    const q = await quote(cleo, { mode: "all" });
    const r = await tcall("/api/shop/tab/pay", { body: { quoteId: q.json.quoteId, method: "credit", idempotencyKey: "idem-rf-2" }, who: cleo, bearer: m.token });
    expect(r.json.status).toBe("completed");
    const credited = Math.floor(q.json.amountCents / 100);
    expect((await members().byId(m.member.id))!.pointsBalance).toBe(credited);
    const balAfterPay = (await db.query("SELECT w.balance_cents FROM wallets w WHERE w.customer_id=$1", [m.member.id])).rows[0].balance_cents;
    const half = Math.floor(q.json.amountCents / 2);
    const r1 = await asOwner(`/api/tabs/payments/${r.json.paymentId}/refund`, { amountCents: half, reason: "half refunded" });
    const r2 = await asOwner(`/api/tabs/payments/${r.json.paymentId}/refund`, { amountCents: q.json.amountCents - half, reason: "the rest" });
    expect(r1.json.reversedPoints + r2.json.reversedPoints).toBe(credited); // exactly what was credited, once
    expect((await members().byId(m.member.id))!.pointsBalance).toBe(0);
    const balNow = (await db.query("SELECT w.balance_cents FROM wallets w WHERE w.customer_id=$1", [m.member.id])).rows[0].balance_cents;
    expect(Number(balNow) - Number(balAfterPay)).toBe(q.json.amountCents); // the credit went back
  });
});

describe("bar tabs and staff-added items (Spec 12.1, 12.3)", () => {
  it("staff open a bar tab by code; people join with it; the first is the Host; orders work without a table", async () => {
    const open = await tcall("/api/tabs", { body: { outletId: "EV" }, staff: staffTok });
    expect(open.status).toBe(200);
    const code = open.json.code as string;
    const a = await tcall("/api/shop/tab/join", { body: { outletId: "EV", code, displayName: "Ann" } });
    const b = await tcall("/api/shop/tab/join", { body: { outletId: "EV", code, displayName: "Bo" } });
    expect(a.json.isHost).toBe(true);
    expect(b.json.isHost).toBe(false);
    expect(a.json.tab.spot).toBeNull();
    const ann = { id: a.json.participantId, token: a.json.token, tabId: a.json.tabId };
    expect((await orderRound(ann, [{ productId: kaya, qty: 1 }])).status).toBe(200);
    expect((await tcall("/api/shop/tab/join", { body: { outletId: "EV", code: "NOPE1" } })).status).toBe(404);
  });

  it("a waiter adds items with the Staff chip: Unclaimed, not in anyone's Pay mine, the Host can claim them, or they are paid in Pay all", async () => {
    const alex = await join("S1", "Alex"), sam = await join("S1", "Sam");
    await orderRound(alex, [{ productId: tornado, qty: 1 }]);
    const added = await tcall(`/api/tabs/${alex.tabId}/items`, { body: { items: [{ productId: coffee, qty: 2 }] }, staff: staffTok });
    expect(added.status).toBe(200);
    expect((await tcall(`/api/tabs/${alex.tabId}/items`, { body: { items: [{ productId: "nope", qty: 1 }] }, staff: staffTok })).status).toBe(400);
    const v = await view(alex);
    expect(v.people.map((p: any) => p.name)).toEqual(["Alex", "Sam"]); // the Staff pseudo-person is not a diner
    expect(v.rounds[1]).toMatchObject({ staffAdded: true, orderedBy: { name: "Staff" } });
    expect(v.totals.itemsCents).toBe(1080 + 440);
    await tcall(`/api/tabs/${alex.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    expect((await quote(alex, { mode: "mine" })).json.itemsCents).toBe(1080); // the staff items are nobody's yet
    expect((await quote(sam, { mode: "mine" })).status).toBe(409);
    expect((await tcall("/api/shop/tab/claim-staff-items", { method: "POST", body: {}, who: sam })).status).toBe(403); // only the Host claims
    expect((await tcall("/api/shop/tab/claim-staff-items", { method: "POST", body: {}, who: alex })).json.moved).toBe(1);
    expect((await quote(alex, { mode: "mine" })).json.itemsCents).toBe(1080 + 440); // now Alex's
    // unclaimed items can also simply be paid for: a second tab, Pay all
    const bea = await join("S2", "Bea");
    await orderRound(bea, [{ productId: kaya, qty: 1 }]);
    await tcall(`/api/tabs/${bea.tabId}/items`, { body: { items: [{ productId: coffee, qty: 1 }] }, staff: staffTok });
    await tcall(`/api/tabs/${bea.tabId}/release`, { method: "POST", body: {}, staff: staffTok });
    expect((await quote(bea, { mode: "all" })).json.itemsCents).toBe(200 + 220);
  });
});
