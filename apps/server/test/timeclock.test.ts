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

// Staff attendance: a card tap or a code and PIN clocks a person in and out at a till; the timesheet adds up the hours.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "", mgr = "", cashier = "";
let catId = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

async function call(url: string, o: { method?: string; body?: unknown; staff?: string; noDevice?: boolean } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(device && !o.noDevice ? { "x-device-token": device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const login = async (code: string, pin: string) => (await call("/api/auth/login", { body: { code, pin } })).json.token as string;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
/** Move a person's last punch back in time, as if it happened earlier. */
const age = (minutes: number) => db.query("UPDATE time_entries SET clock_in = clock_in - make_interval(mins => $1), clock_out = clock_out - make_interval(mins => $1) WHERE staff_id=$2", [minutes, catId]);

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "555555" });
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "CAT", name: "Cat", role: "cashier", pin: "3333" });
  owner = await login("OWN", "555555"); mgr = await login("MGR", "222222"); cashier = await login("CAT", "3333");
  catId = ((await call("/api/staff", { staff: owner })).json.staff as any[]).find((s) => s.code === "CAT").id;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("cards", () => {
  it("the owner gives Cat a card; its number is never sent back whole, and one card is one person", async () => {
    expect((await call(`/api/staff/${catId}/card`, { method: "PUT", body: { card: "04a2b9c1d7" }, staff: mgr })).status).toBe(403);
    const set = await call(`/api/staff/${catId}/card`, { method: "PUT", body: { card: "04a2b9c1d7" }, staff: owner });
    expect(set.json).toEqual({ ok: true, card: "···C1D7" });
    const list = (await call("/api/staff", { staff: owner })).json.staff as any[];
    expect(list.find((s) => s.code === "CAT").card).toBe("···C1D7");
    const max = list.find((s) => s.code === "MGR");
    const dup = await call(`/api/staff/${max.id}/card`, { method: "PUT", body: { card: "04A2B9C1D7" }, staff: owner });
    expect(dup.status).toBe(409);
    expect(dup.json.message).toContain("Cat");
    expect((await call(`/api/staff/${max.id}/card`, { method: "PUT", body: { card: "!!" }, staff: owner })).status).toBe(400);
  });
});

describe("clocking in and out", () => {
  it("needs an enrolled till, and a card that is known", async () => {
    expect((await call("/api/time/punch", { body: { card: "04A2B9C1D7" }, noDevice: true })).status).toBe(401);
    const unknown = await call("/api/time/punch", { body: { card: "FFFFFFFF" } });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("card_not_known");
  });
  it("a tap clocks in; a second tap straight after changes nothing; a later tap clocks out with the time worked", async () => {
    const first = await call("/api/time/punch", { body: { card: "04a2b9c1d7" } });
    expect(first.json).toMatchObject({ name: "Cat", action: "in" });
    expect((await call("/api/time/punch", { body: { card: "04A2B9C1D7" } })).json).toMatchObject({ action: "in", repeated: true });
    expect((await call("/api/time/me", { staff: cashier })).json.clockedIn).toBe(true);
    await age(125);
    const out = await call("/api/time/punch", { body: { card: "04A2B9C1D7" } });
    expect(out.json).toMatchObject({ name: "Cat", action: "out", workedMinutes: 125 });
    expect((await call("/api/time/me", { staff: cashier })).json.clockedIn).toBe(false);
    expect((await call("/api/time/punch", { body: { card: "04A2B9C1D7" } })).json).toMatchObject({ action: "out", repeated: true }); // a double tap on the way out
  });
  it("without a card: staff code and PIN; a wrong PIN clocks nobody", async () => {
    expect((await call("/api/time/punch", { body: { code: "MGR", pin: "000000" } })).status).toBe(401);
    expect((await call("/api/time/punch", { body: { code: "MGR", pin: "222222" } })).json).toMatchObject({ name: "Max", action: "in" });
    expect((await call("/api/time/punch", { body: {} })).status).toBe(400);
  });
});

describe("the timesheet", () => {
  it("adds up each person's hours for the dates asked for, and shows who is still in", async () => {
    await age(10); // Cat's last spell ended more than a minute ago, so she can start another
    await call("/api/time/punch", { body: { card: "04A2B9C1D7" } });
    await age(30);
    await call("/api/time/punch", { body: { card: "04A2B9C1D7" } });
    const t = (await call(`/api/time/entries?from=${today()}&to=${today()}`, { staff: mgr })).json;
    const catTotal = t.totals.find((x: any) => x.name === "Cat");
    expect(catTotal).toMatchObject({ minutes: 155, spells: 2, open: false });
    expect(t.totals.find((x: any) => x.name === "Max")).toMatchObject({ spells: 1, open: true });
    expect(t.entries.filter((e: any) => e.name === "Cat").map((e: any) => e.inMethod)).toEqual(["card", "card"]);
    expect((await call(`/api/time/entries?from=${today()}`, { staff: cashier })).status).toBe(403); // a cashier does not read the timesheet
    expect((await call("/api/time/entries?from=tomorrow", { staff: mgr })).status).toBe(400);
  });
  it("a spell left open for longer than a working day is flagged as forgotten, not counted", async () => {
    await db.query("UPDATE time_entries SET clock_in = now() - interval '20 hours' WHERE staff_name='Max' AND clock_out IS NULL");
    const yesterday = new Date(Date.now() - 24 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
    const t = (await call(`/api/time/entries?from=${yesterday}&to=${today()}`, { staff: mgr })).json;
    expect(t.entries.find((e: any) => e.name === "Max")).toMatchObject({ forgotten: true, minutes: 0, open: true });
    expect(t.totals.find((x: any) => x.name === "Max")).toMatchObject({ minutes: 0, forgotten: 1, open: false });
  });
  it("a manager puts it right with a reason; the fix is marked and audited", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
    const e = ((await call(`/api/time/entries?from=${yesterday}&to=${today()}`, { staff: mgr })).json.entries as any[]).find((x) => x.name === "Max");
    expect((await call(`/api/time/entries/${e.id}`, { method: "PUT", body: { clockOut: e.clockIn + 8 * 3600_000 }, staff: mgr })).status).toBe(400); // no reason
    expect((await call(`/api/time/entries/${e.id}`, { method: "PUT", body: { clockOut: e.clockIn - 1000, note: "oops" }, staff: mgr })).status).toBe(400); // out before in
    expect((await call(`/api/time/entries/${e.id}`, { method: "PUT", body: { clockOut: e.clockIn + 8 * 3600_000, note: "Forgot to clock out" }, staff: cashier })).status).toBe(403);
    expect((await call(`/api/time/entries/${e.id}`, { method: "PUT", body: { clockOut: e.clockIn + 8 * 3600_000, note: "Forgot to clock out" }, staff: mgr })).status).toBe(200);
    const after = ((await call(`/api/time/entries?from=${yesterday}&to=${today()}`, { staff: mgr })).json.entries as any[]).find((x) => x.id === e.id);
    expect(after).toMatchObject({ minutes: 480, open: false, forgotten: false, outMethod: "manager", note: "Forgot to clock out", editedBy: "Max" });
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='time.edit'")).rows[0].n).toBe(1);
  });
});
