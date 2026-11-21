import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, newId } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore, StaticCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { MAX_ATTEMPTS, PrintStore } from "../src/print.js";
import { runAgentOnce, sendRaw, type Sender } from "../src/printAgent.js";
import { canvasRenderer } from "../src/rasterFont.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let till = { token: "", id: "" };
let hub = { token: "", id: "" };
let mgr = "";
let cashier = "";
const alerts: string[] = [];
const queue = () => { const q = new PrintStore(db, "bp"); q.onAlert = (t) => void alerts.push(t); return q; };

async function call(url: string, o: { method?: string; body?: object; device?: string; staff?: string; root?: string } = {}) {
  const res = await fetch((o.root ?? base) + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { ...(o.body ? { "content-type": "application/json" } : {}), ...(o.device ? { "x-device-token": o.device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const newDevice = async (name: string) => {
  const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
  const e = (await enroll(db, "bp", c.code, name))!;
  return { token: e.token, id: e.device.id };
};

let n = 0;
/** Events for one order, as the till would push them. */
function orderEvents(items: Array<{ id: string; name: string; qty: number }>, o: { queue?: string; pay?: "cash" | "credit"; orderId?: string; channel?: boolean } = {}) {
  const orderId = o.orderId ?? newId();
  const mk = (extra: object) => ({ id: `pe${++n}`, orderId, deviceId: till.id, ts: n, seq: n, ...extra });
  const ev: any[] = [mk({ type: "OrderOpened", fulfilment: "takeaway", channelId: "take-away", channelName: "Take away", serviceCharge: false, queueNumber: o.queue ?? "A007" })];
  for (const it of items) ev.push(mk({ type: "ItemAdded", lineId: `l-${it.id}-${n}`, productId: it.id, name: it.name, unitCents: 200, qty: it.qty }));
  if (o.pay) ev.push(mk({ type: "PaymentRecorded", paymentId: `pay-${n}`, method: o.pay, amountCents: items.reduce((s, i) => s + 200 * i.qty, 0), confirmed: true }));
  return { orderId, events: ev, mk };
}
const push = (events: any[], root = base) => call("/api/sync/push", { body: { events }, device: till.token, root });
const jobs = async (status?: string) => (await call(`/api/print/jobs${status ? `?status=${status}` : ""}`, { staff: mgr, device: till.token })).json.jobs as Array<{ id: string; printer_id: string; doc_type: string; order_id: string; status: string; attempts: number; last_error: string | null }>;
const jobsFor = async (orderId: string) => (await jobs()).filter((j) => j.order_id === orderId);

/** A sender that records what each printer received instead of using a network. */
function capture() {
  const got: Array<{ host: string; port: number; text: string; bytes: Buffer }> = [];
  const send: Sender = async (host, port, bytes) => void got.push({ host, port, bytes, text: bytes.toString("latin1") });
  return { got, send };
}
// (The queue number is off unless a printer asks for it, so most of these tests ask for it, to look at it.
const printerBody = (o: object) => ({ name: "Printer", language: "escpos", roles: ["receipt"], showQueue: true, connection: { host: "10.0.0.5", port: 9100 }, ...o });
const setPrinter = (id: string, body: object) => call(`/api/printers/${id}`, { method: "PUT", body, staff: mgr, device: till.token });
const agent = (send: Sender, deviceToken = hub.token) => runAgentOnce({ baseUrl: base, deviceToken, send });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  const store = new PgEventStore(db, "bp", "EV");
  const common = { db, logger: false, store, catalog: cat, catalogAdmin: cat, print: queue() };
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), ...common });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  till = await newDevice("Till");
  hub = await newDevice("Hub");
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" }, device: till.token })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" }, device: till.token })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});


const K1 = { host: "10.0.0.1", port: 9100 };
const kitchen = (o: object) => printerBody({ roles: ["kitchen"], ...o });
/** Fails every send to the first kitchen printer, delivers everything else. */
const brokenK1 = (got: string[]): Sender => async (host, _port, bytes) => { if (host === K1.host) throw new Error("connect ECONNREFUSED"); got.push(`${host}:${bytes.length}`); };
const due = () => db.query("UPDATE print_jobs SET next_attempt_at = now() WHERE status='queued'");
const jobsOf = async (orderId: string) => (await db.query("SELECT printer_id, status, attempts, rerouted_to, last_error FROM print_jobs WHERE merchant_id='bp' AND order_id=$1 AND doc_type='kitchen' ORDER BY created_at", [orderId])).rows;
const place = async (queueNo: string) => { const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: queueNo, pay: "cash" }); await push(o.events); return o.orderId; };

describe("kitchen printer backup (developer package C-4)", () => {
  beforeAll(async () => {
    await db.query("UPDATE printers SET active=false");
    // The backup only takes what is rerouted to it: it is limited to a category nothing normally uses.
    await setPrinter("k2", kitchen({ name: "Bar printer", connection: { host: "10.0.0.2", port: 9100 }, categories: ["Backup only"] }));
  });

  it("a backup must be a real, different kitchen printer at the same outlet with the same paper width and mode", async () => {
    expect((await setPrinter("k1", kitchen({ name: "Kitchen printer", connection: K1, backupPrinterId: "k1" }))).status).toBe(400);
    expect((await setPrinter("k1", kitchen({ name: "Kitchen printer", connection: K1, backupPrinterId: "nope" }))).status).toBe(400);
    await setPrinter("k3", kitchen({ name: "Narrow", connection: { host: "10.0.0.3", port: 9100 }, widthChars: 32 }));
    expect((await setPrinter("k1", kitchen({ name: "Kitchen printer", connection: K1, backupPrinterId: "k3" }))).status).toBe(400);
    await setPrinter("rc", printerBody({ name: "Receipt", roles: ["receipt"], connection: { host: "10.0.0.4", port: 9100 } }));
    expect((await setPrinter("k1", kitchen({ name: "Kitchen printer", connection: K1, backupPrinterId: "rc" }))).status).toBe(400);
    expect((await setPrinter("k1", kitchen({ name: "Kitchen printer", connection: K1, backupPrinterId: "k2" }))).status).toBe(200);
    await db.query("UPDATE printers SET active=false WHERE id IN ('k3','rc')");
  });

  it("after a few quick tries the ticket moves to the backup, prints there once, and staff are told where it went", async () => {
    const orderId = await place("B101");
    const got: string[] = [];
    for (let i = 0; i < 3; i++) { await due(); await agent(brokenK1(got)); }
    let j = await jobsOf(orderId);
    expect(j.find((x) => x.printer_id === "k1")).toMatchObject({ status: "rerouted", rerouted_to: "k2" });
    expect(j.find((x) => x.printer_id === "k2")!.status).toBe("queued");
    expect(alerts.some((a) => a.includes("Bar printer") && a.includes("Kitchen printer"))).toBe(true);
    await due(); await agent(brokenK1(got));
    j = await jobsOf(orderId);
    expect(j.find((x) => x.printer_id === "k2")!.status).toBe("done");
    expect(got.filter((g) => g.startsWith("10.0.0.2")).length).toBe(1); // printed once, on the backup
    await due(); await agent(brokenK1(got));
    expect(got.filter((g) => g.startsWith("10.0.0.2")).length).toBe(1); // and never again
    const status = (await call(`/api/print/order-status?ids=${orderId}`, { staff: mgr, device: till.token })).json;
    expect(JSON.stringify(status)).toContain("printed");
  });

  it("when the same printer keeps failing, staff are asked to make the backup its permanent route, once", async () => {
    const got: string[] = [];
    for (const q of ["B102", "B103"]) {
      const id = await place(q);
      for (let i = 0; i < 4; i++) { await due(); await agent(brokenK1(got)); }
      expect((await jobsOf(id)).find((x) => x.printer_id === "k1")!.status).toBe("rerouted");
    }
    const open = (await call("/api/print/alerts", { staff: mgr, device: till.token })).json.alerts as Array<{ kind: string; detail: string }>;
    expect(open.filter((a) => a.kind === "rerouted").length).toBe(3);
    expect(open.filter((a) => a.kind === "repeated_reroute").length).toBe(1);
    expect(open.find((a) => a.kind === "repeated_reroute")!.detail).toContain("permanent");
  });

  it("with no backup, a ticket that runs out of tries raises an alert, but not over and over", async () => {
    await db.query("UPDATE printers SET active=false WHERE id IN ('k1','k2')");
    await setPrinter("k4", kitchen({ name: "Lonely", connection: { host: "10.0.0.9", port: 9100 } }));
    const failing: Sender = async () => { throw new Error("paper jam"); };
    for (const q of ["B104", "B105"]) {
      await place(q);
      for (let i = 0; i < MAX_ATTEMPTS; i++) { await due(); await agent(failing); }
    }
    const open = (await call("/api/print/alerts", { staff: mgr, device: till.token })).json.alerts as Array<{ kind: string; printerId: string }>;
    expect(open.filter((a) => a.kind === "no_backup" && a.printerId === "k4").length).toBe(1);
    expect(alerts.some((a) => a.includes("no backup printer"))).toBe(true);
  });

  it("an alert can be marked as dealt with, and only managers can see them", async () => {
    expect((await call("/api/print/alerts", { staff: cashier, device: till.token })).status).toBe(403);
    const list = (await call("/api/print/alerts", { staff: mgr, device: till.token })).json.alerts as Array<{ id: string }>;
    expect((await call(`/api/print/alerts/${list[0]!.id}/resolve`, { method: "POST", body: {}, staff: mgr, device: till.token })).status).toBe(200);
    expect(((await call("/api/print/alerts", { staff: mgr, device: till.token })).json.alerts as unknown[]).length).toBe(list.length - 1);
  });
});
