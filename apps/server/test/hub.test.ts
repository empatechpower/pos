import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { PrintStore } from "../src/print.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

/** The hub is one standalone file the shop tablet downloads; it is tested exactly as shipped. */
const hubFile = fileURLToPath(new URL("../../web/public/hub.mjs", import.meta.url));
const hubMod: any = await import(/* @vite-ignore */ hubFile);

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let till = { token: "", id: "" };
let hub = { token: "", id: "" };
let mgr = "";
const listeners: Server[] = [];

async function call(url: string, o: { method?: string; body?: object; device?: string; staff?: string } = {}) {
  const res = await fetch(base + url, {
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
/** A pretend printer: a TCP port that remembers what it was sent. */
async function fakePrinter() {
  const got: Buffer[] = [];
  const srv = createServer((s) => s.on("data", (d) => got.push(d)));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  listeners.push(srv);
  return { port: (srv.address() as { port: number }).port, text: () => Buffer.concat(got).toString("latin1"), srv };
}
const addPrinter = (id: string, port: number) => call(`/api/printers/${id}`, { method: "PUT", body: { name: id, language: "escpos", roles: ["receipt"], connection: { host: "127.0.0.1", port } }, staff: mgr, device: till.token });
const testPrint = (id: string) => call(`/api/printers/${id}/test`, { method: "POST", body: {}, staff: mgr, device: till.token });
const run = () => hubMod.runOnce({ baseUrl: base, token: hub.token });

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, print: new PrintStore(db, "bp") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  till = await newDevice("Till");
  hub = await newDevice("Tablet hub");
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  mgr = (await call("/api/auth/login", { body: { code: "MGR", pin: "222222" }, device: till.token })).json.token;
  await db.query("UPDATE printers SET active=false");
}, 120_000);
afterAll(async () => {
  for (const s of listeners) s.close();
  await app?.close();
  await stop?.();
});

describe("the print hub (hub.mjs, as shipped)", () => {
  it("fetches a job, writes it to the printer's network port, and the server records it as printed", async () => {
    const p = await fakePrinter();
    await addPrinter("hub-a", p.port);
    await testPrint("hub-a");
    const r = await run();
    expect(r).toEqual({ delivered: 1, failed: 0 });
    expect(p.text()).toContain("PRINTER TEST");
    const jobs = (await call("/api/print/jobs?status=done", { staff: mgr, device: till.token })).json.jobs;
    expect(jobs.some((j: any) => j.printer_id === "hub-a")).toBe(true);
    expect(await run()).toEqual({ delivered: 0, failed: 0 }); // nothing is printed twice
    // and the shop can see the hub is alive
    const dev = (await call("/api/devices", { staff: mgr, device: till.token })).json.devices.find((d: any) => d.id === hub.id);
    expect(Date.now() - new Date(dev.last_print_poll_at).getTime()).toBeLessThan(20_000);
    expect((await call("/api/devices", { staff: mgr, device: till.token })).json.devices.find((d: any) => d.id === till.id).last_print_poll_at).toBeNull();
  });

  it("sends each printer its own jobs when several are waiting", async () => {
    const a = await fakePrinter();
    const b = await fakePrinter();
    await addPrinter("hub-b1", a.port);
    await addPrinter("hub-b2", b.port);
    await testPrint("hub-b1");
    await testPrint("hub-b2");
    expect(await run()).toEqual({ delivered: 2, failed: 0 });
    expect(a.text()).toContain("PRINTER TEST");
    expect(b.text()).toContain("PRINTER TEST");
  });

  it("a printer that is off loses nothing: the job fails, is queued for retry, and prints once the printer is back", async () => {
    const p = await fakePrinter();
    const port = p.port;
    await new Promise<void>((r) => p.srv.close(() => r())); // switched off
    await addPrinter("hub-off", port);
    await testPrint("hub-off");
    const first = await run();
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);
    const job = (await call("/api/print/jobs", { staff: mgr, device: till.token })).json.jobs.find((j: any) => j.printer_id === "hub-off");
    expect(["queued", "failed"]).toContain(job.status);
    expect(job.last_error).toBeTruthy();
    // switched back on, and the retry time reached
    const back = createServer();
    const got: Buffer[] = [];
    back.on("connection", (s) => s.on("data", (d) => got.push(d)));
    await new Promise<void>((r) => back.listen(port, "127.0.0.1", r));
    listeners.push(back);
    await db.query("UPDATE print_jobs SET next_attempt_at=now() - interval '1 second' WHERE printer_id='hub-off' AND status='queued'");
    expect((await run()).delivered).toBe(1);
    expect(Buffer.concat(got).toString("latin1")).toContain("PRINTER TEST");
  });

  it("tells each order how its tickets stand: printed, waiting, not printed or to be checked", async () => {
    const add = (order: string, status: string, doc = "kitchen", when = "now()") =>
      db.query("INSERT INTO print_jobs (merchant_id, outlet_id, printer_id, doc_type, order_id, dedupe_key, payload, status, last_error, created_at) VALUES ('bp','EV','hub-a',$1,$2,$3,'\\x00',$4,$5," + when + ")", [doc, order, `${order}:${doc}:${status}:${Math.random()}`, status, status === "failed" || status === "unconfirmed" ? "cannot reach printer" : null]);
    await add("st-done", "done");
    await add("st-wait", "queued");
    await add("st-fail", "failed");
    await add("st-unc", "unconfirmed");
    // A ticket that failed and was then reprinted fine counts as printed.
    await add("st-fixed", "failed", "kitchen", "now() - interval '1 minute'");
    await add("st-fixed", "done");
    // Any ticket failing makes the order need attention, even if its receipt printed.
    await add("st-mixed", "done", "receipt");
    await add("st-mixed", "failed", "kitchen");
    const r = await call("/api/print/order-status?ids=st-done,st-wait,st-fail,st-unc,st-fixed,st-mixed,st-none", { staff: mgr, device: till.token });
    expect(r.status).toBe(200);
    const st = r.json.statuses;
    expect(st["st-done"].state).toBe("printed");
    expect(st["st-wait"].state).toBe("waiting");
    expect(st["st-fail"]).toMatchObject({ state: "failed", error: "cannot reach printer" });
    expect(st["st-unc"].state).toBe("unconfirmed");
    expect(st["st-fixed"].state).toBe("printed");
    expect(st["st-mixed"].state).toBe("failed");
    expect(st["st-none"]).toBeUndefined();
    expect((await call("/api/print/order-status?ids=st-done", { device: till.token })).status).toBe(401);
  });

  it("says plainly when it has been removed from the shop's devices", async () => {
    await expect(hubMod.runOnce({ baseUrl: base, token: "not-a-real-token" })).rejects.toMatchObject({ removed: true });
  });

  it("the test page is real ESC/POS: initialise, readable text, then a paper cut", () => {
    const bytes: Buffer = hubMod.testPage();
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(bytes.toString("latin1")).toContain("If you can read this, printing works.");
    expect([...bytes.subarray(bytes.length - 4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });

  it("is a file with no dependencies, so the tablet needs nothing installed but Node", async () => {
    const { readFileSync } = await import("node:fs");
    const imports = [...readFileSync(hubFile, "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i!.startsWith("node:"))).toBe(true);
  });
});
