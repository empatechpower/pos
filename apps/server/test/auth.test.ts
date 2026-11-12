import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { CASHIER_TOPUP_LIMIT_CENTS, MAX_FAILED_ATTEMPTS, createStaff } from "../src/auth.js";
import { StaticCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { JsonFileEventStore } from "../src/store.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  app = await buildApp({ config, db, catalog: new StaticCatalogStore(seedCatalog()), logger: false, store: new JsonFileEventStore("/tmp/pos-auth-test-events.json") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const code = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  deviceTok = (await enroll(db, "bp", code.code, "Test till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olivia Owner", role: "owner", pin: "111111" });
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max Manager", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat Cashier", role: "cashier", pin: "3333" });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

// Real HTTP against a listening server. Fastify's inject() needs Node 22; this repo runs on 20.
let base = "";
let deviceTok = "";
interface Reply {
  statusCode: number;
  json: () => any;
}
async function send(method: string, url: string, body?: object, token?: string): Promise<Reply> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(deviceTok ? { "x-device-token": deviceTok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await res.json().catch(() => null);
  return { statusCode: res.status, json: () => parsed };
}
const post = (url: string, body: object, token?: string) => send("POST", url, body, token);
const get = (url: string, token?: string) => send("GET", url, undefined, token);
const signIn = async (code: string, pin: string) => (await post("/api/auth/login", { code, pin })).json().token as string;

let n = 0;
const key = () => `k${++n}`;

describe("sign in", () => {
  it("returns a token and the staff member's role", async () => {
    const r = await post("/api/auth/login", { code: "C1", pin: "3333" });
    expect(r.statusCode).toBe(200);
    expect(r.json().staff).toEqual({ name: "Cat Cashier", code: "C1", role: "cashier" });
    expect((await get("/api/auth/me", r.json().token)).json().role).toBe("cashier");
  });

  it("gives the same answer for a wrong PIN and an unknown code", async () => {
    const wrong = await post("/api/auth/login", { code: "MGR", pin: "000000" });
    const unknown = await post("/api/auth/login", { code: "NOPE", pin: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("locks the account after repeated wrong PINs, even for the right PIN, until the lock passes", async () => {
    await createStaff(db, { merchantId: "bp", code: "LOCK", name: "Lock Test", role: "cashier", pin: "4444" });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await post("/api/auth/login", { code: "LOCK", pin: "9999" });
    const blocked = await post("/api/auth/login", { code: "LOCK", pin: "4444" });
    expect(blocked.statusCode).toBe(429);
    await db.query("UPDATE staff SET locked_until = now() - interval '1 minute' WHERE code='LOCK'");
    expect((await post("/api/auth/login", { code: "LOCK", pin: "4444" })).statusCode).toBe(200);
  });

  it("a good sign-in resets the failure count", async () => {
    await createStaff(db, { merchantId: "bp", code: "RESET", name: "Reset Test", role: "cashier", pin: "5555" });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await post("/api/auth/login", { code: "RESET", pin: "0000" });
    await post("/api/auth/login", { code: "RESET", pin: "5555" });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await post("/api/auth/login", { code: "RESET", pin: "0000" });
    expect((await post("/api/auth/login", { code: "RESET", pin: "5555" })).statusCode).toBe(200);
  });

  it("logout and expiry end a session", async () => {
    const t = await signIn("C1", "3333");
    await post("/api/auth/logout", {}, t);
    expect((await get("/api/auth/me", t)).statusCode).toBe(401);

    const t2 = await signIn("C1", "3333");
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await get("/api/auth/me", t2)).statusCode).toBe(401);
  });

  it("never stores the PIN or the session token in the clear", async () => {
    const t = await signIn("C1", "3333");
    const staff = await db.query("SELECT pin_hash FROM staff WHERE code='C1'");
    expect(staff.rows[0].pin_hash).not.toContain("3333");
    const s = await db.query("SELECT token_hash FROM sessions");
    expect(s.rows.some((r) => r.token_hash === t)).toBe(false);
  });

  it("deactivating a staff member ends their access immediately", async () => {
    await createStaff(db, { merchantId: "bp", code: "GONE", name: "Gone Soon", role: "cashier", pin: "6666" });
    const t = await signIn("GONE", "6666");
    expect((await get("/api/auth/me", t)).statusCode).toBe(200);
    await db.query("UPDATE staff SET active=false WHERE code='GONE'");
    expect((await get("/api/auth/me", t)).statusCode).toBe(401);
    expect((await post("/api/auth/login", { code: "GONE", pin: "6666" })).statusCode).toBe(401);
  });
});

describe("money needs a signed-in staff member with the right role", () => {
  it("rejects every wallet call with no session", async () => {
    expect((await get("/api/wallet/c1")).statusCode).toBe(401);
    expect((await post("/api/wallet/topup", { customerId: "c1", amountCents: 100, idempotencyKey: key() })).statusCode).toBe(401);
    expect((await post("/api/wallet/spend", { customerId: "c1", amountCents: 100, idempotencyKey: key() })).statusCode).toBe(401);
  });

  it("lets a cashier top up and spend, and records who did it", async () => {
    const t = await signIn("C1", "3333");
    expect((await post("/api/wallet/topup", { customerId: "w1", amountCents: 5000, idempotencyKey: key() }, t)).statusCode).toBe(200);
    expect((await post("/api/wallet/spend", { customerId: "w1", amountCents: 1200, idempotencyKey: key() }, t)).statusCode).toBe(200);
    const rows = await db.query(
      "SELECT s.code FROM ledger_entries e JOIN staff s ON s.id=e.staff_id JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id='w1'",
    );
    expect(rows.rows.map((r) => r.code)).toEqual(["C1", "C1"]);
  });

  it("caps a cashier's single top-up, but not a manager's", async () => {
    const cashier = await signIn("C1", "3333");
    const over = await post("/api/wallet/topup", { customerId: "w2", amountCents: CASHIER_TOPUP_LIMIT_CENTS + 1, idempotencyKey: key() }, cashier);
    expect(over.statusCode).toBe(403);
    expect(over.json().error).toBe("over_limit");
    const manager = await signIn("MGR", "222222");
    expect((await post("/api/wallet/topup", { customerId: "w2", amountCents: CASHIER_TOPUP_LIMIT_CENTS + 1, idempotencyKey: key() }, manager)).statusCode).toBe(200);
  });

  it("only managers and owners can refund", async () => {
    const cashier = await signIn("C1", "3333");
    const manager = await signIn("MGR", "222222");
    const body = { customerId: "w1", amountCents: 100, orderId: "o1" };
    expect((await post("/api/wallet/spend", { ...body, idempotencyKey: key() }, cashier)).statusCode).toBe(200); // the order the refund reverses
    expect((await post("/api/wallet/refund", { ...body, idempotencyKey: key() }, cashier)).statusCode).toBe(403);
    expect((await post("/api/wallet/refund", { ...body, idempotencyKey: key() }, manager)).statusCode).toBe(200);
  });

  it("keeps a replayed top-up from being audited or credited twice", async () => {
    const t = await signIn("MGR", "222222");
    const k = key();
    await post("/api/wallet/topup", { customerId: "w3", amountCents: 700, idempotencyKey: k }, t);
    await post("/api/wallet/topup", { customerId: "w3", amountCents: 700, idempotencyKey: k }, t);
    expect((await get("/api/wallet/w3", t)).json().balanceCents).toBe(700);
    const a = await db.query("SELECT count(*) FROM audit_log WHERE action='wallet.topup' AND detail->>'customerId'='w3'");
    expect(Number(a.rows[0].count)).toBe(1);
  });
});

describe("staff management and audit", () => {
  it("only an owner can create staff, and the PIN must be 4 to 8 digits", async () => {
    const owner = await signIn("OWN", "111111");
    const manager = await signIn("MGR", "222222");
    const body = { code: "NEW1", name: "New Hire", role: "cashier", pin: "7777" };
    expect((await post("/api/staff", body, manager)).statusCode).toBe(403);
    expect((await post("/api/staff", body, owner)).statusCode).toBe(200);
    expect((await post("/api/staff", { ...body, code: "NEW2", pin: "12" }, owner)).statusCode).toBe(400);
    expect((await post("/api/staff", { ...body, code: "NEW3", role: "god" }, owner)).statusCode).toBe(400);
  });

  it("shows managers an audit trail with who did what, and hides it from cashiers", async () => {
    const manager = await signIn("MGR", "222222");
    const cashier = await signIn("C1", "3333");
    expect((await get("/api/audit", cashier)).statusCode).toBe(403);
    const entries = (await get("/api/audit", manager)).json().entries as Array<{ action: string; staff_code: string }>;
    expect(entries.some((e) => e.action === "wallet.topup" && e.staff_code === "C1")).toBe(true);
    expect(entries.some((e) => e.action === "wallet.refund" && e.staff_code === "MGR")).toBe(true);
    expect(entries.some((e) => e.action === "auth.locked")).toBe(true);
  });
});
