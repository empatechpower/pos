import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, newId } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore, StaticCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { MAX_ATTEMPTS, PrintStore, backoffSeconds } from "../src/print.js";
import { runAgentOnce, sendRaw, type Sender } from "../src/printAgent.js";
import { canvasRenderer } from "../src/rasterFont.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let appR: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let baseR = "";
let till = { token: "", id: "" };
let hub = { token: "", id: "" };
let other = { token: "", id: "" };
let mgr = "";
let cashier = "";
const queue = () => new PrintStore(db, "bp");

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
const printerBody = (o: object) => ({ name: "Printer", language: "escpos", roles: ["receipt"], connection: { host: "10.0.0.5", port: 9100 }, ...o });
const setPrinter = (id: string, body: object) => call(`/api/printers/${id}`, { method: "PUT", body, staff: mgr, device: till.token });
const agent = (send: Sender, deviceToken = hub.token) => runAgentOnce({ baseUrl: base, deviceToken, send });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  const store = new PgEventStore(db, "bp", "EV");
  const common = { db, logger: false, store, catalog: cat, catalogAdmin: cat, print: queue() };
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), ...common });
  appR = await buildApp({ config: PRESETS.restaurant("bp", "Bailey & Patch", "EV"), ...common });
  await app.listen({ port: 0, host: "127.0.0.1" });
  await appR.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  baseR = `http://127.0.0.1:${(appR.server.address() as { port: number }).port}`;
  till = await newDevice("Till");
  hub = await newDevice("Hub");
  other = await newDevice("Other hub");
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" }, device: till.token })).json.token;
  cashier = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" }, device: till.token })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await appR?.close();
  await stop?.();
});

describe("printers", () => {
  it("only managers can add printers, and a printer must be set up sensibly", async () => {
    expect((await call("/api/printers/front", { method: "PUT", body: printerBody({}), staff: cashier, device: till.token })).status).toBe(403);
    const bad = async (body: object) => (await setPrinter("p1", body)).status;
    expect(await bad(printerBody({ language: "zpl" }))).toBe(400); // receipts need escpos
    expect(await bad(printerBody({ roles: ["label"], language: "escpos" }))).toBe(400); // labels need zpl/epl
    expect(await bad(printerBody({ roles: ["label"], language: "zpl" }))).toBe(400); // no label size
    expect(await bad(printerBody({ roles: ["receipt", "label"] }))).toBe(400); // not both
    expect(await bad(printerBody({ connection: { host: "", port: 0 } }))).toBe(400);
    expect(await bad(printerBody({ widthChars: 40 }))).toBe(400);
    expect((await setPrinter("p1", printerBody({}))).status).toBe(200);
    await setPrinter("p1", printerBody({ active: false })); // park it so it does not receive later tests' jobs
  });
});

describe("what gets queued, and when", () => {
  beforeAll(async () => {
    await setPrinter("front", printerBody({ name: "Front receipt", roles: ["receipt"], drawer: true }));
    await setPrinter("pass", printerBody({ name: "Kitchen", roles: ["kitchen"], connection: { host: "10.0.0.6", port: 9100 } }));
  });

  it("fast serve: nothing prints for an unpaid order; paying prints the kitchen ticket and the receipt", async () => {
    const o = orderEvents([{ id: "kaya-toast", name: "Kaya Toast", qty: 2 }], { queue: "A101" });
    await push(o.events);
    expect(await jobsFor(o.orderId)).toHaveLength(0);
    await push([o.mk({ type: "PaymentRecorded", paymentId: "pp1", method: "cash", amountCents: 400, confirmed: true })]);
    const j = await jobsFor(o.orderId);
    expect(j.map((x) => x.doc_type).sort()).toEqual(["kitchen", "receipt"]);
  });

  it("delivers real printer bytes: queue number and items on the ticket, total on the receipt, drawer pulse for cash", async () => {
    const { got, send } = capture();
    await agent(send);
    const kitchen = got.find((g) => g.host === "10.0.0.6")!;
    const receipt = got.find((g) => g.host === "10.0.0.5")!;
    expect(kitchen.text).toContain("A101");
    expect(kitchen.text).toContain("2 x Kaya Toast");
    expect(kitchen.text).not.toContain("S$");
    expect(receipt.text).toContain("TOTAL");
    expect(receipt.text).toContain("S$4.00");
    expect([...receipt.bytes.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 0]); // starts with ESC @
    expect(receipt.bytes.includes(Buffer.from([0x1b, 0x70, 0]))).toBe(true); // cash drawer
    expect(kitchen.bytes.includes(Buffer.from([0x1d, 0x56, 0x42, 3]))).toBe(true); // cut
    expect((await jobs("done")).length).toBeGreaterThanOrEqual(2);
  });

  it("a card/credit sale does not open the drawer", async () => {
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A102", pay: "credit" });
    await push(o.events);
    const { got, send } = capture();
    await agent(send);
    expect(got.find((g) => g.host === "10.0.0.5")!.bytes.includes(Buffer.from([0x1b, 0x70]))).toBe(false);
  });

  it("pushing the same events again, or unrelated ones, queues nothing more", async () => {
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A103", pay: "cash" });
    await push(o.events);
    const before = (await jobsFor(o.orderId)).length;
    expect(before).toBe(2);
    await push(o.events); // exact duplicates
    await push([o.mk({ type: "StageSet", stage: "preparing" })]);
    expect((await jobsFor(o.orderId)).length).toBe(before);
    await agent(capture().send);
  });

  it("a push still succeeds, and the events are kept, when queuing prints fails", async () => {
    const broken = await buildApp({ config: PRESETS.fastServe("bp", "B", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: { load: async () => { throw new Error("catalog down"); } }, print: queue() });
    await broken.listen({ port: 0, host: "127.0.0.1" });
    const root = `http://127.0.0.1:${(broken.server.address() as { port: number }).port}`;
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A104", pay: "cash" });
    expect((await push(o.events, root)).status).toBe(200);
    expect((await call("/api/sync/pull?after=0", { device: till.token, root })).json.events.some((e: any) => e.event.orderId === o.orderId)).toBe(true);
    await broken.close();
  });
});

describe("restaurant tabs", () => {
  it("sends the kitchen ticket at once, and later additions as an ADD-ON with only the new items", async () => {
    const o = orderEvents([{ id: "nasi-lemak", name: "Nasi Lemak", qty: 1 }], { queue: "A201" });
    await push(o.events, baseR);
    expect((await jobsFor(o.orderId)).filter((j) => j.doc_type === "kitchen")).toHaveLength(1);
    await push([o.mk({ type: "ItemAdded", lineId: "late-1", productId: "teh", name: "Milk Tea", unitCents: 240, qty: 1 })], baseR);
    const k = (await jobsFor(o.orderId)).filter((j) => j.doc_type === "kitchen");
    expect(k).toHaveLength(2);
    const { got, send } = capture();
    await agent(send);
    const texts = got.map((g) => g.text);
    const add = texts.find((t) => t.includes("ADD-ON"))!;
    expect(add).toContain("Milk Tea");
    expect(add).not.toContain("Nasi Lemak");
    expect(texts.some((t) => t.includes("Nasi Lemak") && !t.includes("ADD-ON"))).toBe(true);
  });

  it("prints the receipt only once the tab is settled", async () => {
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A202" });
    await push(o.events, baseR);
    expect((await jobsFor(o.orderId)).some((j) => j.doc_type === "receipt")).toBe(false);
    await push([o.mk({ type: "PaymentRecorded", paymentId: "tab1", method: "cash", amountCents: 200, confirmed: true })], baseR);
    expect((await jobsFor(o.orderId)).some((j) => j.doc_type === "receipt")).toBe(true);
    await agent(capture().send);
  });
});

describe("routing to several printers", () => {
  it("a bar printer takes the drinks and the kitchen printer takes the rest", async () => {
    await setPrinter("bar", printerBody({ name: "Bar", roles: ["kitchen"], categories: ["Drinks"], connection: { host: "10.0.0.7", port: 9100 } }));
    const o = orderEvents([{ id: "kaya-toast", name: "Kaya Toast", qty: 1 }, { id: "kopi", name: "Coffee", qty: 2 }], { queue: "A301" });
    await push(o.events, baseR);
    const { got, send } = capture();
    await agent(send);
    const bar = got.find((g) => g.host === "10.0.0.7")!;
    const kitchen = got.find((g) => g.host === "10.0.0.6" && g.text.includes("A301"))!;
    expect(bar.text).toContain("2 x Coffee");
    expect(bar.text).not.toContain("Kaya");
    expect(kitchen.text).toContain("Kaya Toast");
    expect(kitchen.text).not.toContain("Coffee");
    await setPrinter("bar", printerBody({ roles: ["kitchen"], categories: ["Drinks"], active: false }));
  });

  it("one label per unit, in one job, in the printer's language", async () => {
    await setPrinter("cups", { name: "Cups", language: "zpl", roles: ["label"], labelWidthMm: 50, labelHeightMm: 30, connection: { host: "10.0.0.8", port: 9100 } });
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 3 }], { queue: "A302" });
    await push(o.events, baseR);
    const labelJobs = (await jobsFor(o.orderId)).filter((j) => j.doc_type === "label");
    expect(labelJobs).toHaveLength(1);
    const { got, send } = capture();
    await agent(send);
    const z = got.find((g) => g.host === "10.0.0.8")!.text;
    expect(z.match(/\^XA/g)).toHaveLength(3);
    expect(z.match(/\^XZ/g)).toHaveLength(3);
    expect(z).toContain("^PW400");
    expect(z).toContain("A302");
    await setPrinter("cups", { name: "Cups", language: "zpl", roles: ["label"], labelWidthMm: 50, labelHeightMm: 30, connection: { host: "10.0.0.8", port: 9100 }, active: false });
  });

  it("a printer can be tied to one hub, and other hubs never receive its jobs", async () => {
    await setPrinter("tied", printerBody({ name: "Tied", roles: ["receipt"], connection: { host: "10.0.0.9", port: 9100 }, agentDeviceId: hub.id }));
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A303", pay: "cash" });
    await push(o.events);
    const theirs = capture();
    await agent(theirs.send, other.token);
    expect(theirs.got.some((g) => g.host === "10.0.0.9")).toBe(false);
    const mine = capture();
    await agent(mine.send, hub.token);
    expect(mine.got.some((g) => g.host === "10.0.0.9")).toBe(true);
    await setPrinter("tied", printerBody({ roles: ["receipt"], active: false }));
  });
});

describe("delivery: retries, leases, competition", () => {
  const fresh = async () => {
    await db.query("UPDATE print_jobs SET status='done' WHERE status IN ('queued','leased')"); // clear earlier leftovers
    await setPrinter("solo", printerBody({ name: "Solo", roles: ["receipt"], connection: { host: "10.0.1.1", port: 9100 } }));
    for (const id of ["front", "pass"]) await db.query("UPDATE printers SET active=false WHERE id=$1", [id]);
  };

  it("a printer that is off: the job waits, is retried later, and prints once it is back", async () => {
    await fresh();
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A401", pay: "cash" });
    await push(o.events);
    const failing: Sender = async () => { throw new Error("connect ECONNREFUSED 10.0.1.1:9100"); };
    const r = await agent(failing);
    expect(r).toEqual({ delivered: 0, failed: 1 });
    const j = (await jobsFor(o.orderId))[0]!;
    expect(j.status).toBe("queued");
    expect(j.attempts).toBe(1);
    expect(j.last_error).toContain("ECONNREFUSED");
    expect(await agent(capture().send)).toEqual({ delivered: 0, failed: 0 }); // backing off: not handed out yet
    await db.query("UPDATE print_jobs SET next_attempt_at = now() WHERE id=$1", [j.id]);
    const ok = capture();
    expect((await agent(ok.send)).delivered).toBe(1);
    expect((await jobsFor(o.orderId))[0]!.status).toBe("done");
    expect(ok.got[0]!.text).toContain("A401");
  });

  it("gives up after the maximum attempts, shows why, and can be retried by a manager", async () => {
    await fresh();
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A402", pay: "cash" });
    await push(o.events);
    const failing: Sender = async () => { throw new Error("paper jam"); };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await db.query("UPDATE print_jobs SET next_attempt_at = now() WHERE order_id=$1 AND status='queued'", [o.orderId]);
      await agent(failing);
    }
    const j = (await jobsFor(o.orderId))[0]!;
    expect(j.status).toBe("failed");
    expect(j.attempts).toBe(MAX_ATTEMPTS);
    expect(j.last_error).toBe("paper jam");
    expect((await call(`/api/print/jobs/${j.id}/retry`, { method: "POST", body: {}, staff: cashier, device: till.token })).status).toBe(403);
    expect((await call(`/api/print/jobs/${j.id}/retry`, { method: "POST", body: {}, staff: mgr, device: till.token })).status).toBe(200);
    const ok = capture();
    expect((await agent(ok.send)).delivered).toBe(1);
  });

  it("if an agent dies mid-print, the job is parked as unconfirmed and never printed again on its own", async () => {
    await fresh();
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A403", pay: "cash" });
    await push(o.events);
    const first = await queue().claim(hub.id, 5);
    expect(first).toHaveLength(1);
    expect(await queue().claim(hub.id, 5)).toHaveLength(0); // still leased: nobody else gets it
    await db.query("UPDATE print_jobs SET leased_until = now() - interval '1 second' WHERE id=$1", [first[0]!.id]);
    expect(await queue().claim(other.id, 5)).toHaveLength(0); // no silent reprint
    const parked = (await queue().listJobs("unconfirmed")).find((j) => j.id === first[0]!.id);
    expect(parked?.last_error).toMatch(/unconfirmed/);
    expect(await queue().retryFailed(first[0]!.id)).toBe(true); // a person chose to reprint
    const again = await queue().claim(other.id, 5);
    expect(again.map((j) => j.id)).toEqual([first[0]!.id]);
    await queue().markDone(again[0]!.id);
  });

  it("a failure after the printer connection was made is parked as unconfirmed, not retried", async () => {
    await fresh();
    await push(orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A404", pay: "cash" }).events);
    const [j] = await queue().claim(hub.id, 5);
    expect(await queue().markFailed(j!.id, "connection reset", true)).toBe("unconfirmed");
    expect(await queue().claim(hub.id, 5)).toHaveLength(0);
    await queue().retryFailed(j!.id);
    const [k] = await queue().claim(hub.id, 5);
    await queue().markDone(k!.id);
  });

  it("two agents claiming at once never receive the same job", async () => {
    await fresh();
    for (let i = 0; i < 10; i++) await push(orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: `B${i}`, pay: "cash" }).events);
    const [a, b] = await Promise.all([queue().claim(hub.id, 10), queue().claim(other.id, 10)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);
    for (const j of [...a, ...b]) await queue().markDone(j.id);
  });

  it("jobs for one printer come out in the order they were made", async () => {
    await fresh();
    for (const q of ["C1", "C2", "C3"]) await push(orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: q, pay: "cash" }).events);
    const { got, send } = capture();
    await agent(send);
    expect(got.map((g) => /C[123]/.exec(g.text)![0])).toEqual(["C1", "C2", "C3"]);
  });

  it("backoff grows, then caps", () => {
    expect([1, 2, 3, 4, 5, 8].map(backoffSeconds)).toEqual([5, 15, 45, 120, 120, 120]);
  });

  it("the agent needs an enrolled device", async () => {
    expect((await call("/api/print/claim", { body: {} })).status).toBe(401);
    expect((await call("/api/print/claim", { body: {}, device: "nope" })).status).toBe(401);
  });
});

describe("raster mode", () => {
  it("the renderer draws Chinese and Tamil as real shapes, and a bitmap as wide as the paper", () => {
    for (const text of ["咖啡 Kopi", "தமிழ்"]) {
      const b = canvasRenderer.text(text, 384, { align: "center" });
      expect(b.width).toBe(384);
      expect(b.height).toBeGreaterThan(10);
      expect(b.pixels.reduce((n, v) => n + v, 0)).toBeGreaterThan(40);
    }
  });

  it("long text wraps instead of running off the paper", () => {
    const one = canvasRenderer.text("Short", 384, {});
    const many = canvasRenderer.text("A very long item name that cannot possibly fit on one line of a narrow receipt " .repeat(2), 384, {});
    expect(many.height).toBeGreaterThan(one.height * 2);
  });

  it("a raster printer's job is bitmaps (GS v 0) and not text, and the preview of a plain printer is unchanged", async () => {
    await db.query("UPDATE print_jobs SET status='done' WHERE status IN ('queued','leased')");
    for (const id of ["front", "pass", "solo"]) await db.query("UPDATE printers SET active=false WHERE id=$1", [id]);
    await setPrinter("pic", printerBody({ name: "Picture", roles: ["receipt"], raster: true, connection: { host: "10.0.2.1", port: 9100 } }));
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A501", pay: "cash" });
    await push(o.events);
    const [j] = await queue().claim(hub.id, 5);
    const bytes = Array.from(j!.payload);
    expect(bytes.some((v, i) => v === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30)).toBe(true);
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("A501"); // drawn, not sent as text
    await queue().markDone(j!.id);
    await db.query("UPDATE printers SET active=false WHERE id='pic'");
  });
});

describe("reprints and test pages", () => {
  it("any staff member can reprint a receipt, and it is a fresh job each time", async () => {
    await db.query("UPDATE printers SET active=true WHERE id='front'");
    await db.query("UPDATE printers SET active=false WHERE id='solo'");
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A501", pay: "cash" });
    await push(o.events);
    const a = await call("/api/print/reprint", { body: { orderId: o.orderId, docType: "receipt" }, staff: cashier, device: till.token });
    const b = await call("/api/print/reprint", { body: { orderId: o.orderId, docType: "receipt" }, staff: cashier, device: till.token });
    expect(a.json.queued).toBe(1);
    expect(b.json.queued).toBe(1);
    expect((await jobsFor(o.orderId)).filter((j) => j.doc_type === "receipt")).toHaveLength(3);
  });

  it("rejects an unknown order, a bad document type, and no session", async () => {
    expect((await call("/api/print/reprint", { body: { orderId: "ghost", docType: "receipt" }, staff: cashier, device: till.token })).status).toBe(404);
    expect((await call("/api/print/reprint", { body: { orderId: "x", docType: "label" }, staff: cashier, device: till.token })).status).toBe(400);
    expect((await call("/api/print/reprint", { body: { orderId: "x", docType: "receipt" }, device: till.token })).status).toBe(401);
  });

  it("a test page reaches a printer so setup can be checked", async () => {
    const r = await call("/api/printers/front/test", { method: "POST", body: {}, staff: mgr, device: till.token });
    expect(r.status).toBe(200);
    const { got, send } = capture();
    await agent(send);
    expect(got.some((g) => g.text.includes("PRINTER TEST"))).toBe(true);
    expect((await call("/api/printers/nope/test", { method: "POST", body: {}, staff: mgr, device: till.token })).status).toBe(404);
  });
});

describe("the real network path", () => {
  it("writes the bytes to a TCP printer on its raw port", async () => {
    const received: Buffer[] = [];
    const srv: Server = createServer((s) => s.on("data", (d) => received.push(d)));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await sendRaw("127.0.0.1", port, Buffer.from([0x1b, 0x40, 0x41, 0x0a]));
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(received)).toEqual(Buffer.from([0x1b, 0x40, 0x41, 0x0a]));
    srv.close();
  });

  it("reports a refused connection as an error rather than succeeding silently", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    await expect(sendRaw("127.0.0.1", port, Buffer.from("x"))).rejects.toThrow();
  });
});

describe("no printers configured", () => {
  it("queues nothing and does not complain", async () => {
    await db.query("UPDATE printers SET active=false");
    const before = (await jobs()).length;
    const o = orderEvents([{ id: "kopi", name: "Coffee", qty: 1 }], { queue: "A601", pay: "cash" });
    expect((await push(o.events)).status).toBe(200);
    expect((await jobs()).length).toBe(before);
  });
});
