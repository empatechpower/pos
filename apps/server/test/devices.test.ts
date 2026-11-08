import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { StaticCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { PgEventStore } from "../src/pgStore.js";
import { FailureLimiter } from "../src/rateLimit.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";

async function call(method: string, url: string, o: { body?: object; device?: string; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(o.body ? { "content-type": "application/json" } : {}),
      ...(o.device ? { "x-device-token": o.device } : {}),
      ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function newDevice(name = "Till") {
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  const e = (await enroll(db, "bp", c.code, name))!;
  return { token: e.token, id: e.device.id };
}

let seq = 0;
const ev = (deviceId: string, orderId = "o1") => ({ id: `ev${++seq}`, orderId, deviceId, ts: seq, seq, type: "StageSet", stage: "preparing" });

let mgr = "";
let tillA = { token: "", id: "" };

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  app = await buildApp({ config, db, catalog: new StaticCatalogStore(seedCatalog()), logger: false, store: new PgEventStore(db, "bp", "EV") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  tillA = await newDevice("Till A");
  mgr = (await call("POST", "/api/auth/login", { body: { code: "MGR", pin: "222222" }, device: tillA.token })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("sync needs an enrolled device", () => {
  it("rejects push, pull and stream tickets with no token or a made-up one", async () => {
    for (const device of [undefined, "not-a-real-token"]) {
      expect((await call("POST", "/api/sync/push", { body: { events: [] }, device })).status).toBe(401);
      expect((await call("GET", "/api/sync/pull?after=0", { device })).status).toBe(401);
      expect((await call("POST", "/api/stream/ticket", { device })).status).toBe(401);
    }
  });

  it("accepts a device's own events and refuses events claiming another device", async () => {
    const other = await newDevice("Till B");
    expect((await call("POST", "/api/sync/push", { body: { events: [ev(tillA.id)] }, device: tillA.token })).status).toBe(200);
    const forged = await call("POST", "/api/sync/push", { body: { events: [ev(other.id)] }, device: tillA.token });
    expect(forged.status).toBe(403);
    expect(forged.json.error).toBe("device_mismatch");
  });

  it("a forged event in a batch stops the whole batch (nothing half-stored)", async () => {
    const other = await newDevice("Till C");
    const good = ev(tillA.id, "batch");
    await call("POST", "/api/sync/push", { body: { events: [good, ev(other.id, "batch")] }, device: tillA.token });
    const pulled = (await call("GET", "/api/sync/pull?after=0", { device: tillA.token })).json.events as Array<{ event: { id: string } }>;
    expect(pulled.some((p) => p.event.id === good.id)).toBe(false);
  });

  it("the live stream needs a one-time ticket", async () => {
    expect((await call("GET", "/api/stream")).status).toBe(401);
    const { ticket } = (await call("POST", "/api/stream/ticket", { device: tillA.token })).json;
    const ctl = new AbortController();
    const ok = await fetch(`${base}/api/stream?ticket=${ticket}`, { signal: ctl.signal });
    expect(ok.status).toBe(200);
    ctl.abort();
    expect((await call("GET", `/api/stream?ticket=${ticket}`)).status).toBe(401); // already used
  });
});

describe("enrollment", () => {
  it("a code works once", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const first = await call("POST", "/api/devices/enroll", { body: { code: c.code, name: "Kitchen" } });
    expect(first.status).toBe(200);
    expect(first.json.token).toBeTruthy();
    expect((await call("POST", "/api/devices/enroll", { body: { code: c.code, name: "Thief" } })).status).toBe(401);
  });

  it("two devices racing for one code: exactly one wins", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const r = await Promise.all([1, 2, 3, 4].map((n) => call("POST", "/api/devices/enroll", { body: { code: c.code, name: `race${n}` } })));
    expect(r.filter((x) => x.status === 200)).toHaveLength(1);
  });

  it("an expired code is refused", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    await db.query("UPDATE enrollment_codes SET expires_at = now() - interval '1 second'");
    expect((await call("POST", "/api/devices/enroll", { body: { code: c.code, name: "Late" } })).status).toBe(401);
  });

  it("codes are case-insensitive for typing, but a wrong code is refused", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    expect((await call("POST", "/api/devices/enroll", { body: { code: "WRONG123", name: "X" } })).status).toBe(401);
    expect((await call("POST", "/api/devices/enroll", { body: { code: c.code.toLowerCase(), name: "Typed" } })).status).toBe(200);
  });

  it("stores only hashes: neither the device token nor the code appears in the database", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const e = (await enroll(db, "bp", c.code, "Hash check"))!;
    const dump = JSON.stringify([...(await db.query("SELECT * FROM devices")).rows, ...(await db.query("SELECT * FROM enrollment_codes")).rows]);
    expect(dump).not.toContain(e.token);
    expect(dump).not.toContain(c.code);
  });
});

describe("signing in and money need an enrolled device too", () => {
  it("staff cannot sign in from a device that isn't enrolled", async () => {
    expect((await call("POST", "/api/auth/login", { body: { code: "C1", pin: "3333" } })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { code: "C1", pin: "3333" }, device: "bogus" })).status).toBe(401);
  });

  it("a valid staff session is useless without a device token", async () => {
    expect((await call("GET", "/api/wallet/x", { staff: mgr })).status).toBe(401);
    expect((await call("GET", "/api/wallet/x", { staff: mgr, device: tillA.token })).status).toBe(200);
  });

  it("the ledger records the enrolled device, not whatever the request claims", async () => {
    await call("POST", "/api/wallet/topup", {
      body: { customerId: "dv1", amountCents: 500, idempotencyKey: "dvk1", deviceId: "i-am-someone-else" },
      staff: mgr,
      device: tillA.token,
    });
    const r = await db.query("SELECT e.device_id FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.customer_id='dv1'");
    expect(r.rows[0].device_id).toBe(tillA.id);
  });
});

describe("managing devices", () => {
  it("a cashier cannot create codes or revoke; a manager can", async () => {
    const cashier = (await call("POST", "/api/auth/login", { body: { code: "C1", pin: "3333" }, device: tillA.token })).json.token;
    expect((await call("POST", "/api/devices/enrollment", { body: {}, staff: cashier, device: tillA.token })).status).toBe(403);
    const made = await call("POST", "/api/devices/enrollment", { body: {}, staff: mgr, device: tillA.token });
    expect(made.status).toBe(200);
    expect(made.json.code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("revoking a device ends its access at once, for sync, tickets and sign-in", async () => {
    const lost = await newDevice("Lost tablet");
    expect((await call("GET", "/api/sync/pull?after=0", { device: lost.token })).status).toBe(200);
    expect((await call("POST", `/api/devices/${lost.id}/revoke`, { staff: mgr, device: tillA.token })).status).toBe(200);
    expect((await call("GET", "/api/sync/pull?after=0", { device: lost.token })).status).toBe(401);
    expect((await call("POST", "/api/stream/ticket", { device: lost.token })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { code: "C1", pin: "3333" }, device: lost.token })).status).toBe(401);
  });

  it("a manager cannot revoke the device they are using", async () => {
    expect((await call("POST", `/api/devices/${tillA.id}/revoke`, { staff: mgr, device: tillA.token })).status).toBe(400);
  });

  it("re-issuing keeps the same device id, so its queued offline events still match, and kills the old token", async () => {
    const d = await newDevice("Re-issue me");
    await call("POST", `/api/devices/${d.id}/revoke`, { staff: mgr, device: tillA.token });
    const code = (await call("POST", "/api/devices/enrollment", { body: { deviceId: d.id }, staff: mgr, device: tillA.token })).json.code;
    const back = await call("POST", "/api/devices/enroll", { body: { code, name: "Re-issued" } });
    expect(back.json.deviceId).toBe(d.id);
    expect((await call("GET", "/api/sync/pull?after=0", { device: d.token })).status).toBe(401); // old token dead
    expect((await call("POST", "/api/sync/push", { body: { events: [ev(d.id, "late")] }, device: back.json.token })).status).toBe(200);
  });

  it("lists devices and audits enrollment, codes and revocation", async () => {
    const list = (await call("GET", "/api/devices", { staff: mgr, device: tillA.token })).json.devices as Array<{ name: string }>;
    expect(list.some((d) => d.name === "Till A")).toBe(true);
    const actions = (await call("GET", "/api/audit", { staff: mgr, device: tillA.token })).json.entries.map((e: { action: string }) => e.action);
    for (const a of ["device.enroll", "device.code", "device.revoke"]) expect(actions).toContain(a);
  });
});

describe("FailureLimiter", () => {
  it("blocks after the limit and forgets after the window", () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.fail("ip", 0);
    expect(l.blocked("ip", 500)).toBe(true);
    expect(l.blocked("ip", 1500)).toBe(false);
    expect(l.blocked("other", 500)).toBe(false);
  });
});

describe("local development mode", () => {
  it("without a database, sync stays open and says so", async () => {
    const dev = await buildApp({ config, db: null, catalog: new StaticCatalogStore(seedCatalog()), logger: false, store: new PgEventStore(db, "bp", "dev") });
    await dev.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(dev.server.address() as { port: number }).port}`;
    expect((await (await fetch(`${url}/api/auth/mode`)).json()).deviceRequired).toBe(false);
    expect((await fetch(`${url}/api/sync/pull?after=0`)).status).toBe(200);
    await dev.close();
  });
});

// Last on purpose: it trips the per-address limit, which would block any enrollment after it.
describe("enrollment rate limit", () => {
  it("limits repeated wrong codes from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call("POST", "/api/devices/enroll", { body: { code: `BADCODE${i}`, name: "x" } })).status);
    expect(statuses).toContain(429);
  });
});
