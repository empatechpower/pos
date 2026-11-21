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

// Backend handout section 7 and fixture 9: pickup slots come from the menu window less the prep time; a scheduled order
// waits and is released to the kitchen at slot minus prep. Menu: Fri 11:00-20:30, Sat 11:00-15:30. Prep 15 minutes.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let evMgr = "";
let clock = Date.parse("2026-11-20T10:00:00+08:00");
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
const at = (iso: string) => Date.parse(iso);

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
let toastId = "";
let soupId = "";
const WINDOWS = { menu: [{ day: 5, start: "11:00", end: "20:30" }, { day: 6, start: "11:00", end: "15:30" }] };
const menu = async () => (await call("/api/shop/menu?outlet=WIN")).json;
const stateOf = (m: any, id: string) => m.products.find((p: any) => p.id === id).availability;
const order = (productId: string) => call("/api/shop/orders", { body: { channelId: "take-away", outletId: "WIN", items: [{ productId, qty: 1 }], customerName: "T", customerPhone: "" } });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true, now: () => clock });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  await createStaff(db, { merchantId: "bp", code: "EVM", name: "Eve", role: "manager", pin: "222222", outletId: "EV" });
  owner = await login("OWN", "999999");
  evMgr = await login("EVM", "222222");
  expect((await call("/api/outlets/WIN", { method: "PUT", body: { name: "Window shop", serviceMode: "qsr", prepMinutes: 15 }, staff: owner })).status).toBe(200);
  const toast = await call("/api/catalog/products", { body: { name: "Window Toast", category: "Toast", priceCents: 300 }, staff: owner });
  const soup = await call("/api/catalog/products", { body: { name: "Window Soup", category: "Mains", priceCents: 600 }, staff: owner });
  expect(toast.status).toBe(200);
  const products = (await call("/api/catalog")).json.products as any[];
  toastId = products.find((p) => p.name === "Window Toast").id;
  soupId = products.find((p) => p.name === "Window Soup").id;
  expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: WINDOWS }, staff: owner })).status).toBe(200);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

const FRI = (hm: string) => Date.parse(`2026-11-20T${hm}:00+08:00`);
const SAT = (hm: string) => Date.parse(`2026-11-21T${hm}:00+08:00`);
const order2 = (pickupAt: number) => call("/api/shop/orders", { body: { channelId: "take-away", outletId: "WIN", items: [{ productId: toastId, qty: 1 }], customerName: "T", customerPhone: "", pickupAt } });
const hm = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
const eventTypes = async (orderId: string) => (await db.query("SELECT type FROM events WHERE merchant_id='bp' AND order_id=$1 ORDER BY server_seq", [orderId])).rows.map((r: any) => r.type as string);

describe("scheduled pickup on the server", () => {
  it("is off until the outlet turns it on", async () => {
    expect((await call("/api/shop/slots?outlet=WIN")).status).toBe(400);
    expect((await order2(SAT("12:00"))).json.error).toBe("scheduling_off");
    expect((await call("/api/outlets/WIN/scheduling", { method: "PUT", body: { on: true, intervalMinutes: 15, daysAhead: 3 }, staff: owner })).json.on).toBe(true);
    expect((await call("/api/outlets/WIN/scheduling", { method: "PUT", body: { intervalMinutes: 7 }, staff: owner })).status).toBe(400);
  });

  it("offers slots inside the window, after prep, and none on a closed day", async () => {
    const today = (await call("/api/shop/slots?outlet=WIN&date=2026-11-20")).json;
    expect(hm(today.slots[0])).toBe("11:00");
    expect(hm(today.slots[today.slots.length - 1])).toBe("20:15");
    const tomorrow = (await call("/api/shop/slots?outlet=WIN&date=2026-11-21")).json;
    expect(hm(tomorrow.slots[0])).toBe("11:00");
    expect(hm(tomorrow.slots[tomorrow.slots.length - 1])).toBe("15:15");
    expect((await call("/api/shop/slots?outlet=WIN&date=2026-11-22")).json.slots).toEqual([]);
  });

  it("refuses a slot outside the window, off the interval or too far ahead", async () => {
    expect((await order2(SAT("16:00"))).json.error).toBe("slot_not_available");
    expect((await order2(SAT("12:07"))).json.error).toBe("slot_not_available");
    expect((await order2(Date.parse("2026-12-05T12:00:00+08:00"))).json.error).toBe("slot_not_available");
  });

  it("holds a scheduled order until its slot less the prep time, then releases it once", async () => {
    const r = await order2(SAT("12:00"));
    expect(r.status).toBe(200);
    const id = r.json.orderId as string;
    expect((await call(`/api/shop/orders/${id}`)).json.scheduledFor).toBe(SAT("12:00"));
    clock = SAT("11:44");
    await (app as any).fireScheduledOrders();
    expect(await eventTypes(id)).not.toContain("OrderFired");
    clock = SAT("11:45");
    await (app as any).fireScheduledOrders();
    await (app as any).fireScheduledOrders();
    expect((await eventTypes(id)).filter((t) => t === "OrderFired").length).toBe(1);
  });

  it("an ASAP order is unchanged", async () => {
    clock = FRI("12:00");
    const r = await order(toastId);
    expect(r.status).toBe(200);
    expect(await eventTypes(r.json.orderId)).not.toContain("OrderFired");
  });
});
