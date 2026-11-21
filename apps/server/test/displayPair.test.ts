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

// The customer display on a separate device: pairing with a short code, the till publishing what the customer sees, the display reading it.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let evMgr = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

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

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

const screen = async (secret: string, since?: number) => {
  const res = await fetch(`${base}/api/display/state${since !== undefined ? `?since=${since}` : ""}`, { headers: { "x-display-secret": secret, "x-forwarded-for": `198.51.100.${++ip % 250}` } });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const SALE = { mode: "sale", orderType: "Dine in", orderNo: "0128", lines: [{ qty: 2, name: "Original WTM", details: ["Add noodle"], lineCents: 1800 }], totals: [{ key: "subtotal", label: "Items subtotal", cents: 1800 }], totalCents: 1800 };

describe("customer display on a separate device", () => {
  let secret = "";
  let code = "";

  it("a new display gets a secret and a short code, and waits unlinked", async () => {
    const p = (await call("/api/display/pair", { method: "POST", body: {} })).json;
    secret = p.secret; code = p.code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(secret.length).toBeGreaterThan(20);
    expect(await screen(secret)).toMatchObject({ status: 200, json: { linked: false, code } });
    expect((await screen("not-a-secret")).status).toBe(404);
    expect((await call("/api/display/state")).status).toBe(401);
  });

  it("only an enrolled till can link a display, with the right code, once", async () => {
    const asGuest = await fetch(`${base}/api/display/link`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify({ code }) });
    expect(asGuest.status).toBe(401);
    expect((await call("/api/display/link", { body: { code: "ZZZZZ" } })).status).toBe(400);
    expect((await call("/api/display/link", { body: { code: "ZZZZZZ" } })).status).toBe(404);
    const ok = await call("/api/display/link", { body: { code: code.toLowerCase() } }); // typed in lower case is fine
    expect(ok.status).toBe(200);
    expect((await call("/api/display/link", { body: { code } })).status).toBe(404); // the code is used up
    expect((await screen(secret)).json.linked).toBe(true);
  });

  it("the till publishes what the customer sees and the display gets it, and an unchanged state is cheap", async () => {
    const before = (await screen(secret)).json;
    expect(before.state).toBeNull();
    const put = await call("/api/display/state", { method: "PUT", body: { state: SALE } });
    expect(put.status).toBe(200);
    const got = (await screen(secret)).json;
    expect(got.state).toMatchObject({ mode: "sale", orderNo: "0128", totalCents: 1800 });
    expect(got.state.lines[0]).toMatchObject({ qty: 2, name: "Original WTM", lineCents: 1800 });
    expect((await screen(secret, got.updatedAt)).json).toEqual({ linked: true, unchanged: true, updatedAt: got.updatedAt });
    await call("/api/display/state", { method: "PUT", body: { state: { ...SALE, mode: "pay", qrText: "paynow" } } });
    const next = (await screen(secret, got.updatedAt)).json;
    expect(next.state.mode).toBe("pay");
    expect(next.state.qrText).toBe("paynow");
  });

  it("junk is refused or cleaned before it reaches a customer's screen", async () => {
    expect((await call("/api/display/state", { method: "PUT", body: { state: { mode: "hack" } } })).status).toBe(400);
    expect((await call("/api/display/state", { method: "PUT", body: { state: "nope" } })).status).toBe(400);
    await call("/api/display/state", { method: "PUT", body: { state: { ...SALE, lines: [{ qty: 1, name: "X".repeat(500), details: [], lineCents: 1.5 }], imageUrl: "javascript:alert(1)", secretField: "x" } } });
    const s = (await screen(secret)).json.state;
    expect(s.lines[0].name.length).toBe(80);
    expect(s.lines[0].lineCents).toBe(0); // money is whole cents or nothing
    expect(s.imageUrl).toBeUndefined();
    expect(s.secretField).toBeUndefined();
  });

  it("a till sees its screens and can unlink one, after which the display starts over", async () => {
    const list = (await call("/api/display/screens")).json.screens as Array<{ id: string }>;
    expect(list.length).toBe(1);
    expect((await call(`/api/display/screens/${list[0]!.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await screen(secret)).status).toBe(404); // unknown now: the page asks for a new pairing
  });

  it("an unlinked pairing expires", async () => {
    const p = (await call("/api/display/pair", { method: "POST", body: {} })).json;
    await db.query("UPDATE display_screens SET created_at = now() - interval '20 minutes' WHERE secret_hash <> ''");
    expect((await call("/api/display/link", { body: { code: p.code } })).status).toBe(404);
  });
});
