import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAlert, parseUobAlert, findReference, type RawAlert } from "../src/paynowAlert.js";
import { issueQr } from "../src/paynow.js";
import { processAlertFor, startAlertWatchMulti, type WatchTarget } from "../src/paynowMatcher.js";
import { buildReference, cleanPaynowConfig, type PaynowConfig } from "../src/paynowQr.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const PASS = "mx.google.com; dkim=pass header.i=@uob.com.sg; spf=pass smtp.mailfrom=uob.com.sg; dmarc=pass header.from=uob.com.sg";
const UOB_SENDER = "UOB eAlert Service <ealert@uobgroup.example>"; // the real sender address is not known yet: it is a setting
/** The layout of UOB's "Incoming Funds Received" email, as shown in the sample. */
const uob = (o: { remarks: string; cents?: number; ending?: string; id?: string; at?: number }): RawAlert => ({
  id: o.id ?? `u-${o.remarks}`,
  from: UOB_SENDER,
  subject: "Notification: Incoming Funds Received",
  date: new Date(o.at ?? Date.now() + 2000).toUTCString(),
  authResults: PASS,
  body: `Your SGD account ending ${o.ending ?? "0915"} received SGD ${((o.cents ?? 50000) / 100).toFixed(2)} on 02 NOV 2026, 16:59.\nRef1: PAYNOW OTHR.\nRef2: IRAS.\nRemarks: ${o.remarks}.\n\nDo not reply to this email address.\n\nIMPORTANT NOTICE: This email is intended for the Account Holder of the Account above and contains confidential information.`,
});
const dbs = (o: { ref: string; cents: number; ending?: string; at?: number }): RawAlert => ({
  id: `d-${o.ref}`, from: "DBS iBanking Alerts <ibanking.alert@dbs.com>", subject: "You've received a transfer", date: new Date(o.at ?? Date.now() + 2000).toUTCString(), authResults: PASS,
  body: `You've received a transfer. Amount: SGD ${(o.cents / 100).toFixed(2)} From: TAN AH KOW To your account ending ${o.ending ?? "0915"}. Transaction Ref: ${o.ref}`,
});

describe("reading UOB's alert", () => {
  it("takes the account, amount and remarks from the sample, and uses the email itself as its identity", () => {
    const p = parseUobAlert(uob({ remarks: "SMECG-124309647", id: "m-1" }))!;
    expect(p).toMatchObject({ accountEnding: "0915", amountCents: 50000, remarks: "SMECG-124309647", payerName: "", bankRef: "UOB:m-1", reference: null });
    expect(parseAlert(uob({ remarks: "SMECG-124309647" }))?.bankRef).toMatch(/^UOB:/);
  });
  it("finds our reference in the remarks, however the bank dresses it", () => {
    const ref = buildReference({ channel: "P", outletCode: "B1", seq: 42, amountCents: 500 });
    expect(findReference(ref)).toBe(ref);
    expect(findReference(`pay ${ref.toLowerCase().replace(/(.{4})/g, "$1 ")} thanks`)).toBe(ref);
    expect(findReference(ref.slice(0, 19) + (ref[19] === "A" ? "B" : "A"))).toBeNull(); // a wrong check character is never believed
    expect(findReference("SMECG-124309647")).toBeNull();
    expect(parseUobAlert(uob({ remarks: ref }))?.reference).toBe(ref);
  });
  it("gives up rather than guess when the email is not an alert", () => {
    expect(parseUobAlert({ ...uob({ remarks: "x" }), body: "Hello, nothing here" })).toBeNull();
  });
  it("leaves DBS alerts as they were: a bank reference, no order reference", () => {
    expect(parseAlert(dbs({ ref: "ABC123456789", cents: 2450 }))).toMatchObject({ bankRef: "ABC123456789", reference: null, remarks: null });
  });
});

describe("matching by the order's reference", () => {
  let db: Db;
  let stop: () => Promise<void>;
  let n = 0;
  const cfg: PaynowConfig = (cleanPaynowConfig({ proxyType: "uen", proxyValue: "201912345K", displayName: "BAILEY AND PATCH", outletCode: "B1", ttlMinutes: 2, receivingAccountEnding: "0915", alertSender: "ealert@uobgroup.example" }) as { config: PaynowConfig }).config;
  const applied: Array<{ orderId: string; matchedBy?: string }> = [];
  const apply = async (o: { orderId: string; matchedBy?: string }) => { applied.push(o); return true; };
  const qr = (orderId: string, cents: number, at = Date.now()) => issueQr(db, cfg, { merchantId: "bp", orderId, amountCents: cents, channel: "P", now: at });
  const stateOf = async (paymentId: string) => (await db.query("SELECT state, matched_by FROM payment_expectations WHERE payment_id=$1", [paymentId])).rows[0] as { state: string; matched_by: string | null };
  const id = () => `m${++n}`;
  beforeAll(async () => { ({ db, stop } = await startTestDb()); }, 120_000);
  afterAll(async () => { await stop?.(); });

  it("claims the QR the reference names, not merely the earliest one for that amount", async () => {
    const a = await qr("o-a", 500, Date.now() - 4000);
    const b = await qr("o-b", 500, Date.now() - 3000);
    applied.length = 0;
    expect(await processAlertFor(db, "bp", [cfg], uob({ remarks: b.reference, cents: 500, id: id() }), apply)).toBe("claimed");
    expect(applied).toEqual([{ orderId: "o-b", amountCents: 500, paymentId: expect.any(String), payer: "", matchedBy: "reference" }]);
    expect(await stateOf(b.paymentId)).toEqual({ state: "PAID", matched_by: "reference" });
    expect((await stateOf(a.paymentId)).state).toBe("WAITING");
  });

  it("an amount that is not what the QR asked for goes to staff, and the QR stays open", async () => {
    const q = await qr("o-c", 700);
    expect(await processAlertFor(db, "bp", [cfg], uob({ remarks: q.reference, cents: 600, id: id() }), apply)).toBe("unassigned");
    expect((await stateOf(q.paymentId)).state).toBe("WAITING");
    expect((await db.query("SELECT resolution FROM payment_alerts WHERE remarks=$1", [q.reference])).rows[0].resolution).toContain("different amount");
  });

  it("a QR that has run out can still be paid by its reference, and a second payment of it goes to staff", async () => {
    const q = await qr("o-d", 800);
    await db.query("UPDATE payment_expectations SET expires_at = now() - interval '10 minutes' WHERE payment_id=$1", [q.paymentId]);
    expect(await processAlertFor(db, "bp", [cfg], uob({ remarks: q.reference, cents: 800, id: id() }), apply)).toBe("claimed");
    expect(await processAlertFor(db, "bp", [cfg], uob({ remarks: q.reference, cents: 800, id: id() }), apply)).toBe("unassigned");
  });

  it("a reference we never issued is never guessed past: it does not take another QR of the same amount", async () => {
    const open = await qr("o-e", 900);
    const stranger = buildReference({ channel: "P", outletCode: "B1", seq: 987654, amountCents: 900 });
    expect(await processAlertFor(db, "bp", [cfg], uob({ remarks: stranger, cents: 900, id: id() }), apply)).toBe("unassigned");
    expect((await stateOf(open.paymentId)).state).toBe("WAITING");
  });

  it("money paid into another account than the QR named is not claimed", async () => {
    const q = await qr("o-f", 1100);
    expect(await processAlertFor(db, "bp", [{ ...cfg, receivingAccountEnding: undefined }], uob({ remarks: q.reference, cents: 1100, ending: "7777", id: id() }), apply)).toBe("unassigned");
    expect((await stateOf(q.paymentId)).state).toBe("WAITING");
  });

  it("with no reference in the alert (DBS), the amount and time still match, and it is recorded as only probable", async () => {
    const q = await qr("o-g", 1300);
    expect(await processAlertFor(db, "bp", [{ ...cfg, alertSender: "ibanking.alert@dbs.com" }], dbs({ ref: "DBSREF000001", cents: 1300 }), apply)).toBe("claimed");
    expect(await stateOf(q.paymentId)).toEqual({ state: "PAID", matched_by: "amount" });
    expect(applied.at(-1)?.matchedBy).toBe("amount");
    expect((await db.query("SELECT matched_by FROM payment_alerts WHERE bank_ref='DBSREF000001'")).rows[0].matched_by).toBe("amount");
  });

  it("a payment that lands within two minutes after the QR timed out still pays its order; later than that it waits for staff", async () => {
    const t = Date.now();
    const q = await qr("o-late", 1700, t - 4 * 60_000); // issued 4 min ago, timed out 2 min ago (it lived 2)
    const late = new Date(t - 60_000).getTime(); // the bank's email: 1 minute after it timed out
    expect(await processAlertFor(db, "bp", [{ ...cfg, alertSender: "ibanking.alert@dbs.com" }], dbs({ ref: "LATE00000001", cents: 1700, at: late }), apply)).toBe("claimed");
    expect((await stateOf(q.paymentId)).state).toBe("PAID");
    const q2 = await qr("o-later", 1800, t - 8 * 60_000); // timed out 6 minutes ago
    expect(await processAlertFor(db, "bp", [{ ...cfg, alertSender: "ibanking.alert@dbs.com" }], dbs({ ref: "LATE00000002", cents: 1800, at: t }), apply)).toBe("unassigned");
    expect((await stateOf(q2.paymentId)).state).toBe("WAITING");
  });

  it("asking for a new QR retires the old one: a payment by amount goes to the new one", async () => {
    const t = Date.now();
    const old = await qr("o-regen", 1900, t - 1000);
    const fresh = await qr("o-regen", 1900, t); // the customer tapped New QR
    expect((await stateOf(old.paymentId)).state).toBe("EXPIRED");
    expect(await processAlertFor(db, "bp", [{ ...cfg, alertSender: "ibanking.alert@dbs.com" }], dbs({ ref: "REGEN0000001", cents: 1900, at: t + 3000 }), apply)).toBe("claimed");
    expect((await stateOf(fresh.paymentId)).state).toBe("PAID");
    expect((await stateOf(old.paymentId)).state).toBe("EXPIRED");
  });

  it("the same email read twice pays once", async () => {
    const q = await qr("o-h", 1500);
    const mail = uob({ remarks: q.reference, cents: 1500, id: "same-email" });
    expect(await processAlertFor(db, "bp", [cfg], mail, apply)).toBe("claimed");
    expect(await processAlertFor(db, "bp", [cfg], mail, apply)).toBe("duplicate");
  });
});

describe("pulling only while a QR is live", () => {
  let db: Db;
  let stop: () => Promise<void>;
  const cfg: PaynowConfig = (cleanPaynowConfig({ proxyType: "uen", proxyValue: "201912345K", displayName: "BAILEY AND PATCH", outletCode: "B1", ttlMinutes: 2, alertSender: "ealert@uobgroup.example" }) as { config: PaynowConfig }).config;
  beforeAll(async () => { ({ db, stop } = await startTestDb()); }, 120_000);
  afterAll(async () => { await stop?.(); });

  it("does not read the mailbox when nothing is waiting, starts when a QR is made, and stops a little after it runs out", async () => {
    let reads = 0;
    const mailbox = { fetch: async () => { reads++; return []; } };
    const targets = async (): Promise<WatchTarget[]> => [{ key: "default", mailbox, configs: [cfg] }];
    const stopWatch = startAlertWatchMulti({ db, merchantId: "bp", targets, apply: async () => true, now: Date.now, liveMs: 20, graceMs: 300 });
    try {
      await new Promise((r) => setTimeout(r, 250));
      expect(reads).toBe(0); // idle: no pulls at all
      const q = await issueQr(db, cfg, { merchantId: "bp", orderId: "o-w", amountCents: 500, channel: "P", now: Date.now() });
      await new Promise((r) => setTimeout(r, 250));
      expect(reads).toBeGreaterThan(2); // pulling while it is live
      await db.query("UPDATE payment_expectations SET expires_at = now() - interval '5 seconds' WHERE payment_id=$1", [q.paymentId]); // run out, past the grace
      await new Promise((r) => setTimeout(r, 100));
      const after = reads;
      await new Promise((r) => setTimeout(r, 250));
      expect(reads).toBe(after); // stopped
    } finally { stopWatch(); }
  });
});
