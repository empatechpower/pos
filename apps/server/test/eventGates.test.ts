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

// The event's release gates (Rezein developer handout, section 0): each one is a test.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let cat: PgCatalogStore;
let base = "";
let till = "";
let mgr = "";
let ip = 0;

async function call(url: string, o: { method?: string; body?: object; staff?: string; device?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.device !== "" ? { "x-device-token": o.device ?? till } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  till = (await enroll(db, "bp", c.code, "Manager laptop"))!.token;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

let n = 0;
/** A member with credit, signed in, as the event will have them. */
async function member(creditDollars: number) {
  const email = `gate${++n}@example.com`;
  await call("/api/members", { body: { name: `Gate ${n}`, email, creditCents: creditDollars * 100 }, staff: mgr });
  const s = await call("/api/shop/auth/email/start", { body: { email }, device: "" });
  const v = await call("/api/shop/auth/email/verify", { body: { email, code: s.json.devCode }, device: "" });
  return { token: v.json.token as string, id: v.json.member.id as string };
}
const creditOf = async (id: string) => (await db.query("SELECT balance_cents FROM wallets WHERE merchant_id='bp' AND customer_id=$1", [id])).rows[0]?.balance_cents as number | undefined;
const buy = (token: string | undefined, key: string | undefined, o: object = {}) =>
  call("/api/shop/orders", { staff: token, device: "", body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 2 }], payWithCredit: true, ...(key ? { idempotencyKey: key } : {}), ...o } });

describe("event release gates: credit purchases", () => {
  it("a purchase succeeds, debits once, and creates the paid order in the same step", async () => {
    const m = await member(50);
    const r = await buy(m.token, "gate-success-0001");
    expect(r.status).toBe(200);
    expect(r.json.paidWithCreditCents).toBeGreaterThan(0);
    expect(Number(await creditOf(m.id))).toBe(5000 - r.json.paidWithCreditCents);
    const ev = await db.query("SELECT type FROM events WHERE order_id=$1 ORDER BY server_seq", [r.json.orderId]);
    expect(ev.rows.map((x) => x.type)).toEqual(expect.arrayContaining(["OrderOpened", "OrderAccepted", "PaymentRecorded"]));
  });

  it("insufficient funds are rejected and nothing changes", async () => {
    const m = await member(1);
    const r = await buy(m.token, "gate-poor-00001");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("not_enough_credit");
    expect(Number(await creditOf(m.id))).toBe(100);
    expect((await db.query("SELECT 1 FROM purchase_requests WHERE idem_key='gate-poor-00001'")).rowCount).toBe(0); // free to try again after topping up
  });

  it("a credit purchase without an idempotency key, or from a guest, is refused", async () => {
    const m = await member(20);
    expect((await buy(m.token, undefined)).status).toBe(400);
    expect((await buy(undefined, "gate-guest-0001", { customerPhone: "9123 4567" })).status).toBe(401); // a phone number alone never spends
    expect(Number(await creditOf(m.id))).toBe(2000);
  });

  it("a double tap or retry with the same key never charges twice", async () => {
    const m = await member(50);
    const [a, b] = await Promise.all([buy(m.token, "gate-double-0001"), buy(m.token, "gate-double-0001")]);
    const ok = [a, b].filter((x) => x.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const retry = await buy(m.token, "gate-double-0001"); // after a timeout: same key
    expect(retry.status).toBe(200);
    expect(retry.json.replayed).toBe(true);
    expect(retry.json.orderId).toBe(ok[0]!.json.orderId);
    expect((await db.query("SELECT count(*)::int AS n FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id=$1 AND e.kind='spend'", [m.id])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(DISTINCT order_id)::int AS n FROM events WHERE body->>'memberId'=$1", [m.id])).rows[0].n).toBe(1);
  });

  it("the phone can ask what became of its attempt, and only its own member can", async () => {
    const m = await member(50);
    const other = await member(5);
    const r = await buy(m.token, "gate-status-0001");
    const st = await call("/api/shop/purchases/gate-status-0001", { staff: m.token, device: "" });
    expect(st.json).toMatchObject({ state: "done", orderId: r.json.orderId });
    expect((await call("/api/shop/purchases/gate-status-0001", { staff: other.token, device: "" })).status).toBe(404);
    expect((await call("/api/shop/purchases/never-made", { staff: m.token, device: "" })).status).toBe(404);
  });

  it("the same key with different content is refused", async () => {
    const m = await member(50);
    expect((await buy(m.token, "gate-reuse-0001")).status).toBe(200);
    const r = await buy(m.token, "gate-reuse-0001", { items: [{ productId: "kaya-toast", qty: 3 }] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("idempotency_key_reused");
  });

  it("two purchases at once cannot overspend one balance", async () => {
    const m = await member(10); // kaya toast x2 costs about 5, so two fit and a third cannot
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => buy(m.token, `gate-race-000${i}`)));
    const ok = results.filter((x) => x.status === 200).length;
    const short = results.filter((x) => x.json?.error === "not_enough_credit").length;
    expect(ok + short).toBe(5);
    expect(ok).toBeGreaterThanOrEqual(1);
    const left = Number(await creditOf(m.id));
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBe(1000 - results.filter((x) => x.status === 200).reduce((s, x) => s + x.json.paidWithCreditCents, 0));
  });

  it("a price sent by the phone is not trusted: a wrong expected total is stopped before any debit", async () => {
    const m = await member(50);
    const r = await buy(m.token, "gate-tamper-0001", { expectedTotalCents: 1, items: [{ productId: "kaya-toast", qty: 2, unitCents: 1, priceCents: 1 }] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("price_changed");
    expect(Number(await creditOf(m.id))).toBe(5000);
  });

  it("a debit left with no order (the server stopped between the steps) is reversed", async () => {
    const m = await member(30);
    await call("/api/wallet/spend", { body: { customerId: m.id, amountCents: 700, idempotencyKey: "credit-order:orphan-1", orderId: "orphan-1" }, staff: mgr });
    await db.query("UPDATE ledger_entries SET created_at = now() - interval '5 minutes' WHERE idempotency_key='credit-order:orphan-1'");
    expect(Number(await creditOf(m.id))).toBe(2300);
    // The sweep runs when the server starts, and every few minutes.
    const again = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
    for (let i = 0; i < 40 && Number(await creditOf(m.id)) !== 3000; i++) await new Promise((r) => setTimeout(r, 100));
    await again.close();
    expect(Number(await creditOf(m.id))).toBe(3000);
    // and only once
    const back = await db.query("SELECT count(*)::int AS n FROM ledger_entries WHERE idempotency_key='credit-back:orphan-1'");
    expect(back.rows[0].n).toBe(1);
  });
});

describe("event release gates: refunds and the books", () => {
  it("a refund is a linked reversal: it names its order, is bounded by what the order took, and a duplicate is refused", async () => {
    const m = await member(50);
    const r = await buy(m.token, "gate-refund-0001");
    const spent = r.json.paidWithCreditCents as number;
    const refund = (amount: number, key: string) => call("/api/wallet/refund", { body: { customerId: m.id, amountCents: amount, idempotencyKey: key, orderId: r.json.orderId }, staff: mgr });
    expect((await call("/api/wallet/refund", { body: { customerId: m.id, amountCents: 10, idempotencyKey: "gate-noorder-1" }, staff: mgr })).status).toBe(400);
    expect((await refund(spent + 1, "gate-over-0001")).json.error).toBe("over_refund");
    const first = await refund(100, "gate-part-0001");
    expect(first.status).toBe(200);
    expect((await refund(100, "gate-part-0001")).json.replayed).toBe(true); // same key: same entry, not a second refund
    const dup = await refund(spent, "gate-part-0002"); // would take it past what the order took
    expect(dup.status).toBe(409);
    expect(dup.json.remainingCents).toBe(spent - 100);
    expect((await refund(spent - 100, "gate-part-0003")).status).toBe(200);
    expect((await refund(1, "gate-part-0004")).json.error).toBe("over_refund");
    expect(Number(await creditOf(m.id))).toBe(5000);
    // the original debit is still there
    expect((await db.query("SELECT count(*)::int AS n FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id=$1 AND e.kind='spend'", [m.id])).rows[0].n).toBe(1);
  });

  it("two refunds at once cannot both pass the limit", async () => {
    const m = await member(50);
    const r = await buy(m.token, "gate-refund-0002");
    const spent = r.json.paidWithCreditCents as number;
    const res = await Promise.all([1, 2, 3].map((i) => call("/api/wallet/refund", { body: { customerId: m.id, amountCents: spent, idempotencyKey: `gate-race-ref-${i}`, orderId: r.json.orderId }, staff: mgr })));
    expect(res.filter((x) => x.status === 200)).toHaveLength(1);
    expect(Number(await creditOf(m.id))).toBe(5000);
  });

  it("the money reconciles: opening + credits - debits + reversals = closing, and every wallet matches its entries", async () => {
    const r = await call("/api/wallet/reconciliation", { staff: mgr });
    expect(r.status).toBe(200);
    expect(r.json.balanced).toBe(true);
    expect(r.json.mismatchedWallets).toEqual([]);
    expect(r.json.openingCents).toBeGreaterThan(0);
    expect(r.json.debitsCents).toBeLessThan(0);
    expect(r.json.openingCents + r.json.creditsCents + r.json.debitsCents + r.json.reversalsCents + r.json.adjustmentsCents).toBe(r.json.closingCents);
  });
});
