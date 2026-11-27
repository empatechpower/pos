import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import { sweepLapsed } from "../src/ledger.js";
import type { Db } from "../src/db/pool.js";

// The owner's credit rules (25 Nov 2026): valid one year from the last top-up; a top-up within three months of expiry brings it back;
// the smallest top-up is S$10; all three are settings.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "", cashier = "";
let n = 0;
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
const topup = (customerId: string, amountCents: number, key = `k${++n}`) => call("/api/wallet/topup", { body: { customerId, amountCents, idempotencyKey: key }, staff: cashier });
const spendIt = (customerId: string, amountCents: number) => call("/api/wallet/spend", { body: { customerId, amountCents, idempotencyKey: `k${++n}`, orderId: `o${n}` }, staff: cashier });
const state = async (customerId: string) => (await call(`/api/wallet/${customerId}/state`, { staff: cashier })).json;
/** Make every entry on a wallet this many days older, as if time had passed. */
const age = (customerId: string, days: number) => db.query("UPDATE ledger_entries SET created_at = created_at - make_interval(days => $2) WHERE wallet_id = (SELECT id FROM wallets WHERE merchant_id='bp' AND customer_id=$1)", [customerId, days]);

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "555555" });
  await createStaff(db, { merchantId: "bp", code: "CAT", name: "Cat", role: "cashier", pin: "3333" });
  owner = (await call("/api/auth/login", { body: { code: "OWN", pin: "555555" } })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "CAT", pin: "3333" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("how long credit lasts", () => {
  it("starts at one year, three months and S$10; only the owner changes them", async () => {
    expect((await call("/api/settings/credit", { staff: cashier })).json).toEqual({ validityDays: 365, reinstateDays: 90, minTopupCents: 1000 });
    expect((await call("/api/settings/credit", { method: "PUT", body: { minTopupCents: 500 }, staff: cashier })).status).toBe(403);
    expect((await call("/api/settings/credit", { method: "PUT", body: { validityDays: -1 }, staff: owner })).status).toBe(400);
  });
  it("a top-up below the minimum is refused; at the minimum it is taken", async () => {
    const low = await topup("alice", 999);
    expect(low.status).toBe(400);
    expect(low.json).toMatchObject({ error: "below_minimum", minCents: 1000 });
    expect((await topup("alice", 1000)).status).toBe(200);
    const s = await state("alice");
    expect(s).toMatchObject({ state: "active", balanceCents: 1000 });
    expect(Math.round((s.expiresAt - s.lastTopupAt) / 86_400_000)).toBe(365);
  });
  it("each top-up starts the year again", async () => {
    await age("alice", 300);
    expect((await state("alice")).state).toBe("active");
    await topup("alice", 2000);
    await age("alice", 300); // 600 days after the first top-up, 300 after the second
    expect(await state("alice")).toMatchObject({ state: "active", balanceCents: 3000 });
    expect((await spendIt("alice", 500)).status).toBe(200);
  });
  it("past its year, credit cannot be spent, but the balance is kept", async () => {
    await age("alice", 100); // 400 days after the last top-up
    expect((await state("alice")).state).toBe("expired");
    const r = await spendIt("alice", 100);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "credit_expired", state: "expired" });
    expect((await state("alice")).balanceCents).toBe(2500);
  });
  it("a top-up within the three months brings the whole balance back", async () => {
    expect((await topup("alice", 1000)).status).toBe(200);
    expect(await state("alice")).toMatchObject({ state: "active", balanceCents: 3500 });
    expect((await spendIt("alice", 3500)).status).toBe(200);
  });
  it("past the three months it has lapsed: it stays unspendable, and the next top-up writes it off and starts clean", async () => {
    await topup("bob", 5000);
    await age("bob", 365 + 91);
    expect((await state("bob")).state).toBe("lapsed");
    expect((await spendIt("bob", 100)).json.error).toBe("credit_expired");
    expect((await state("bob")).balanceCents).toBe(5000); // nothing is taken until a top-up happens
    expect((await topup("bob", 1500)).status).toBe(200);
    expect(await state("bob")).toMatchObject({ state: "active", balanceCents: 1500 });
    const off = await db.query("SELECT e.amount_cents, e.note FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id='bob' AND e.kind='adjust'");
    expect(off.rows).toHaveLength(1);
    expect(Number(off.rows[0].amount_cents)).toBe(-5000);
    expect(off.rows[0].note).toContain("not reinstated in time");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='wallet.lapsed'")).rows[0].n).toBe(1);
  });
  it("a retried top-up (same key) is not judged twice", async () => {
    const first = await topup("carol", 1000, "same-key");
    expect(first.status).toBe(200);
    await call("/api/settings/credit", { method: "PUT", body: { minTopupCents: 5000 }, staff: owner });
    const again = await topup("carol", 1000, "same-key");
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect((await topup("carol", 1000)).status).toBe(400);
  });
  it("the shop can switch expiry off: 0 days means credit never expires", async () => {
    expect((await call("/api/settings/credit", { method: "PUT", body: { validityDays: 0, minTopupCents: 0 }, staff: owner })).json).toEqual({ validityDays: 0, reinstateDays: 90, minTopupCents: 0 });
    await topup("dan", 100);
    await age("dan", 5000);
    expect(await state("dan")).toMatchObject({ state: "active", expiresAt: null });
    expect((await spendIt("dan", 100)).status).toBe(200);
  });
});

describe("lapsed credit is written off on the day", () => {
  it("the hourly sweep writes off only lapsed wallets, once, and a later top-up does not write it off again", async () => {
    await call("/api/settings/credit", { method: "PUT", body: { validityDays: 365, reinstateDays: 90, minTopupCents: 1000 }, staff: owner });
    await topup("sweep-lapsed", 5000); await age("sweep-lapsed", 365 + 91);
    await topup("sweep-expired", 4000); await age("sweep-expired", 365 + 10);
    await topup("sweep-active", 3000);
    const before = (await call("/api/wallet/sweep-lapsed", { staff: cashier })).json.balanceCents;
    expect(before).toBe(5000);
    const r = await sweepLapsed(db, "bp");
    expect(r.wallets).toBeGreaterThanOrEqual(1);
    expect((await state("sweep-lapsed")).balanceCents).toBe(0);
    expect((await state("sweep-expired")).balanceCents).toBe(4000); // only expired: a top-up can still bring it back
    expect((await state("sweep-active")).balanceCents).toBe(3000);
    // running again changes nothing
    const again = await sweepLapsed(db, "bp");
    expect((await db.query("SELECT count(*)::int AS n FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id='sweep-lapsed' AND e.kind='adjust'")).rows[0].n).toBe(1);
    expect(again.cents).toBe(0);
    // a top-up afterwards starts a clean balance, with no second write-off
    await topup("sweep-lapsed", 2000);
    expect((await state("sweep-lapsed")).balanceCents).toBe(2000);
    expect((await db.query("SELECT count(*)::int AS n FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id='sweep-lapsed' AND e.kind='adjust'")).rows[0].n).toBe(1);
  });
});
