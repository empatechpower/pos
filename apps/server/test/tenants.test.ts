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

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
const dev: Record<string, { token: string; id: string }> = {};
const login: Record<string, string> = {};

async function call(url: string, o: { method?: string; body?: object; staff?: string; device?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.device ? { "x-device-token": o.device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const enrolAt = async (outletId: string, name: string) => {
  const e = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId, createdBy: null })).code, name))!;
  return { token: e.token, id: e.device.id };
};
const signIn = async (code: string, pin: string, device: string) => (await call("/api/auth/login", { body: { code, pin }, device })).json.token as string;

let n = 0;
/** A paid takeaway order pushed by the till of one outlet. */
async function sale(outlet: string, queue: string, cents = 500) {
  const d = dev[outlet]!;
  const orderId = `ord-${outlet}-${queue}`;
  const mk = (extra: object) => ({ id: `tn${++n}`, orderId, deviceId: d.id, ts: Date.now() + n, seq: n, ...extra });
  const events = [
    mk({ type: "OrderOpened", fulfilment: "takeaway", channelId: "take-away", channelName: "Take away", serviceCharge: false, queueNumber: queue }),
    mk({ type: "ItemAdded", lineId: `l${n}`, productId: "kopi", name: "Coffee", unitCents: cents, qty: 1 }),
    mk({ type: "PaymentRecorded", paymentId: `p${n}`, method: "cash", amountCents: cents, confirmed: true }),
  ];
  const r = await call("/api/sync/push", { body: { events }, device: d.token });
  expect(r.status).toBe(200);
  return orderId;
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true, print: new PrintStore(db, "bp") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  dev.EV = await enrolAt("EV", "EV till");
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  login.owner = await signIn("OWN", "999999", dev.EV.token);

  // Brand structure: two franchises, three outlets, plus the original EV outlet that belongs to no franchise.
  for (const f of [["FA", "Alpha Foods"], ["FB", "Beta Eats"]]) expect((await call(`/api/franchises/${f[0]}`, { method: "PUT", body: { name: f[1] }, staff: login.owner, device: dev.EV.token })).status).toBe(200);
  for (const o of [["A1", "Alpha One", "FA"], ["A2", "Alpha Two", "FA"], ["B1", "Beta One", "FB"]]) {
    expect((await call(`/api/outlets/${o[0]}`, { method: "PUT", body: { name: o[1], franchiseId: o[2] }, staff: login.owner, device: dev.EV.token })).status).toBe(200);
    dev[o[0]!] = await enrolAt(o[0]!, `${o[1]} till`);
  }
  await createStaff(db, { merchantId: "bp", code: "FAM", name: "Fran", role: "owner", pin: "111111", franchiseId: "FA" });
  await createStaff(db, { merchantId: "bp", code: "A1M", name: "Ann", role: "manager", pin: "222222", outletId: "A1" });
  login.fa = await signIn("FAM", "111111", dev.A1!.token);
  login.a1 = await signIn("A1M", "222222", dev.A1!.token);
  await sale("EV", "E1", 400);
  await sale("A1", "A1-1", 500);
  await sale("A2", "A2-1", 700);
  await sale("B1", "B1-1", 900);
}, 90_000);

afterAll(async () => {
  await app.close();
  await stop();
});

const orders = async (who: string, q = "") => call(`/api/reports/orders?from=2000-01-01&to=2100-01-01${q}`, { staff: login[who], device: dev.EV!.token });
const ids = (r: { json: any }) => (r.json.orders as Array<{ queueNumber: string }>).map((o) => o.queueNumber).sort();

describe("brand, franchise and outlet access", () => {
  it("the original outlet is created for the brand at start, and outlets are listed by what each login may see", async () => {
    const all = await call("/api/outlets", { staff: login.owner, device: dev.EV!.token });
    expect(all.json.outlets.map((o: any) => o.id).sort()).toEqual(["A1", "A2", "B1", "EV"]);
    expect(all.json.scope.brandWide).toBe(true);
    const fa = await call("/api/outlets", { staff: login.fa, device: dev.A1!.token });
    expect(fa.json.outlets.map((o: any) => o.id).sort()).toEqual(["A1", "A2"]);
    expect(fa.json.franchises.map((f: any) => f.id)).toEqual(["FA"]);
    expect(fa.json.scope).toMatchObject({ brandWide: false, franchiseId: "FA" });
    const a1 = await call("/api/outlets", { staff: login.a1, device: dev.A1!.token });
    expect(a1.json.outlets.map((o: any) => o.id)).toEqual(["A1"]);
  });

  it("the brand owner sees every outlet's orders; a franchise login only its outlets; an outlet login only its own", async () => {
    expect(ids(await orders("owner"))).toEqual(["A1-1", "A2-1", "B1-1", "E1"]);
    expect(ids(await orders("fa"))).toEqual(["A1-1", "A2-1"]);
    expect(ids(await orders("a1"))).toEqual(["A1-1"]);
  });

  it("asking for an outlet outside the scope is refused, and inside it narrows the report", async () => {
    expect((await orders("fa", "&outlet=B1")).status).toBe(403);
    expect((await orders("a1", "&outlet=A2")).status).toBe(403);
    expect(ids(await orders("fa", "&outlet=A2"))).toEqual(["A2-1"]);
    expect(ids(await orders("owner", "&outlet=B1"))).toEqual(["B1-1"]);
    const sales = await call("/api/reports/sales?from=2000-01-01&to=2100-01-01&outlet=A1", { staff: login.fa, device: dev.A1!.token });
    expect(sales.json.orders).toBe(1);
    expect((await call("/api/reports/sales?from=2000-01-01&to=2100-01-01&outlet=B1", { staff: login.fa, device: dev.A1!.token })).status).toBe(403);
  });

  it("the roll-up lists each visible outlet with its own sales, and a total of only those", async () => {
    const q = "?from=2000-01-01&to=2100-01-01";
    const owner = (await call(`/api/reports/outlets${q}`, { staff: login.owner, device: dev.EV!.token })).json;
    expect(owner.outlets.map((o: any) => [o.outletId, o.summary.netToAccountForCents]).sort()).toEqual([["A1", 500], ["A2", 700], ["B1", 900], ["EV", 400]]);
    expect(owner.total.netToAccountForCents).toBe(2500);
    const fa = (await call(`/api/reports/outlets${q}`, { staff: login.fa, device: dev.A1!.token })).json;
    expect(fa.outlets.map((o: any) => o.outletId).sort()).toEqual(["A1", "A2"]);
    expect(fa.total.netToAccountForCents).toBe(1200);
  });

  it("a device syncs only its own outlet's events", async () => {
    const pull = await call("/api/sync/pull?after=0", { device: dev.B1!.token });
    const mine = new Set((pull.json.events as any[]).map((e) => e.event.orderId));
    expect([...mine]).toEqual(["ord-B1-B1-1"]);
  });

  it("devices, printers and print jobs of other outlets are not visible or changeable", async () => {
    const devices = await call("/api/devices", { staff: login.fa, device: dev.A1!.token });
    expect(devices.json.devices.every((d: any) => ["A1", "A2"].includes(d.outlet_id))).toBe(true);
    expect((await call("/api/devices", { staff: login.owner, device: dev.EV!.token })).json.devices.length).toBeGreaterThanOrEqual(4);
    const printer = (id: string, outletId: string) => ({ name: id, outletId, language: "escpos", roles: ["receipt"], widthChars: 42, connection: { host: "10.0.0.9", port: 9100 } });
    expect((await call("/api/printers/pa1", { method: "PUT", body: printer("pa1", "A1"), staff: login.a1, device: dev.A1!.token })).status).toBe(200);
    expect((await call("/api/printers/pb1", { method: "PUT", body: printer("pb1", "B1"), staff: login.a1, device: dev.A1!.token })).status).toBe(403);
    expect((await call("/api/printers/pb1", { method: "PUT", body: printer("pb1", "B1"), staff: login.owner, device: dev.EV!.token })).status).toBe(200);
    expect((await call("/api/printers", { staff: login.a1, device: dev.A1!.token })).json.printers.map((p: any) => p.id)).toEqual(["pa1"]);
  });

  it("an order prints only at the outlet that took it", async () => {
    await sale("A1", "A1-2", 300);
    await sale("B1", "B1-2", 300);
    const jobs = (await call("/api/print/jobs", { staff: login.owner, device: dev.EV!.token })).json.jobs as Array<{ printer_id: string; order_id: string }>;
    expect(jobs.filter((j) => j.order_id === "ord-A1-A1-2").map((j) => j.printer_id)).toEqual(["pa1"]);
    expect(jobs.filter((j) => j.order_id === "ord-B1-B1-2").map((j) => j.printer_id)).toEqual(["pb1"]);
    const seen = (await call("/api/print/jobs", { staff: login.a1, device: dev.A1!.token })).json.jobs as Array<{ printer_id: string }>;
    expect(seen.every((j) => j.printer_id === "pa1")).toBe(true);
    expect((await call("/api/print/reprint", { body: { orderId: "ord-B1-B1-2", docType: "receipt" }, staff: login.a1, device: dev.A1!.token })).status).toBe(403);
  });

  it("the menu belongs to the brand: a franchise or outlet login cannot change it, the owner can", async () => {
    const products = (await call("/api/catalog", { device: "" })).json.products;
    const body = { id: products[0].id, name: products[0].name, category: products[0].category };
    expect((await call("/api/catalog/products", { body, staff: login.a1, device: dev.A1!.token })).status).toBe(403);
    expect((await call("/api/catalog/products", { body, staff: login.fa, device: dev.A1!.token })).status).toBe(403);
    expect((await call("/api/catalog/products", { body, staff: login.owner, device: dev.EV!.token })).status).toBe(200);
  });

  it("staff are created inside the creator's scope only, and only for outlets that exist", async () => {
    const mk = (code: string, extra: object, who: string, device = dev.A1!.token) => call("/api/staff", { body: { code, name: code, role: "cashier", pin: "4444", ...extra }, staff: login[who], device });
    expect((await mk("N1", { outletId: "A2" }, "fa")).status).toBe(200); // inside the franchise
    expect((await mk("N2", { outletId: "B1" }, "fa")).status).toBe(403); // another franchise
    expect((await mk("N3", {}, "fa")).status).toBe(403); // brand-wide: not theirs to give
    expect((await mk("N4", { franchiseId: "FB" }, "fa")).status).toBe(403);
    expect((await mk("N5", { outletId: "ZZ" }, "owner", dev.EV!.token)).status).toBe(400);
    expect((await mk("N6", { outletId: "A1", franchiseId: "FA" }, "owner", dev.EV!.token)).status).toBe(400);
    expect((await mk("N7", { franchiseId: "FB" }, "owner", dev.EV!.token)).status).toBe(200);
    const me = await call("/api/auth/login", { body: { code: "N7", pin: "4444" }, device: dev.B1!.token });
    expect(me.json.staff).toMatchObject({ franchiseId: "FB", outletId: null });
  });

  it("only the brand owner adds outlets or franchises or moves an outlet; a manager can edit their own outlet's details", async () => {
    const put = (id: string, body: object, who: string, device = dev.A1!.token) => call(`/api/outlets/${id}`, { method: "PUT", body, staff: login[who], device });
    expect((await put("A1", { name: "Alpha One", hours: "Daily 7am-10pm", phone: "+65 6000 1111", address: "1 Alpha Rd" }, "a1")).status).toBe(200);
    expect((await put("A2", { name: "Alpha Two", hours: "x" }, "a1")).status).toBe(403); // not their outlet
    expect((await put("A1", { name: "Alpha One", franchiseId: "FB" }, "a1")).status).toBe(403); // moving is the owner's
    expect((await put("NEW", { name: "New outlet" }, "fa")).status).toBe(403); // adding is the owner's
    expect((await call("/api/franchises/FC", { method: "PUT", body: { name: "Gamma" }, staff: login.fa, device: dev.A1!.token })).status).toBe(403);
    expect((await put("NEW", { name: "New outlet", franchiseId: "NOPE" }, "owner", dev.EV!.token)).status).toBe(400);
    expect((await put("NEW", { name: "New outlet", franchiseId: "FA" }, "owner", dev.EV!.token)).status).toBe(200);
    expect((await call("/api/outlets", { staff: login.fa, device: dev.A1!.token })).json.outlets.map((o: any) => o.id).sort()).toEqual(["A1", "A2", "NEW"]);
  });

  it("customers see the opening hours, phone and address from the outlet setup", async () => {
    await call("/api/outlets/EV", { method: "PUT", body: { name: "EV", hours: "Mon-Fri 9am-6pm", phone: "+65 6000 2222", address: "2 Village Way" }, staff: login.owner, device: dev.EV!.token });
    const info = (await call("/api/shop/info")).json;
    expect(info.contact).toEqual({ hours: "Mon-Fri 9am-6pm", phone: "+65 6000 2222", address: "2 Village Way" });
  });
});
