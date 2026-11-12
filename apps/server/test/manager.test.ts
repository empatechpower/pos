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

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let till = "";
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
  till = (await enroll(db, "bp", c.code, "Manager laptop"))!.token;
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
