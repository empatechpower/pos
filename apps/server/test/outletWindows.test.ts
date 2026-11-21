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

// Backend handout section 6 and fixture 8: outside the menu window an item is AVAILABLE_LATER, add-to-cart is refused by the server,
// and at the boundary the menu version changes and the state flips without a reload. The audited menu: Fri 11:00-20:30, Sat 11:00-15:30.

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
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("menu time windows on the server", () => {
  it("no windows set: everything is orderable, and the version does not move with the clock", async () => {
    const a = await menu();
    expect(stateOf(a, toastId)).toEqual({ state: "ORDERABLE" });
    expect(a.menuState.state).toBe("ORDERABLE");
    clock = at("2026-11-22T03:00:00+08:00");
    expect((await menu()).menuVersion).toBe(a.menuVersion);
    expect((await order(toastId)).status).toBe(200);
  });

  it("fixture 8: outside the window an item is AVAILABLE_LATER with the next opening, and the server refuses to add it", async () => {
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: WINDOWS }, staff: owner })).status).toBe(200);
    clock = at("2026-11-20T10:00:00+08:00");
    const m = await menu();
    expect(stateOf(m, toastId)).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: at("2026-11-20T11:00:00+08:00"), window: { day: 5, start: "11:00", end: "20:30" } });
    expect(m.menuState).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: at("2026-11-20T11:00:00+08:00") });
    expect(m.timeZone).toBe("Asia/Singapore");
    const refused = await order(toastId);
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: "available_later", productId: toastId, nextOpeningAt: at("2026-11-20T11:00:00+08:00") });
    const stores = (await call("/api/shop/stores")).json.stores as any[];
    expect(stores.find((s) => s.id === "WIN").menu).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: at("2026-11-20T11:00:00+08:00") });
    expect(stores.find((s) => s.id === "EV").menu.state).toBe("ORDERABLE"); // another outlet has no windows
  });

  it("at the boundary the version changes by itself and the state flips with no reload; again when it closes", async () => {
    clock = at("2026-11-20T10:59:00+08:00");
    const before = await menu();
    clock = at("2026-11-20T11:00:00+08:00");
    const open = await menu();
    expect(open.menuVersion).not.toBe(before.menuVersion);
    expect((await call("/api/shop/menu/version?outlet=WIN")).json.version).toBe(open.menuVersion);
    expect(stateOf(open, toastId)).toEqual({ state: "ORDERABLE", closesAt: at("2026-11-20T20:30:00+08:00") });
    expect((await order(toastId)).status).toBe(200);
    // it stays put while the window is open
    clock = at("2026-11-20T20:29:00+08:00");
    expect((await menu()).menuVersion).toBe(open.menuVersion);
    // and moves on when it closes
    clock = at("2026-11-20T20:30:00+08:00");
    const closed = await menu();
    expect(closed.menuVersion).not.toBe(open.menuVersion);
    expect(stateOf(closed, toastId).state).toBe("AVAILABLE_LATER");
    expect(stateOf(closed, toastId).nextOpeningAt).toBe(at("2026-11-21T11:00:00+08:00"));
    expect((await order(toastId)).status).toBe(400);
  });

  it("a category's or an item's own window overrides the menu's", async () => {
    clock = at("2026-11-20T21:00:00+08:00"); // the menu is closed
    const w = { ...WINDOWS, categories: { Mains: [{ day: 5, start: "17:00", end: "23:00" }] }, products: { [toastId]: [{ day: 5, start: "00:00", end: "24:00" }] } };
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: w }, staff: owner })).status).toBe(200);
    const m = await menu();
    expect(stateOf(m, toastId).state).toBe("ORDERABLE"); // its own all-day window
    expect(stateOf(m, soupId).state).toBe("ORDERABLE"); // its category's evening window
    expect((await order(toastId)).status).toBe(200);
    clock = at("2026-11-20T23:30:00+08:00");
    expect(stateOf(await menu(), soupId).state).toBe("AVAILABLE_LATER");
    expect((await order(soupId)).json.error).toBe("available_later");
  });

  it("windows are checked, the time zone is real, and only the outlet's own manager (or the owner) may set them", async () => {
    const bad = await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: { menu: [{ day: 9, start: "11:00", end: "12:00" }] } }, staff: owner });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toContain("day must be");
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: "always" }, staff: owner })).status).toBe(400);
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { timeZone: "Mars/Olympus" }, staff: owner })).status).toBe(400);
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: WINDOWS }, staff: evMgr })).status).toBe(403);
    expect((await call("/api/outlets/EV/windows", { method: "PUT", body: { windows: WINDOWS }, staff: evMgr })).status).toBe(200);
    expect((await call("/api/outlets/ghost/windows", { staff: owner })).status).toBe(404);
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: null } })).status).toBe(401);
    // the menu reads on the outlet's own clock: 11:00 in New York is not 11:00 in Singapore
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: WINDOWS, timeZone: "America/New_York" }, staff: owner })).json.timeZone).toBe("America/New_York");
    clock = at("2026-11-20T12:00:00-05:00"); // Friday noon in New York
    expect(stateOf(await menu(), toastId).state).toBe("ORDERABLE");
    clock = at("2026-11-20T12:00:00+08:00"); // Friday noon in Singapore is 23:00 the evening before in New York
    expect(stateOf(await menu(), toastId).state).toBe("AVAILABLE_LATER");
  });

  it("removing the windows makes everything orderable again", async () => {
    expect((await call("/api/outlets/WIN/windows", { method: "PUT", body: { windows: null }, staff: owner })).status).toBe(200);
    clock = at("2026-11-22T03:00:00+08:00");
    expect(stateOf(await menu(), toastId)).toEqual({ state: "ORDERABLE" });
    expect((await call("/api/outlets/WIN/windows", { staff: owner })).json.windows).toBeUndefined();
  });
});
