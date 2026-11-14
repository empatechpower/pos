import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { normalisePhone } from "../src/members.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let till = "";
let tillId = "";
let mgr = "";
let cashier = "";
let ip = 0;

async function call(url: string, o: { method?: string; body?: object; staff?: string; device?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.device !== "" ? { "x-device-token": o.device ?? till } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const signUp = async (email: string, name: string) => {
  const s = await call("/api/shop/auth/email/start", { body: { email }, device: "" });
  const v = await call("/api/shop/auth/email/verify", { body: { email, code: s.json.devCode, name }, device: "" });
  return v.json.member as { id: string; pointsBalance: number };
};
const list = (q = "", staff = mgr) => call(`/api/members${q ? `?q=${encodeURIComponent(q)}` : ""}`, { staff });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  const e = (await enroll(db, "bp", c.code, "Manager laptop"))!;
  till = e.token;
  tillId = e.device.id;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("managing members: points and prepaid credit", () => {
  it("lists members with their points and credit, and searches by name, email or phone", async () => {
    const a = await signUp("ann@example.com", "Ann Tan");
    await signUp("bob@example.com", "Bob Lim");
    await call("/api/shop/me", { method: "PATCH", body: { phone: "+65 9123 4567" }, staff: undefined, device: "" }).catch(() => undefined);
    const all = await list();
    expect(all.json.total).toBeGreaterThanOrEqual(2);
    const ann = all.json.members.find((m: any) => m.id === a.id);
    expect(ann).toMatchObject({ name: "Ann Tan", email: "ann@example.com", points: 500, creditCents: 0 });
    expect((await list("bob@")).json.members.map((m: any) => m.name)).toEqual(["Bob Lim"]);
    expect((await list("tan")).json.members.map((m: any) => m.id)).toContain(a.id);
    expect((await list("zzz-nobody")).json.members).toEqual([]);
  });

  it("needs a signed-in staff member on an enrolled device", async () => {
    expect((await call("/api/members", {})).status).toBe(401);
    expect((await call("/api/members", { staff: mgr, device: "" })).status).toBe(401);
  });

  it("tops up a member's credit through the wallet, and the list shows the balance", async () => {
    const m = await signUp("credit@example.com", "Cara");
    const r = await call("/api/wallet/topup", { body: { customerId: m.id, amountCents: 5000, idempotencyKey: "t1" }, staff: cashier });
    expect(r.json.ok).toBe(true);
    await call("/api/wallet/topup", { body: { customerId: m.id, amountCents: 5000, idempotencyKey: "t1" }, staff: cashier }); // a retry
    expect((await list("credit@")).json.members[0].creditCents).toBe(5000);
  });

  it("a member's credit history lists each movement, newest first, with who made it", async () => {
    const m = await signUp("hist@example.com", "Hana");
    await call("/api/wallet/topup", { body: { customerId: m.id, amountCents: 700, idempotencyKey: "h1" }, staff: mgr });
    await call("/api/wallet/topup", { body: { customerId: m.id, amountCents: 60, idempotencyKey: "h2" }, staff: cashier });
    const h = await call(`/api/members/${m.id}/credit-history`, { staff: mgr });
    expect(h.status).toBe(200);
    expect(h.json.entries.map((e: any) => [e.amountCents, e.balanceAfterCents])).toEqual([[60, 760], [700, 700]]);
    expect(h.json.entries[0].by).toBeTruthy();
    expect((await call(`/api/members/${m.id}/credit-history`, {})).status).toBe(401);
  });

  it("a manager can add or take points with a reason, once per request, and it is recorded", async () => {
    const m = await signUp("pts@example.com", "Pia");
    const add = await call(`/api/members/${m.id}/points`, { body: { points: 100, note: "Apology for a late order", idempotencyKey: "p1" }, staff: mgr });
    expect(add.json).toMatchObject({ balance: 600, replayed: false });
    const again = await call(`/api/members/${m.id}/points`, { body: { points: 100, note: "Apology for a late order", idempotencyKey: "p1" }, staff: mgr });
    expect(again.json).toMatchObject({ balance: 600, replayed: true }); // pressed twice: counted once
    const take = await call(`/api/members/${m.id}/points`, { body: { points: -50, note: "Entered by mistake", idempotencyKey: "p2" }, staff: mgr });
    expect(take.json.balance).toBe(550);
    const me = (await list("pts@")).json.members[0];
    expect(me.points).toBe(550);
    const audit = await db.query("SELECT detail FROM audit_log WHERE action='member.points' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0].detail).toMatchObject({ memberId: m.id, points: -50, note: "Entered by mistake" });
  });

  it("refuses points changes that are not allowed", async () => {
    const m = await signUp("nope@example.com", "Ned");
    const body = (o: object) => ({ body: { points: 10, note: "x", idempotencyKey: `k${Math.random()}`, ...o }, staff: mgr });
    expect((await call(`/api/members/${m.id}/points`, { body: { points: 10, note: "x", idempotencyKey: "c1" }, staff: cashier })).status).toBe(403);
    expect((await call(`/api/members/${m.id}/points`, body({ note: "" }))).status).toBe(400); // a reason is required
    expect((await call(`/api/members/${m.id}/points`, body({ points: 0 }))).status).toBe(400);
    expect((await call(`/api/members/${m.id}/points`, body({ points: 1.5 }))).status).toBe(400);
    expect((await call(`/api/members/${m.id}/points`, body({ points: -100000 }))).status).toBe(409); // more than they have
    expect((await call(`/api/members/00000000-0000-0000-0000-000000000000/points`, body({}))).status).toBe(404);
    expect((await list("nope@")).json.members[0].points).toBe(500);
  });
});

const createMember = (body: object, staff = mgr) => call("/api/members", { body, staff });
const importRows = (rows: object[], staff = mgr) => call("/api/members/import", { body: { rows }, staff });
const emailIn = async (email: string) => {
  const s = await call("/api/shop/auth/email/start", { body: { email }, device: "" });
  return (await call("/api/shop/auth/email/verify", { body: { email, code: s.json.devCode }, device: "" })).json as { token: string; member: { id: string } };
};
const credit = async (memberId: string) => (await call(`/api/members?q=${encodeURIComponent(memberId.slice(0, 8))}`, { staff: mgr })).json;

describe("phone numbers", () => {
  it("are put in one form so a person is found however it was typed", () => {
    expect(normalisePhone("9123 4567")).toBe("+6591234567");
    expect(normalisePhone("+65 9123-4567")).toBe("+6591234567");
    expect(normalisePhone("6591234567")).toBe("+6591234567");
    expect(normalisePhone("0060 12 345 6789")).toBe("+60123456789");
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("abc")).toBeNull();
    expect(normalisePhone("")).toBeNull();
  });
});

describe("adding members by hand", () => {
  it("creates a member with opening credit, and finds them by phone", async () => {
    const r = await createMember({ name: "Mei Lin", phone: "9000 1111", creditCents: 5000 });
    expect(r.json).toMatchObject({ created: true, member: { name: "Mei Lin", phone: "+659000111" + "1" }, creditCents: 5000 });
    const found = (await list("90001111")).json.members;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ phone: "+65900011" + "11", creditCents: 5000, points: 500 }); // the welcome gift is whatever the shop has set; with rewards off it is zero
  });

  it("does not make a second member, or add credit again, for someone already there", async () => {
    const a = await createMember({ name: "Dee", email: "dee@example.com", phone: "9000 2222", creditCents: 1000 });
    const again = await createMember({ name: "Dee T", email: "DEE@example.com", creditCents: 9999 });
    expect(again.json).toMatchObject({ created: false, creditCents: 1000 });
    expect(again.json.member.id).toBe(a.json.member.id);
    const byPhone = await createMember({ phone: "+65 9000 2222", creditCents: 777 });
    expect(byPhone.json).toMatchObject({ created: false, creditCents: 1000 });
  });

  it("refuses what cannot work", async () => {
    expect((await createMember({ name: "Nobody" })).status).toBe(400); // no way to sign in
    expect((await createMember({ phone: "12" })).status).toBe(400);
    expect((await createMember({ email: "not-an-email" })).status).toBe(400);
    expect((await createMember({ phone: "9000 3333", creditCents: -5 })).status).toBe(400);
    expect((await createMember({ phone: "9000 3333", creditCents: 25_000 }, cashier)).status).toBe(403); // over the cashier limit
    expect((await call("/api/members", { body: { phone: "9000 3333" } })).status).toBe(401);
  });

  it("a member made here signs in by email and finds their credit waiting", async () => {
    await createMember({ name: "Zed", email: "zed@example.com", creditCents: 3000 });
    const s = await emailIn("zed@example.com");
    const me = await call("/api/shop/me", { staff: s.token, device: "" });
    expect(me.json.member.name).toBe("Zed");
    expect(me.json.creditCents).toBe(3000);
  });
});

describe("importing a list of members", () => {
  it("creates the new ones with credit, skips people already there, and says what was wrong with the rest", async () => {
    await createMember({ name: "Existing", email: "existing@example.com", creditCents: 100 });
    const r = await importRows([
      { name: "Ann", email: "ann.import@example.com", credit: "20" },
      { name: "Ben", phone: "9000 4444", credit: 12.5 },
      { name: "Existing", email: "existing@example.com", credit: 999 },
      { name: "Nobody" },
      { name: "Bad phone", phone: "7" },
      { name: "Bad credit", email: "bc@example.com", credit: "lots" },
    ]);
    expect(r.json).toMatchObject({ created: 2, existed: 1, invalid: 3, creditedCents: 3250 });
    expect(r.json.results.map((x: any) => x.status)).toEqual(["created", "created", "exists", "invalid", "invalid", "invalid"]);
    expect((await list("ann.import")).json.members[0].creditCents).toBe(2000);
    expect((await list("90004444")).json.members[0].creditCents).toBe(1250);
    expect((await list("existing@")).json.members[0].creditCents).toBe(100); // untouched
    // the same file again changes nothing
    const again = await importRows([{ name: "Ann", email: "ann.import@example.com", credit: "20" }, { name: "Ben", phone: "9000 4444", credit: 12.5 }]);
    expect(again.json).toMatchObject({ created: 0, existed: 2, creditedCents: 0 });
    expect((await list("ann.import")).json.members[0].creditCents).toBe(2000);
  });

  it("is for managers, and refuses an empty or huge file", async () => {
    expect((await importRows([{ email: "x@example.com" }], cashier)).status).toBe(403);
    expect((await importRows([])).status).toBe(400);
    expect((await importRows(Array.from({ length: 1001 }, (_, i) => ({ email: `m${i}@example.com` })))).status).toBe(400);
  });
});

describe("paying for an order with member credit", () => {
  const order = (token: string | undefined, o: object = {}) => call("/api/shop/orders", { staff: token, device: "", body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 2 }], customerPhone: "9123 4567", ...((o as { payWithCredit?: boolean }).payWithCredit ? { idempotencyKey: `k-${++ip}-${Math.random().toString(36).slice(2)}` } : {}), ...o } });
  const creditOf = async (email: string) => (await list(email)).json.members[0].creditCents as number;

  it("takes the credit, marks the order paid and accepted, and it is ready for the kitchen", async () => {
    await createMember({ name: "Cy", email: "cy@example.com", creditCents: 2000 });
    const s = await emailIn("cy@example.com");
    const quote = await order(s.token, { payWithCredit: true });
    expect(quote.status).toBe(200);
    const total = quote.json.totalCents;
    expect(quote.json).toMatchObject({ paidWithCreditCents: total, status: "queued", creditBalanceCents: 2000 - total });
    expect(await creditOf("cy@")).toBe(2000 - total);
    const st = (await call(`/api/shop/orders/${quote.json.orderId}`, { device: "" })).json;
    expect(st).toMatchObject({ status: "queued", paidCents: total, canCancel: false });
  });

  it("frozen credit cannot be spent online or by staff, balances stay, and unfreezing restores it", async () => {
    await createMember({ name: "Fay", email: "fay@example.com", creditCents: 2000 });
    const s = await emailIn("fay@example.com");
    expect((await call("/api/credit/freeze", { staff: mgr })).json.frozen).toBe(false);
    expect((await call("/api/credit/freeze", { body: { frozen: true }, staff: cashier, method: "PUT" })).status).toBe(403);
    expect((await call("/api/credit/freeze", { body: { frozen: true }, staff: mgr, method: "PUT" })).json.frozen).toBe(true);
    expect((await call("/api/shop/info", { device: "" })).json.creditFrozen).toBe(true);
    const r = await order(s.token, { payWithCredit: true });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("credit_frozen");
    expect(await creditOf("fay@")).toBe(2000);
    await call("/api/credit/freeze", { body: { frozen: false }, staff: mgr, method: "PUT" });
    expect((await order(s.token, { payWithCredit: true })).status).toBe(200);
  });

  it("stops, and changes nothing, when there is not enough credit", async () => {
    await createMember({ name: "Di", email: "di@example.com", creditCents: 50 });
    const s = await emailIn("di@example.com");
    const r = await order(s.token, { payWithCredit: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "not_enough_credit", balanceCents: 50 });
    expect(await creditOf("di@")).toBe(50);
  });

  it("needs a signed-in member", async () => {
    expect((await order(undefined, { payWithCredit: true })).status).toBe(401);
  });

  it("an order placed without credit is still held for staff and takes nothing", async () => {
    await createMember({ name: "Ed", email: "ed@example.com", creditCents: 1000 });
    const s = await emailIn("ed@example.com");
    const r = await order(s.token);
    expect(r.json.status).toBe("received");
    expect(await creditOf("ed@")).toBe(1000);
  });

  it("gives the credit back, once, when staff cancel the order", async () => {
    await createMember({ name: "Flo", email: "flo@example.com", creditCents: 2000 });
    const s = await emailIn("flo@example.com");
    const r = await order(s.token, { payWithCredit: true });
    const total = r.json.totalCents;
    expect(await creditOf("flo@")).toBe(2000 - total);
    const cancel = (id: string) => call("/api/sync/push", { body: { events: [{ id, orderId: r.json.orderId, deviceId: tillId, ts: Date.now(), seq: Math.floor(Math.random() * 1e6), type: "StageSet", stage: "cancelled" }] } });
    await cancel("cancel-1");
    expect(await creditOf("flo@")).toBe(2000);
    await cancel("cancel-2"); // pressed again
    expect(await creditOf("flo@")).toBe(2000);
  });
});
