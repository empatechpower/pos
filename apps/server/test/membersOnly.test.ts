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
let ip = 0;

async function call(url: string, o: { method?: string; body?: object; staff?: string; device?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `192.0.2.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.device !== "" ? { "x-device-token": o.device ?? till } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  process.env.SHOP_MEMBERS_ONLY = "1";
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  delete process.env.SHOP_MEMBERS_ONLY;
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

const phoneIn = async (phone: string) => {
  const s = await call("/api/shop/auth/phone/start", { body: { phone }, device: "" });
  await call("/api/shop/auth/phone/simulate", { body: { phone, code: s.json.code }, device: "" });
  return (await call(`/api/shop/auth/phone/${s.json.id}`, { device: "" })).json as { token: string; member: { id: string } };
};
const order = (token: string | undefined, o: object = {}) => call("/api/shop/orders", { staff: token, device: "", body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty: 2 }], ...((o as { payWithCredit?: boolean }).payWithCredit ? { idempotencyKey: `k-${++ip}-${Math.random().toString(36).slice(2)}` } : {}), ...o } });

describe("members-only shop: phone sign-in and credit only", () => {
  it("says so, and switches email and Google sign-in off", async () => {
    expect((await call("/api/shop/info", { device: "" })).json.membersOnly).toBe(true);
    expect((await call("/api/shop/auth/email/start", { body: { email: "a@example.com" }, device: "" })).status).toBe(404);
    expect((await call("/api/shop/auth/oauth/google/start", { device: "" })).status).toBe(404);
  });

  it("an uploaded member signs in by phone and finds their own credit", async () => {
    await call("/api/members/import", { body: { rows: [{ name: "Mei Lin", phone: "9123 4567", credit: "50" }] }, staff: mgr });
    const s = await phoneIn("6591234567");
    expect(s.token).toBeTruthy();
    const me = (await call("/api/shop/me", { staff: s.token, device: "" })).json;
    expect(me.member.name).toBe("Mei Lin");
    expect(me.creditCents).toBe(5000);
  });

  it("refuses an order from someone not signed in, or not paying with credit", async () => {
    expect((await order(undefined, { payWithCredit: true })).status).toBe(401);
    const s = await phoneIn("6591234567");
    expect((await order(s.token)).status).toBe(400);
    expect((await order(s.token, { customerPhone: "9123 4567" })).status).toBe(400);
  });

  it("a number that is not on the list can sign in but cannot pay, so cannot order", async () => {
    const s = await phoneIn("6598887777");
    expect(s.token).toBeTruthy();
    const r = await order(s.token, { payWithCredit: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("not_enough_credit");
  });

  it("a member with credit orders, and the credit pays for it", async () => {
    const s = await phoneIn("6591234567");
    const r = await order(s.token, { payWithCredit: true });
    expect(r.status).toBe(200);
    expect((await call("/api/shop/me", { staff: s.token, device: "" })).json.creditCents).toBeLessThan(5000);
    // The kitchen ticket names the customer, so a runner can find them even if they change tables.
    const opened = await db.query("SELECT body FROM events WHERE order_id=$1 AND type='OrderOpened'", [r.json.orderId]);
    expect(opened.rows[0].body).toMatchObject({ customerName: "Mei Lin", customerPhone: "+6591234567" });
  });

  it("when no hub phone is running, sign-in still works through a staff member's approval", async () => {
    const info = (await call("/api/shop/info", { device: "" })).json;
    expect(info.auth.phone).toMatchObject({ manual: true });
    const start = await call("/api/shop/auth/phone/start", { body: { phone: "6591234567" }, device: "" });
    expect(start.status).toBe(200);
    expect(start.json.to).toBeNull();
    // Waiting, and only staff can see or approve it.
    expect((await call("/api/members/pending-signins", { device: "" })).status).toBe(401);
    const list = await call("/api/members/pending-signins", { staff: mgr });
    const mine = list.json.pending.find((p: any) => p.id === start.json.id);
    expect(mine).toMatchObject({ phone: "6591234567", name: "Mei Lin" });
    expect(mine.creditCents).toBeGreaterThan(0);
    expect((await call(`/api/shop/auth/phone/${start.json.id}`, { device: "" })).json.state).toBe("pending");
    const ok = await call(`/api/members/pending-signins/${start.json.id}/approve`, { body: {}, staff: mgr });
    expect(ok.status).toBe(200);
    const done = await call(`/api/shop/auth/phone/${start.json.id}`, { device: "" });
    expect(done.json.state).toBe("verified");
    expect(done.json.token).toBeTruthy();
    // It can only be approved once, and is then gone from the list.
    expect((await call(`/api/members/pending-signins/${start.json.id}/approve`, { body: {}, staff: mgr })).status).toBe(404);
    expect((await call("/api/members/pending-signins", { staff: mgr })).json.pending.some((p: any) => p.id === start.json.id)).toBe(false);
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='signin.approve'")).rowCount).toBeGreaterThan(0);
  });

  it("a staff member can turn a waiting sign-in down", async () => {
    const start = await call("/api/shop/auth/phone/start", { body: { phone: "6598880000" }, device: "" });
    expect((await call(`/api/members/pending-signins/${start.json.id}/reject`, { body: {}, staff: mgr })).status).toBe(200);
    expect((await call(`/api/shop/auth/phone/${start.json.id}`, { device: "" })).json.state).toBe("expired");
    expect((await call(`/api/members/pending-signins/${start.json.id}/approve`, { body: {}, staff: mgr })).status).toBe(404);
  });
});
