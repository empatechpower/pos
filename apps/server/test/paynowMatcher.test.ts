import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { authenticated, parseAlert, type RawAlert } from "../src/paynowAlert.js";
import { MemoryMailbox, processAlert } from "../src/paynowMatcher.js";
import type { PaynowConfig } from "../src/paynowQr.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const PASS = "mx.google.com; dkim=pass header.i=@dbs.com; spf=pass smtp.mailfrom=dbs.com; dmarc=pass (p=REJECT) header.from=dbs.com";
const ref = (n: number) => `TXN${String(n).padStart(9, "0")}`;
const alert = (o: { id?: string; ref: string; cents: number; payer?: string; ending?: string; at?: number; auth?: string; from?: string }): RawAlert => ({
  id: o.id ?? `m-${o.ref}`,
  from: o.from ?? "DBS iBanking Alerts <ibanking.alert@dbs.com>",
  subject: "You've received a transfer",
  date: new Date(o.at ?? Date.now() + 3000).toUTCString(),
  authResults: o.auth ?? PASS,
  body: `You've received a transfer. Amount: SGD ${(o.cents / 100).toFixed(2)} From: ${o.payer ?? "TAN AH KOW"} To your account ending ${o.ending ?? "1234"}. Transaction Ref: ${o.ref}`,
});

describe("reading a bank alert", () => {
  it("takes out amount, payer, account, bank reference and the sent time", () => {
    const p = parseAlert(alert({ ref: "ABC123456789", cents: 2450, payer: "LIM MEI LING", at: Date.UTC(2026, 10, 23, 4, 5, 6) }))!;
    expect(p).toMatchObject({ bankRef: "ABC123456789", amountCents: 2450, payerName: "LIM MEI LING", accountEnding: "1234", emailDate: Date.UTC(2026, 10, 23, 4, 5, 6) });
  });
  it("gives up rather than guess when a field is missing", () => {
    expect(parseAlert({ ...alert({ ref: "ABC123456789", cents: 100 }), body: "Hello, nothing here" })).toBeNull();
    expect(parseAlert({ ...alert({ ref: "ABC123456789", cents: 100 }), date: "not a date" })).toBeNull();
  });
  it("needs DKIM, SPF and DMARC all to pass", () => {
    expect(authenticated(PASS)).toBe(true);
    expect(authenticated(PASS.replace("dmarc=pass", "dmarc=fail"))).toBe(false);
    expect(authenticated("mx; dkim=pass; spf=pass")).toBe(false);
    expect(authenticated("")).toBe(false);
  });
});

describe("matching alerts to QRs", () => {
  const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let ip = 0;
  let n = 100;
  let till = { token: "", id: "" };
  let staff = "";
  const mailbox = new MemoryMailbox();
  const cfg: PaynowConfig = { proxyType: "uen", proxyValue: "201912345K", displayName: "BAILEY AND PATCH", outletCode: "B1", ttlMinutes: 3, receivingAccountEnding: "1234", alertSender: "ibanking.alert@dbs.com" };
  const applied: { orderId: string; paymentId: string }[] = [];
  const okApply = async (o: { orderId: string; paymentId: string }) => { applied.push(o); return true; };

  const call = async (url: string, o: { body?: unknown; device?: string; bearer?: string } = {}) => {
    const res = await fetch(base + url, {
      method: o.body !== undefined ? "POST" : "GET",
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.device || o.bearer || o.body !== undefined && url.includes("auth") ? { "x-device-token": o.device ?? till.token } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  };
  const place = (qty = 5) => call("/api/shop/orders", { body: { channelId: "take-away", items: [{ productId: "kaya-toast", qty }], customerPhone: "9123 4567" } });
  const qr = (id: string) => call(`/api/shop/orders/${id}/pay`, { body: { method: "paynow", display: "qr" } });
  const status = async (id: string) => (await call(`/api/payments/paynow/status/${id}`)).json.state;
  const orderPaid = async (orderId: string) => {
    const evs = await store.eventsForOrder(orderId);
    return evs.some((e: any) => e.type === "PaymentRecorded" && e.confirmed);
  };
  let store: PgEventStore;

  beforeAll(async () => {
    process.env.PAYNOW_PROXY_TYPE = "uen"; process.env.PAYNOW_PROXY_VALUE = "201912345K"; process.env.PAYNOW_NAME = "Bailey and Patch"; process.env.PAYNOW_OUTLET_CODE = "B1";
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    store = new PgEventStore(db, "bp", "EV");
    app = await buildApp({ config, db, logger: false, store, catalog: cat, catalogAdmin: cat, trustProxy: true, alertMailbox: mailbox, alertWatchMs: 100 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const e = (await enroll(db, "bp", c.code, "Till"))!;
    till = { token: e.token, id: e.device.id };
    // The shop's PayNow settings with the bank's sender and account, as the owner would save them.
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ('bp','paynow',$1::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(cfg)]);
    void till;
  }, 120_000);
  afterAll(async () => {
    delete process.env.PAYNOW_PROXY_TYPE; delete process.env.PAYNOW_PROXY_VALUE; delete process.env.PAYNOW_NAME; delete process.env.PAYNOW_OUTLET_CODE;
    await app?.close();
    await stop?.();
  });

  it("two live QRs for the same amount and one alert: the earliest is claimed, the other untouched", async () => {
    const a = await place(); const b = await place();
    const qa = await qr(a.json.orderId); await new Promise((r) => setTimeout(r, 15)); const qb = await qr(b.json.orderId);
    expect(a.json.totalCents).toBe(b.json.totalCents);
    const out = await processAlert(db, "bp", cfg, alert({ ref: ref(++n), cents: a.json.totalCents }), okApply);
    expect(out).toBe("claimed");
    const rows = (await db.query("SELECT payment_id, state FROM payment_expectations WHERE payment_id = ANY($1)", [[qa.json.paymentId, qb.json.paymentId]])).rows;
    expect(rows.find((r) => r.payment_id === qa.json.paymentId).state).toBe("PAID");
    expect(rows.find((r) => r.payment_id === qb.json.paymentId).state).toBe("WAITING");
    expect(applied.at(-1)!.orderId).toBe(a.json.orderId);
  });

  it("the same alert twice claims once", async () => {
    const o = await place(3); await qr(o.json.orderId); await qr((await place(3)).json.orderId);
    const al = alert({ ref: ref(++n), cents: o.json.totalCents });
    const before = applied.length;
    expect(await processAlert(db, "bp", cfg, al, okApply)).toBe("claimed");
    expect(await processAlert(db, "bp", cfg, { ...al, id: "again" }, okApply)).toBe("duplicate");
    expect(applied.length).toBe(before + 1);
  });

  it("an alert that fails DMARC, or comes from another sender, claims nothing and is not kept", async () => {
    const o = await place(2); const q = await qr(o.json.orderId);
    const bad = alert({ ref: ref(++n), cents: o.json.totalCents, auth: PASS.replace("dmarc=pass", "dmarc=fail") });
    expect(await processAlert(db, "bp", cfg, bad, okApply)).toBe("unauthenticated");
    expect(await processAlert(db, "bp", cfg, alert({ ref: ref(++n), cents: o.json.totalCents, from: "scam@evil.example" }), okApply)).toBe("wrong_sender");
    expect(await status(q.json.paymentId)).toBe("WAITING");
    expect((await db.query("SELECT 1 FROM payment_alerts WHERE bank_ref=$1", [`TXN${String(n - 1).padStart(9, "0")}`])).rowCount).toBe(0);
  });

  it("a payment after the QR's minutes went to the unassigned pool, and staff can see it", async () => {
    const o = await place(4); const q = await qr(o.json.orderId);
    await db.query("UPDATE payment_expectations SET expires_at = now() - interval '1 minute' WHERE payment_id=$1", [q.json.paymentId]);
    const r = ref(++n);
    expect(await processAlert(db, "bp", cfg, alert({ ref: r, cents: o.json.totalCents, payer: "WONG KAI" }), okApply)).toBe("unassigned");
    expect(await status(q.json.paymentId)).toBe("NOT_FOUND");
    const row = (await db.query("SELECT status, payer_name FROM payment_alerts WHERE bank_ref=$1", [r])).rows[0];
    expect(row).toEqual({ status: "UNASSIGNED", payer_name: "WONG KAI" });
  });

  it("an alert for another account of the owner's is set aside; the wrong amount finds nothing", async () => {
    const o = await place(2); const q = await qr(o.json.orderId);
    expect(await processAlert(db, "bp", cfg, alert({ ref: ref(++n), cents: o.json.totalCents, ending: "9999" }), okApply)).toBe("other_account");
    expect(await processAlert(db, "bp", cfg, alert({ ref: ref(++n), cents: o.json.totalCents + 1 }), okApply)).toBe("unassigned");
    expect(await status(q.json.paymentId)).toBe("WAITING");
  });

  it("when the order cannot take the money, the QR is released and the payment goes to staff", async () => {
    const o = await place(6); const q = await qr(o.json.orderId);
    const out = await processAlert(db, "bp", cfg, alert({ ref: ref(++n), cents: o.json.totalCents }), async () => false);
    expect(out).toBe("unassigned");
    expect(await status(q.json.paymentId)).toBe("WAITING");
  });

  it("end to end: the watcher reads the mailbox, the QR turns PAID and the order is paid", async () => {
    const o = await place(7); const q = await qr(o.json.orderId);
    mailbox.messages.push(alert({ ref: ref(++n), cents: o.json.totalCents, payer: "NG SOO LIN" }));
    for (let i = 0; i < 60 && (await status(q.json.paymentId)) !== "PAID"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await status(q.json.paymentId)).toBe("PAID");
    expect(await orderPaid(o.json.orderId)).toBe(true);
    const st = (await call(`/api/payments/paynow/status/${q.json.paymentId}`)).json;
    expect(st.paidAt).toBeGreaterThan(0);
  });

  it("staff list the pool and assign a payment to an order that is owed exactly that", async () => {
    const lost = await place(8); const q = await qr(lost.json.orderId);
    await db.query("UPDATE payment_expectations SET expires_at = now() - interval '1 minute' WHERE payment_id=$1", [q.json.paymentId]);
    const r = ref(++n);
    mailbox.messages.push(alert({ ref: r, cents: lost.json.totalCents, payer: "TAY BOON" }));
    for (let i = 0; i < 60 && !(await db.query("SELECT 1 FROM payment_alerts WHERE bank_ref=$1", [r])).rowCount; i++) await new Promise((x) => setTimeout(x, 100));
    // Staff sign-in: the pool is for the owner.
    const tok = await ownerToken();
    const list = await call("/api/payments/paynow/unassigned", { bearer: tok });
    expect(list.status).toBe(200);
    expect(list.json.payments.find((p: any) => p.bankRef === r)).toMatchObject({ amountCents: lost.json.totalCents, payerName: "TAY BOON" });
    const cand = await call(`/api/payments/paynow/candidates?amount=${lost.json.totalCents}`, { bearer: tok });
    expect(cand.status).toBe(200);
    expect(cand.json.orders.map((o: any) => o.orderId)).toContain(lost.json.orderId);
    expect((await call("/api/payments/paynow/candidates?amount=1", { bearer: tok })).json.orders).toEqual([]);
    expect((await call(`/api/payments/paynow/unassigned/${r}/assign`, { bearer: tok, body: { orderId: (await place(1)).json.orderId } })).status).toBe(409);
    expect((await call(`/api/payments/paynow/unassigned/${r}/assign`, { bearer: tok, body: { orderId: lost.json.orderId } })).status).toBe(200);
    expect(await orderPaid(lost.json.orderId)).toBe(true);
    expect((await call("/api/payments/paynow/unassigned", { bearer: tok })).json.payments.some((p: any) => p.bankRef === r)).toBe(false);
    expect((await call(`/api/payments/paynow/unassigned/${r}/assign`, { bearer: tok, body: { orderId: lost.json.orderId } })).status).toBe(404);
  });

  it("the till gets a P-channel QR for what the server says is owed, and a cashier cannot touch the pool", async () => {
    await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat Cashier", role: "cashier", pin: "3333" });
    const cash = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    const o = await place(9);
    const r = await call("/api/payments/paynow/qr", { bearer: cash, body: { orderId: o.json.orderId } });
    expect(r.status).toBe(200);
    expect(r.json.amountCents).toBe(o.json.totalCents);
    expect(r.json.reference).toMatch(/^RZPB1/);
    expect(r.json.payload).toContain((o.json.totalCents / 100).toFixed(2));
    expect(await status(r.json.paymentId)).toBe("WAITING");
    expect((await call("/api/payments/paynow/qr", { bearer: cash, body: { orderId: "nope" } })).status).toBe(404);
    expect((await call("/api/payments/paynow/qr", { body: { orderId: o.json.orderId } })).status).toBe(401);
    expect((await call("/api/payments/paynow/unassigned", { bearer: cash })).status).toBe(403);
    await createStaff(db, { merchantId: "bp", code: "M1", name: "Max Manager", role: "manager", pin: "222222" });
    const mgr = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    expect((await call("/api/payments/paynow/unassigned", { bearer: mgr })).status).toBe(200);
  });

  it("the phone shop's QR is on the O channel, and the shop's smallest and largest amounts are enforced", async () => {
    const o = await place(3);
    const r = await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "paynow", display: "qr", surface: "online" } });
    expect(r.status).toBe(200);
    expect(r.json.reference).toMatch(/^RZOB1/);
    expect((await call(`/api/shop/orders/${o.json.orderId}`)).json.canPayPaynow).toBe(true);
    const tight = { ...cfg, maxCents: o.json.totalCents - 1 };
    await db.query("UPDATE merchant_settings SET value=$1::jsonb WHERE merchant_id='bp' AND key='paynow'", [JSON.stringify(tight)]);
    const big = await call(`/api/shop/orders/${o.json.orderId}/pay`, { body: { method: "paynow", display: "qr" } });
    expect(big.status).toBe(409);
    expect(big.json).toMatchObject({ error: "amount_not_allowed", maxCents: o.json.totalCents - 1 });
    const till = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    expect((await call("/api/payments/paynow/qr", { bearer: till, body: { orderId: o.json.orderId } })).status).toBe(409);
    await db.query("UPDATE merchant_settings SET value=$1::jsonb WHERE merchant_id='bp' AND key='paynow'", [JSON.stringify(cfg)]);
  });

  it("a reference from a screenshot is checked and traced back to its QR", async () => {
    const o = await place(2); const q = await qr(o.json.orderId);
    const mgr = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    const ok = await call(`/api/payments/paynow/lookup?ref=${q.json.reference}`, { bearer: mgr });
    expect(ok.json).toMatchObject({ checkOk: true, found: true, orderId: o.json.orderId, amountCents: o.json.totalCents, state: "WAITING" });
    const slip = q.json.reference.slice(0, 7) + (q.json.reference[7] === "7" ? "8" : "7") + q.json.reference.slice(8);
    expect((await call(`/api/payments/paynow/lookup?ref=${slip}`, { bearer: mgr })).json).toMatchObject({ checkOk: false, found: false });
    expect((await call("/api/payments/paynow/lookup?ref=SHORT", { bearer: mgr })).status).toBe(400);
  });

  it("the pool is closed to anyone not signed in", async () => {
    expect((await call("/api/payments/paynow/unassigned")).status).toBe(401);
  });

  async function ownerToken(): Promise<string> {
    if (staff) return staff;
    await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olivia Owner", role: "owner", pin: "111111" });
    staff = (await call("/api/auth/login", { body: { code: "OWN", pin: "111111" } })).json.token;
    return staff;
  }
});
