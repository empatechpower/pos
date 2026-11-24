import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { ImapMailbox, rawToAlert, type ImapFactory } from "../src/imapMailbox.js";
import { addMailbox, hostProblem, plainProblem, removeMailbox } from "../src/mailboxes.js";
import { allPaynowConfigs, issueQr, loadPaynow, savePaynow, savePaynowOverride } from "../src/paynow.js";
import { processAlertFor, type WatchTarget } from "../src/paynowMatcher.js";
import { watchTargets } from "../src/paynowWatch.js";
import { authenticated, parseAlert } from "../src/paynowAlert.js";
import { seal, secretKey, unseal } from "../src/secrets.js";
import { upsertOutlet } from "../src/tenant.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const KEY = "ab".repeat(32);
const RAW = (o: { ending?: string; ref?: string; cents?: number; auth?: string } = {}) => Buffer.from([
  "From: DBS iBanking Alerts <ibanking.alert@dbs.com>",
  "To: shop@example.com",
  "Subject: You've received a transfer",
  "Date: Mon, 23 Nov 2026 04:05:06 +0000",
  "Message-ID: <abc@dbs.com>",
  `Authentication-Results: mx.google.com; dkim=pass header.i=@dbs.com; spf=pass smtp.mailfrom=dbs.com; ${o.auth ?? "dmarc=pass"} header.from=dbs.com`,
  "Content-Type: text/plain; charset=utf-8",
  "",
  `You've received a transfer. Amount: SGD ${((o.cents ?? 2450) / 100).toFixed(2)} From: LIM MEI LING To your account ending ${o.ending ?? "1234"}. Transaction Ref: ${o.ref ?? "TXN000000001"}`,
].join("\r\n"));

describe("keeping a mailbox password safe", () => {
  it("seals it so it never reads as written, and only the right key opens it", () => {
    const key = Buffer.from(KEY, "hex");
    const a = seal("hunter2-app-password", key), b = seal("hunter2-app-password", key);
    expect(a).not.toContain("hunter2");
    expect(a).not.toBe(b);
    expect(unseal(a, key)).toBe("hunter2-app-password");
    expect(unseal(a, Buffer.from("cd".repeat(32), "hex"))).toBeNull();
    expect(unseal(a.slice(0, -4) + "AAAA", key)).toBeNull();
    expect(unseal("not sealed", key)).toBeNull();
  });
  it("needs a 32-byte SECRETS_KEY, as hex or base64", () => {
    expect(secretKey({ SECRETS_KEY: KEY } as never)).toHaveLength(32);
    expect(secretKey({ SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") } as never)).toHaveLength(32);
    expect(secretKey({ SECRETS_KEY: "short" } as never)).toBeNull();
    expect(secretKey({} as never)).toBeNull();
  });
});

describe("reading the alert mailbox over IMAP", () => {
  it("turns a real email into what the matcher reads, with the receiving server's verdict", async () => {
    const a = await rawToAlert(RAW(), "m1");
    expect(a.from).toContain("ibanking.alert@dbs.com");
    expect(authenticated(a.authResults)).toBe(true);
    expect(parseAlert(a)).toMatchObject({ bankRef: "TXN000000001", amountCents: 2450, accountEnding: "1234", payerName: "LIM MEI LING" });
    expect(authenticated((await rawToAlert(RAW({ auth: "dmarc=fail" }), "m2")).authResults)).toBe(false);
  });
  it("fetches only mail from the bank's sender, newest fifty, and always logs out", async () => {
    const calls: string[] = [];
    const factory: ImapFactory = () => ({
      connect: async () => void calls.push("connect"),
      getMailboxLock: async () => ({ release: () => void calls.push("release") }),
      search: async (q) => { calls.push(`search ${q.from}`); return [7, 8]; },
      fetch: async function* () { yield { uid: 7, source: RAW({ ref: "TXN000000007" }) }; yield { uid: 8, source: RAW({ ref: "TXN000000008" }) }; },
      logout: async () => void calls.push("logout"),
    });
    const mails = await new ImapMailbox({ host: "imap.example.com", port: 993, user: "shop@example.com", pass: "x" }, factory).fetch({ sender: "ibanking.alert@dbs.com", afterMs: Date.now() - 1000 });
    expect(mails.map((m) => m.id)).toEqual(["imap:shop@example.com:7", "imap:shop@example.com:8"]);
    expect(calls).toEqual(["connect", "search ibanking.alert@dbs.com", "release", "logout"]);
  });
});

describe("where the server may connect", () => {
  it("only real public mail servers", () => {
    expect(hostProblem("imap.gmail.com")).toBeNull();
    for (const bad of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.9", "172.20.1.1", "169.254.169.254", "mailserver", "db.internal", "a b.com", ""]) expect(hostProblem(bad), bad).not.toBeNull();
  });
  it("explains a failed connection without echoing what the server said", () => {
    expect(plainProblem(new Error("Invalid credentials (Failure) pass=hunter2"))).toContain("username or password");
    expect(plainProblem(Object.assign(new Error("Command failed"), { authenticationFailed: true }))).toContain("username or password");
    expect(plainProblem(new Error("getaddrinfo ENOTFOUND imap.nowhere.test"))).toContain("Could not find");
    expect(plainProblem(new Error("hunter2 exploded"))).not.toContain("hunter2");
  });
});

describe("PayNow per outlet, and the shop's own mailboxes", () => {
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let mgr = "";
  let till = "";
  let ip = 0;
  let imapOk = true;
  const factory: ImapFactory = () => ({
    connect: async () => { if (!imapOk) throw Object.assign(new Error("Invalid credentials (Failure)"), { authenticationFailed: true }); },
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [1],
    fetch: async function* () { yield { uid: 1, source: RAW() }; },
    logout: async () => undefined,
  });
  const call = async (url: string, o: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(base + url, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, "x-device-token": till, authorization: `Bearer ${mgr}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  beforeAll(async () => {
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true, imapFactory: factory });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    till = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
    await createStaff(db, { merchantId: "bp", code: "M1", name: "Max Manager", role: "owner", pin: "222222" });
    mgr = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    await upsertOutlet(db, "bp", { id: "B2", name: "Second shop", franchiseId: null, address: null, phone: null, hours: null, active: true, serviceMode: null, prepMinutes: null, latitude: null, longitude: null } as never);
    await savePaynow(db, "bp", { proxyType: "uen", proxyValue: "201912345K", displayName: "BAILEY AND PATCH", outletCode: "B1", ttlMinutes: 3, receivingAccountEnding: "1111", alertSender: "ibanking.alert@dbs.com" });
  }, 120_000);
  afterAll(async () => { process.env.SECRETS_KEY = ""; await app?.close(); await stop?.(); });

  it("will not keep a mailbox password until the server has a key", async () => {
    delete process.env.SECRETS_KEY;
    await expect(addMailbox(db, "bp", { label: "Alerts", host: "imap.example.com", username: "shop@example.com", password: "hunter2" })).rejects.toThrow(/SECRETS_KEY/);
    expect((await db.query("SELECT 1 FROM mailboxes")).rowCount).toBe(0);
  });

  let boxId = "";
  it("is set up by us: sealed, host checked, and a merchant cannot add, change or remove one", async () => {
    process.env.SECRETS_KEY = KEY;
    await expect(addMailbox(db, "bp", { label: "Alerts", host: "127.0.0.1", username: "a@b.com", password: "x" })).rejects.toThrow(/public mail server/);
    await expect(addMailbox(db, "bp", { label: "Alerts", host: "imap.example.com", port: 25, username: "a@b.com", password: "x" })).rejects.toThrow(/993/);
    await expect(addMailbox(db, "bp", { label: "Alerts", host: "imap.example.com", username: "a@b.com" })).rejects.toThrow(/password/);
    const m = await addMailbox(db, "bp", { label: "Alerts", host: "imap.example.com", port: 993, username: "shop@example.com", password: "hunter2-app-pass" });
    boxId = m.id;
    const stored = (await db.query("SELECT secret_enc FROM mailboxes WHERE id=$1", [boxId])).rows[0].secret_enc as string;
    expect(stored).not.toContain("hunter2");
    expect(unseal(stored, Buffer.from(KEY, "hex"))).toBe("hunter2-app-pass");
    // what a merchant sees: the address to send alerts to and whether it works, never a password
    const list = await call("/api/settings/mailboxes");
    expect(list.text).not.toContain("hunter2");
    expect(list.json.mailboxes).toHaveLength(1);
    expect(list.json.mailboxes[0]).toMatchObject({ label: "Alerts", username: "shop@example.com" });
    // and nothing in the API lets them put their own mailbox in
    expect((await call("/api/settings/mailboxes", { body: { label: "Mine", kind: "imap", host: "imap.example.com", port: 993, username: "me@example.com", password: "my-own-password" } })).status).toBe(404);
    expect((await call(`/api/settings/mailboxes/${boxId}`, { method: "PUT", body: { password: "x" } })).status).toBe(404);
    expect((await call(`/api/settings/mailboxes/${boxId}`, { method: "DELETE" })).status).toBe(404);
    expect((await db.query("SELECT 1 FROM mailboxes")).rowCount).toBe(1);
  });

  it("tests the connection and says plainly when it fails", async () => {
    imapOk = true;
    expect((await call(`/api/settings/mailboxes/${boxId}/test`, { body: {} })).json).toMatchObject({ ok: true, found: 1 });
    imapOk = false;
    const bad = (await call(`/api/settings/mailboxes/${boxId}/test`, { body: {} })).json;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("username or password");
    expect((await call("/api/settings/mailboxes")).json.mailboxes[0].lastError).toContain("username or password");
    imapOk = true;
  });

  it("gives an outlet its own PayNow setup, with its own outlet code, and refuses a repeat", async () => {
    expect((await call("/api/settings/paynow?outlet=B2", { method: "PUT", body: { receivingAccountEnding: "2222" } })).status).toBe(400); // no outlet code of its own
    const ok = await call("/api/settings/paynow?outlet=B2", { method: "PUT", body: { outletCode: "B2", receivingAccountEnding: "2222", proxyValue: "201988888Z", displayName: "SECOND SHOP", mailboxId: boxId } });
    expect(ok.status).toBe(200);
    expect(ok.json.config).toMatchObject({ outletCode: "B2", receivingAccountEnding: "2222", proxyValue: "201988888Z", alertSender: "ibanking.alert@dbs.com" });
    expect((await call("/api/settings/paynow?outlet=B2", { method: "PUT", body: { outletCode: "B1" } })).status).toBe(400); // the shop's code
    expect((await loadPaynow(db, "bp", {} as never, "B2"))?.displayName).toBe("SECOND SHOP");
    expect((await loadPaynow(db, "bp", {} as never, "EV"))?.displayName).toBe("BAILEY AND PATCH"); // an outlet with no setup of its own uses the shop's
    expect((await call("/api/settings/paynow")).json.overrides.B2).toMatchObject({ outletCode: "B2" });
    expect((await call("/api/settings/paynow?outlet=nope", { method: "PUT", body: { outletCode: "ZZ" } })).status).toBe(404);
    expect(await removeMailbox(db, "bp", boxId)).toBe(true); // removing a mailbox leaves the setups; they simply have none to read
    expect((await allPaynowConfigs(db, "bp", {} as never)).map((c) => c.outletId)).toEqual([null, "B2"]);
  });

  it("an alert claims only a QR issued under the account it landed in, and reads each mailbox once", async () => {
    const a = (await loadPaynow(db, "bp", {} as never, null))!;
    const b = (await loadPaynow(db, "bp", {} as never, "B2"))!;
    const t = Date.now();
    // the same amount, asked at both outlets: the shop's first (earlier), then the second shop's
    const q1 = await issueQr(db, a, { merchantId: "bp", orderId: "o-shop1", amountCents: 500, channel: "P", now: t });
    const q2 = await issueQr(db, b, { merchantId: "bp", orderId: "o-shop2", amountCents: 500, channel: "P", now: t + 1000 });
    expect(q2.payload).toContain("201988888Z");
    expect(q2.reference.slice(3, 5)).toBe("B2");
    expect(q1.reference.slice(3, 5)).toBe("B1");
    const applied: string[] = [];
    const apply = async (o: { orderId: string }) => { applied.push(o.orderId); return true; };
    // build alerts with the right sent time
    const mk = async (ending: string, ref: string) => rawToAlert(Buffer.from(RAW({ ending, ref, cents: 500 }).toString().replace("Mon, 23 Nov 2026 04:05:06 +0000", new Date(t + 5000).toUTCString())), ref);
    expect(await processAlertFor(db, "bp", [a, b], await mk("2222", "TXN000000022"), apply)).toBe("claimed");
    expect(applied).toEqual(["o-shop2"]); // not the earlier QR at the other account
    expect(await processAlertFor(db, "bp", [a, b], await mk("9999", "TXN000000099"), apply)).toBe("other_account");
    expect(await processAlertFor(db, "bp", [a, b], await mk("1111", "TXN000000011"), apply)).toBe("claimed");
    expect(applied).toEqual(["o-shop2", "o-shop1"]);
    expect(await processAlertFor(db, "bp", [a, b], await mk("1111", "TXN000000011"), apply)).toBe("duplicate");
  });

  it("groups setups by the mailbox they read", async () => {
    process.env.SECRETS_KEY = KEY;
    const made = (await addMailbox(db, "bp", { label: "Second", host: "imap.example.com", port: 993, username: "two@example.com", password: "pw-two" })).id;
    await savePaynowOverride(db, "bp", "B2", { outletCode: "B2", receivingAccountEnding: "2222", mailboxId: made });
    const fake = { fetch: async () => [] };
    const targets: WatchTarget[] = await watchTargets(db, "bp", { defaultMailbox: fake, imapFactory: factory })();
    expect(targets.map((x) => `${x.key === "default" ? "default" : "saved"}:${x.configs.map((c) => c.outletCode).join("+")}`).sort()).toEqual(["default:B1", "saved:B2"]);
    await savePaynowOverride(db, "bp", "B2", null);
    expect((await watchTargets(db, "bp", { defaultMailbox: fake, imapFactory: factory })()).map((x) => x.configs.length)).toEqual([1]);
  });
});
