import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, reduceOrder } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { cleanGiftCode, newGiftCode, showGiftCode } from "../src/giftcards.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// Gift cards with balances (developer handout 4.11): sold and loaded, spent as a tender, refunded back onto the card.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let store: PgEventStore;
let base = "";
let ip = 0;
let device = { token: "", id: "" };
let owner = "", cashier = "";
let n = 0;
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

async function call(url: string, o: { method?: string; body?: unknown; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), "x-device-token": device.token, ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const sell = (amountCents: number, extra: object = {}, staff = cashier) => call("/api/giftcards/load", { staff, body: { amountCents, idempotencyKey: `load-${++n}`, ...extra } });
const redeem = (code: string, amountCents: number, key = `spend-${++n}`) => call(`/api/giftcards/${code}/redeem`, { staff: cashier, body: { amountCents, orderId: `o${n}`, idempotencyKey: key } });
const balance = async (code: string) => (await call(`/api/giftcards/${code}`, { staff: cashier })).json?.card?.balanceCents;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  store = new PgEventStore(db, "bp", "EV");
  app = await buildApp({ config, db, logger: false, store, catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const e = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!;
  device = { token: e.token, id: e.device.id };
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "555555" });
  await createStaff(db, { merchantId: "bp", code: "CAT", name: "Cat", role: "cashier", pin: "3333" });
  owner = (await call("/api/auth/login", { body: { code: "OWN", pin: "555555" } })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "CAT", pin: "3333" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("gift card codes", () => {
  it("are capitals and digits; spaces and dashes are ignored; new ones leave out look-alikes", () => {
    expect(cleanGiftCode("ab12-cd34 ef56")).toBe("AB12CD34EF56");
    expect(cleanGiftCode("abc")).toBeNull();
    expect(cleanGiftCode("has_underscore")).toBeNull();
    const c = newGiftCode();
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{12}$/);
    expect(showGiftCode("AB12CD34EF56")).toBe("AB12 CD34 EF56");
  });
});

describe("selling and loading a card", () => {
  it("makes up a code, holds the amount, and needs someone signed in", async () => {
    expect((await call("/api/giftcards/load", { body: { amountCents: 5000, idempotencyKey: "nobody-1" } })).status).toBe(401);
    const r = await sell(5000);
    expect(r.status).toBe(200);
    expect(r.json.card).toMatchObject({ balanceCents: 5000, active: true });
    expect(await balance(r.json.card.code)).toBe(5000);
  });
  it("takes a pre-printed code once, and the same request twice loads once", async () => {
    const key = `load-${++n}`;
    const a = await call("/api/giftcards/load", { staff: cashier, body: { code: "gift-0001", amountCents: 2000, idempotencyKey: key } });
    const again = await call("/api/giftcards/load", { staff: cashier, body: { code: "gift-0001", amountCents: 2000, idempotencyKey: key } });
    expect(a.json.card.code).toBe("GIFT0001");
    expect(again.json).toMatchObject({ replayed: true });
    expect(await balance("GIFT0001")).toBe(2000);
    // a second "new card" under the same code is refused; loading more onto it has to say it is an existing card
    expect((await sell(1000, { code: "GIFT0001" })).json).toMatchObject({ error: "code_taken" });
    expect((await sell(1000, { code: "GIFT0001", existing: true })).json.card.balanceCents).toBe(3000);
    expect((await sell(1000, { code: "NOSUCHCARD", existing: true })).status).toBe(404);
    expect((await sell(1000, { code: "!!" })).status).toBe(400);
  });
  it("caps a cashier at S$200 a load; a manager or owner is not capped", async () => {
    expect((await sell(20_001)).json).toMatchObject({ error: "over_cashier_limit", limitCents: 20_000 });
    expect((await sell(50_000, {}, owner)).status).toBe(200);
    expect((await sell(0)).status).toBe(400);
  });
  it("counts cash taken for a card in the cashier's open drawer, and nothing when it was paid by card", async () => {
    const sh = (await call("/api/shifts/open", { staff: cashier, body: { openingFloatCents: 5000 } })).json.shift;
    const cash = await sell(3000, { tender: "cash" });
    const card = await sell(4000, { tender: "card" });
    expect(cash.json.inDrawer).toBe(true);
    expect(card.json.inDrawer).toBe(false);
    const rep = (await call(`/api/shifts/${sh.id}/report`, { staff: cashier })).json;
    expect(rep.cashIn.map((m: { amountCents: number }) => m.amountCents)).toEqual([3000]);
    expect(rep.cashIn[0].reason).toMatch(/^Gift card /);
    expect(rep.expectedCashCents).toBe(8000);
  });
});

describe("spending a card", () => {
  it("takes the amount, never more than it holds, and the same payment twice takes it once", async () => {
    const code = (await sell(1000)).json.card.code;
    expect((await redeem(code, 1500)).json).toMatchObject({ error: "insufficient_funds", balanceCents: 1000 });
    expect(await balance(code)).toBe(1000);
    const a = await redeem(code, 600, "same-payment");
    const b = await redeem(code, 600, "same-payment");
    expect(a.json.card.balanceCents).toBe(400);
    expect(b.json).toMatchObject({ replayed: true });
    expect(await balance(code)).toBe(400);
    expect((await redeem("NOSUCHCARD", 100)).status).toBe(404);
    // typed with spaces and in small letters, it is the same card
    expect((await redeem(showGiftCode(code).toLowerCase(), 400)).json.card.balanceCents).toBe(0);
  });
  it("two tills spending one card at once cannot take more than is on it", async () => {
    const code = (await sell(1000)).json.card.code;
    const all = await Promise.all(Array.from({ length: 6 }, () => redeem(code, 300)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(3);
    expect(all.filter((r) => r.json?.error === "insufficient_funds")).toHaveLength(3);
    expect(await balance(code)).toBe(100);
    const hist = (await call(`/api/giftcards/${code}`, { staff: cashier })).json.entries;
    expect(hist.map((e: { amountCents: number }) => e.amountCents).reduce((x: number, y: number) => x + y, 0)).toBe(100);
  });
  it("a switched-off card cannot be spent or loaded; only a manager switches it", async () => {
    const code = (await sell(1000)).json.card.code;
    expect((await call(`/api/giftcards/${code}`, { method: "PUT", staff: cashier, body: { active: false } })).status).toBe(403);
    expect((await call(`/api/giftcards/${code}`, { method: "PUT", staff: owner, body: { active: false } })).json.card.active).toBe(false);
    expect((await redeem(code, 100)).json).toMatchObject({ error: "card_inactive" });
    expect((await sell(100, { code, existing: true })).json).toMatchObject({ error: "card_inactive" });
    expect(await balance(code)).toBe(1000);
    await call(`/api/giftcards/${code}`, { method: "PUT", staff: owner, body: { active: true } });
    expect((await redeem(code, 100)).status).toBe(200);
  });
});

describe("an order paid with a gift card", () => {
  const push = (orderId: string, evs: object[]) => call("/api/sync/push", { staff: cashier, body: { events: evs.map((e, i) => ({ id: `${orderId}-e${i}`, orderId, deviceId: device.id, ts: Date.now() + i, seq: ++n + 10_000, ...e })) } });
  it("puts a refund back on the card, once, and a void returns the rest", async () => {
    const code = (await sell(2000)).json.card.code;
    await redeem(code, 800);
    const pushed = await push("gc-order-1", [
      { type: "OrderOpened", fulfilment: "takeaway", channelId: "take-away", channelName: "Take away", serviceCharge: false, queueNumber: "G001" },
      { type: "ItemAdded", lineId: "l1", productId: "kaya-toast", name: "Kaya Toast", unitCents: 800, qty: 1 },
      { type: "PaymentRecorded", paymentId: "p-gc", method: "other", tender: "giftcard", reference: code, amountCents: 800, confirmed: true },
    ]);
    expect(pushed.status).toBe(200);
    expect(await balance(code)).toBe(1200);
    const part = await call("/api/orders/gc-order-1/refund", { staff: owner, body: { paymentId: "p-gc", amountCents: 300, reason: "Wrong item", refundId: "refund-gc-0001" } });
    expect(part.json).toMatchObject({ ok: true, manual: false });
    expect(await balance(code)).toBe(1500);
    // the same refund sent again changes nothing
    await call("/api/orders/gc-order-1/refund", { staff: owner, body: { paymentId: "p-gc", amountCents: 300, reason: "Wrong item", refundId: "refund-gc-0001" } });
    expect(await balance(code)).toBe(1500);
    const voided = await call("/api/orders/gc-order-1/void", { staff: owner, body: { reason: "Customer left", voidId: "void-gc-0001" } });
    expect(voided.status).toBe(200);
    expect(await balance(code)).toBe(2000);
    expect(reduceOrder("gc-order-1", await store.eventsForOrder("gc-order-1"))!.voided).toBeTruthy();
  });
});

describe("what the shop owes on its cards", () => {
  it("lists the cards and the total outstanding, for managers", async () => {
    expect((await call("/api/giftcards", { staff: cashier })).status).toBe(403);
    const r = (await call("/api/giftcards", { staff: owner })).json;
    const sum = (await db.query("SELECT COALESCE(SUM(balance_cents),0) AS s FROM gift_cards WHERE merchant_id='bp'")).rows[0].s;
    expect(r.outstandingCents).toBe(Number(sum));
    expect(r.cards.length).toBeGreaterThan(5);
    // every card's balance is the sum of its entries
    const off = (await db.query("SELECT c.code FROM gift_cards c LEFT JOIN gift_card_entries e ON e.card_id=c.id GROUP BY c.id HAVING c.balance_cents <> COALESCE(SUM(e.amount_cents),0)")).rows;
    expect(off).toEqual([]);
    // the books balance: loaded + redeemed (negative) + refunded = what is owed
    const b = r.books;
    expect(b.mismatched).toEqual([]);
    expect(b.loadedCents + b.redeemedCents + b.refundedCents + b.adjustedCents).toBe(r.outstandingCents + (Number(sum) - r.outstandingCents));
  });
});
