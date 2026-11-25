import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, type OrderEvent } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff, resetRolePermissions } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// Handout 4.10: staff roles and per-permission gates. The owner decides what a cashier or manager may do alone; the server enforces it.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let deviceId = "";
let owner = "", mgr = "", cashier = "";
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
let n = 0;
const ev = (orderId: string, body: object) => ({ id: `p-${++n}`, orderId, deviceId, ts: Date.now() + n, seq: n, ...body }) as unknown as OrderEvent;
const paidOrder = async (id: string) => call("/api/sync/push", { body: { events: [
  ev(id, { type: "OrderOpened", fulfilment: "takeaway" }),
  ev(id, { type: "ItemAdded", lineId: "l1", productId: "x", name: "Tea", unitCents: 500, qty: 1 }),
  ev(id, { type: "PaymentRecorded", paymentId: `${id}-pay`, method: "cash", amountCents: 500, confirmed: true }),
] } });
const login = async (code: string, pin: string) => (await call("/api/auth/login", { body: { code, pin } })).json;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const till = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!;
  device = till.token; deviceId = till.device.id;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "555555" });
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "CAT", name: "Cat", role: "cashier", pin: "3333" });
  owner = (await login("OWN", "555555")).token; mgr = (await login("MGR", "222222")).token; cashier = (await login("CAT", "3333")).token;
}, 120_000);
afterAll(async () => {
  resetRolePermissions();
  await app?.close();
  await stop?.();
});

describe("what staff may do", () => {
  it("starts as before: a cashier needs a manager to refund, a manager does not", async () => {
    const view = (await call("/api/settings/permissions", { staff: cashier })).json;
    expect(view.roles.cashier).toEqual(expect.arrayContaining(["wallet.read", "wallet.spend", "wallet.topup", "print.reprint"]));
    expect(view.roles.cashier).not.toContain("order.refund");
    expect(view.roles.manager).toEqual(expect.arrayContaining(["order.refund", "discount.approve", "shift.approve"]));
    expect((await login("CAT", "3333")).staff.permissions).not.toContain("order.refund");
    await paidOrder("po-1");
    const alone = await call("/api/orders/po-1/refund", { body: { paymentId: "po-1-pay", amountCents: 100, reason: "spilled", refundId: "r1" }, staff: cashier });
    expect(alone.status).toBe(428);
    expect(alone.json.error).toBe("manager_approval_needed");
    expect((await call("/api/orders/po-1/refund", { body: { paymentId: "po-1-pay", amountCents: 100, reason: "spilled", refundId: "r1", approverCode: "MGR", approverPin: "222222" }, staff: cashier })).status).toBe(200);
  });

  it("only the owner changes it", async () => {
    expect((await call("/api/settings/permissions", { method: "PUT", body: { cashier: ["order.refund"] }, staff: mgr })).status).toBe(403);
    expect((await call("/api/settings/permissions", { method: "PUT", body: { cashier: "everything" }, staff: owner })).status).toBe(400);
  });

  it("the owner lets cashiers refund: no manager is asked for, and the cashier's next sign-in says so", async () => {
    const r = await call("/api/settings/permissions", { method: "PUT", body: { cashier: ["wallet.topup", "print.reprint", "order.refund"] }, staff: owner });
    expect(r.status).toBe(200);
    expect(r.json.roles.cashier).toEqual(expect.arrayContaining(["wallet.read", "wallet.spend", "order.refund"])); // selling itself is never switched off
    await paidOrder("po-2");
    expect((await call("/api/orders/po-2/refund", { body: { paymentId: "po-2-pay", amountCents: 100, reason: "wrong item", refundId: "r2" }, staff: cashier })).status).toBe(200);
    expect((await login("CAT", "3333")).staff.permissions).toContain("order.refund");
  });

  it("a manager can be stopped from approving refunds: their PIN no longer approves one", async () => {
    await call("/api/settings/permissions", { method: "PUT", body: { cashier: ["wallet.topup", "print.reprint"], manager: ["wallet.topup", "print.reprint", "audit.read", "catalog.manage", "wallet.refund", "device.manage", "print.manage", "discount.approve", "shift.approve"] }, staff: owner });
    await paidOrder("po-3");
    const refused = await call("/api/orders/po-3/refund", { body: { paymentId: "po-3-pay", amountCents: 100, reason: "test", refundId: "r3", approverCode: "MGR", approverPin: "222222" }, staff: cashier });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toBe("approver_cannot_approve");
    expect((await call("/api/orders/po-3/refund", { body: { paymentId: "po-3-pay", amountCents: 100, reason: "test", refundId: "r3", approverCode: "OWN", approverPin: "555555" }, staff: cashier })).status).toBe(200); // the owner always can
  });

  it("a name that is not offered for the role is ignored, and switching off the back office really closes it", async () => {
    const r = await call("/api/settings/permissions", { method: "PUT", body: { cashier: ["staff.manage", "device.manage", "wallet.topup"], manager: ["order.refund", "wallet.topup"] }, staff: owner });
    expect(r.json.roles.cashier).not.toContain("staff.manage");
    expect(r.json.roles.cashier).not.toContain("device.manage");
    expect(r.json.roles.manager).not.toContain("audit.read");
    expect((await call("/api/reports/credit", { staff: mgr })).status).toBe(200); // reading credit is part of selling
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV" }, staff: mgr })).status).toBe(403); // setting up outlets was switched off
  });

  it("the choice is kept: it is still there when the server starts again", async () => {
    const saved = (await db.query("SELECT value FROM merchant_settings WHERE merchant_id='bp' AND key='permissions'")).rows[0].value;
    expect(saved.manager).toEqual(expect.arrayContaining(["order.refund", "wallet.topup"]));
    expect(saved.manager).not.toContain("device.manage");
  });
});

describe("one person different from their role", () => {
  let catId = "", maxId = "", ownId = "";
  const person = async (id: string) => ((await call("/api/staff", { staff: owner })).json.staff as any[]).find((x) => x.id === id);
  it("starts from the role: put the roles back, and find the people", async () => {
    await call("/api/settings/permissions", { method: "PUT", body: { cashier: ["wallet.topup", "print.reprint"], manager: ["wallet.topup", "print.reprint", "audit.read", "catalog.manage", "wallet.refund", "device.manage", "print.manage", "order.refund", "discount.approve", "shift.approve"] }, staff: owner });
    const list = (await call("/api/staff", { staff: owner })).json.staff as any[];
    catId = list.find((x) => x.code === "CAT").id; maxId = list.find((x) => x.code === "MGR").id; ownId = list.find((x) => x.code === "OWN").id;
    expect((await person(catId)).permissions).not.toContain("order.refund");
  });
  it("Cat alone is allowed to refund: she needs no manager, and another cashier still would", async () => {
    await createStaff(db, { merchantId: "bp", code: "DAN", name: "Dan", role: "cashier", pin: "4444" });
    const dan = (await login("DAN", "4444")).token as string;
    expect((await call(`/api/staff/${catId}/permissions`, { method: "PUT", body: { allow: ["order.refund"] }, staff: mgr })).status).toBe(403); // only the owner
    const set = await call(`/api/staff/${catId}/permissions`, { method: "PUT", body: { allow: ["order.refund", "staff.manage", "nonsense"], deny: [] }, staff: owner });
    expect(set.json.allow).toEqual(["order.refund"]); // managing staff can never be given, and unknown names are dropped
    expect(set.json.permissions).toContain("order.refund");
    await paidOrder("pp-1");
    expect((await call("/api/orders/pp-1/refund", { body: { paymentId: "pp-1-pay", amountCents: 100, reason: "spill", refundId: "pr1" }, staff: cashier })).status).toBe(200); // her open session is allowed at once
    expect((await call("/api/orders/pp-1/refund", { body: { paymentId: "pp-1-pay", amountCents: 100, reason: "spill", refundId: "pr2" }, staff: dan })).status).toBe(428);
    expect((await login("CAT", "3333")).staff.permissions).toContain("order.refund");
    // and her code and PIN now approve a refund for someone else
    expect((await call("/api/orders/pp-1/refund", { body: { paymentId: "pp-1-pay", amountCents: 100, reason: "spill", refundId: "pr2", approverCode: "CAT", approverPin: "3333" }, staff: dan })).status).toBe(200);
  });
  it("Max alone is stopped from setting up outlets, while other managers are not; selling cannot be taken away", async () => {
    const set = await call(`/api/staff/${maxId}/permissions`, { method: "PUT", body: { deny: ["device.manage", "wallet.spend"] }, staff: owner });
    expect(set.json.deny).toEqual(["device.manage"]);
    expect(set.json.permissions).toContain("wallet.spend");
    expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "EV" }, staff: mgr })).status).toBe(403);
    expect((await call("/api/reports/credit", { staff: mgr })).status).toBe(200);
    expect((await person(maxId)).deny).toEqual(["device.manage"]);
  });
  it("the same permission in both lists is taken away, and an owner's login cannot be changed", async () => {
    const both = await call(`/api/staff/${catId}/permissions`, { method: "PUT", body: { allow: ["order.refund", "audit.read"], deny: ["order.refund"] }, staff: owner });
    expect(both.json).toMatchObject({ allow: ["audit.read"], deny: ["order.refund"] });
    expect(both.json.permissions).not.toContain("order.refund");
    expect((await call(`/api/staff/${ownId}/permissions`, { method: "PUT", body: { deny: ["audit.read"] }, staff: owner })).status).toBe(400);
    expect((await call(`/api/staff/${catId}/permissions`, { method: "PUT", body: { allow: "all" }, staff: owner })).status).toBe(400);
    await call(`/api/staff/${catId}/permissions`, { method: "PUT", body: { allow: [], deny: [] }, staff: owner });
    await call(`/api/staff/${maxId}/permissions`, { method: "PUT", body: { allow: [], deny: [] }, staff: owner });
    expect((await person(catId)).permissions).toEqual(expect.arrayContaining(["wallet.read", "wallet.spend", "wallet.topup", "print.reprint"]));
  });
});

