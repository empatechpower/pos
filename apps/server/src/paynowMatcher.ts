import type { Db } from "./db/pool.js";
import { authenticated, parseAlert, type RawAlert } from "./paynowAlert.js";
import type { PaynowConfig } from "./paynowQr.js";

/** Where bank alerts come from. Gmail in production, a plain list in tests. */
export interface AlertMailbox {
  fetch(o: { sender: string; afterMs: number }): Promise<RawAlert[]>;
}

/** Records the payment against the order. False when it cannot be applied (order gone, already paid, cancelled, or the amount is no longer what is owed). */
export type ApplyPayment = (o: { orderId: string; amountCents: number; paymentId: string; payer: string }) => Promise<boolean>;

export type AlertOutcome = "claimed" | "unassigned" | "duplicate" | "unauthenticated" | "unparsed" | "wrong_sender" | "other_account";

/**
 * One alert through the rules: sender, authentication, parse, dedupe, claim.
 * The earliest-issued live QR with the same amount (and account) wins; nothing live means the unassigned pool, never a guess.
 * A forged or unreadable email is never stored, so it cannot use up a real bank reference.
 */
export async function processAlert(db: Db, merchantId: string, cfg: PaynowConfig, raw: RawAlert, apply: ApplyPayment): Promise<AlertOutcome> {
  if (cfg.alertSender && !raw.from.toLowerCase().includes(cfg.alertSender)) return "wrong_sender";
  if (!authenticated(raw.authResults)) { console.error(`[paynow] alert ${raw.id} failed DKIM/SPF/DMARC; ignored`); return "unauthenticated"; }
  const a = parseAlert(raw);
  if (!a) return "unparsed";
  const ins = await db.query(
    "INSERT INTO payment_alerts (merchant_id, bank_ref, amount_cents, payer_name, account_ending, email_id, email_date, auth_results, status) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8,'UNASSIGNED') ON CONFLICT (bank_ref) DO NOTHING RETURNING bank_ref",
    [merchantId, a.bankRef, a.amountCents, a.payerName, a.accountEnding, a.emailId, a.emailDate, a.authResults],
  );
  if (!ins.rowCount) return "duplicate";
  if (cfg.receivingAccountEnding && a.accountEnding !== cfg.receivingAccountEnding) {
    await db.query("UPDATE payment_alerts SET status='RESOLVED', resolution='another account' WHERE bank_ref=$1", [a.bankRef]);
    return "other_account";
  }
  const hit = (await db.query(
    `UPDATE payment_expectations SET state='PAID', claimed_by_bank_ref=$2, payer_name=$3, alert_email_id=$4, updated_at=now()
      WHERE payment_id = (SELECT payment_id FROM payment_expectations
                           WHERE merchant_id=$1 AND state='WAITING' AND amount_cents=$5
                             AND issued_at <= to_timestamp($6/1000.0) AND expires_at >= to_timestamp($6/1000.0)
                           ORDER BY issued_at, seq LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING payment_id, order_id`,
    [merchantId, a.bankRef, a.payerName, a.emailId, a.amountCents, a.emailDate],
  )).rows[0];
  if (hit && (await apply({ orderId: hit.order_id, amountCents: a.amountCents, paymentId: `paynow:${a.bankRef}`, payer: a.payerName }))) {
    await db.query("UPDATE payment_alerts SET status='CLAIMED', claimed_payment_id=$2 WHERE bank_ref=$1", [a.bankRef, hit.payment_id]);
    return "claimed";
  }
  if (hit) {
    // The order could not take it (already paid elsewhere, cancelled, changed). Let the QR go and send the money to staff.
    await db.query("UPDATE payment_expectations SET state='WAITING', claimed_by_bank_ref=NULL, payer_name=NULL, alert_email_id=NULL, updated_at=now() WHERE payment_id=$1", [hit.payment_id]);
    await db.query("UPDATE payment_alerts SET resolution='the order could not take it' WHERE bank_ref=$1", [a.bankRef]);
  }
  return "unassigned";
}

export interface PoolRow { bankRef: string; amountCents: number; payerName: string; emailDate: number; note: string | null }

/** Money that arrived with no live QR to match: staff assign it to an order or settle it another way. */
export async function listUnassigned(db: Db, merchantId: string): Promise<PoolRow[]> {
  const r = await db.query("SELECT bank_ref, amount_cents, payer_name, extract(epoch from email_date)*1000 AS ts, resolution FROM payment_alerts WHERE merchant_id=$1 AND status='UNASSIGNED' ORDER BY email_date", [merchantId]);
  return r.rows.map((x) => ({ bankRef: x.bank_ref, amountCents: x.amount_cents, payerName: x.payer_name ?? "", emailDate: Number(x.ts), note: x.resolution ?? null }));
}

/** Staff put an unassigned payment on an order. The order must be able to take exactly that amount. */
export async function assignUnassigned(db: Db, merchantId: string, bankRef: string, orderId: string, apply: ApplyPayment): Promise<"ok" | "not_found" | "not_applicable"> {
  const a = (await db.query("SELECT amount_cents, payer_name FROM payment_alerts WHERE merchant_id=$1 AND bank_ref=$2 AND status='UNASSIGNED' FOR UPDATE", [merchantId, bankRef])).rows[0];
  if (!a) return "not_found";
  if (!(await apply({ orderId, amountCents: a.amount_cents, paymentId: `paynow:${bankRef}`, payer: a.payer_name ?? "" }))) return "not_applicable";
  await db.query("UPDATE payment_alerts SET status='RESOLVED', resolution=$3 WHERE merchant_id=$1 AND bank_ref=$2", [merchantId, bankRef, `assigned to order ${orderId}`]);
  await db.query("UPDATE payment_expectations SET state='PAID', claimed_by_bank_ref=$3, updated_at=now() WHERE merchant_id=$1 AND order_id=$2 AND state='WAITING'", [merchantId, orderId, bankRef]);
  return "ok";
}

/** Staff settled it another way (refunded it, or it was not for us). */
export async function dismissUnassigned(db: Db, merchantId: string, bankRef: string, note: string): Promise<boolean> {
  const r = await db.query("UPDATE payment_alerts SET status='RESOLVED', resolution=$3 WHERE merchant_id=$1 AND bank_ref=$2 AND status='UNASSIGNED'", [merchantId, bankRef, note.slice(0, 200) || "dismissed"]);
  return !!r.rowCount;
}

/**
 * Watches the mailbox: every few seconds while any QR is live (or just expired, to allow for the bank's delay), once a minute otherwise.
 * Each look reaches back a little before the last one, so a gap in watching never loses an alert; the bank reference makes repeats harmless.
 */
export function startAlertWatch(o: { db: Db; merchantId: string; mailbox: AlertMailbox; load: () => Promise<PaynowConfig | null>; apply: ApplyPayment; now: () => number; liveMs?: number; idleMs?: number }): () => void {
  const liveMs = o.liveMs ?? 5_000;
  const idleMs = o.idleMs ?? 60_000;
  let stopped = false;
  let busy = false;
  let lastLook = 0;
  let lastCheck = 0;
  const seen = new Set<string>();
  const look = async () => {
    const cfg = await o.load();
    if (!cfg?.alertSender) return;
    const now = o.now();
    const live = (await o.db.query("SELECT 1 FROM payment_expectations WHERE merchant_id=$1 AND state='WAITING' AND expires_at > to_timestamp($2/1000.0) LIMIT 1", [o.merchantId, now - 2 * 60_000])).rowCount;
    if (!live && now - lastCheck < idleMs) return;
    lastCheck = now;
    const after = lastLook ? lastLook - 2 * 60_000 : now - 24 * 3_600_000;
    const mails = await o.mailbox.fetch({ sender: cfg.alertSender, afterMs: after });
    lastLook = now;
    for (const m of mails.sort((x, y) => Date.parse(x.date) - Date.parse(y.date))) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      await processAlert(o.db, o.merchantId, cfg, m, o.apply);
    }
  };
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    look().catch((e) => console.error("[paynow] mailbox look failed:", e?.message ?? e)).finally(() => { busy = false; });
  }, liveMs);
  return () => { stopped = true; clearInterval(timer); };
}

/** A mailbox that holds what it is given. For tests and for trying the screens with no bank. */
export class MemoryMailbox implements AlertMailbox {
  messages: RawAlert[] = [];
  async fetch(): Promise<RawAlert[]> { return [...this.messages]; }
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const strip = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

type GPart = { mimeType?: string; body?: { data?: string }; parts?: GPart[] };
function gmailText(p: GPart): string {
  if (p.mimeType === "text/plain" && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) { const t = gmailText(c); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return strip(b64(p.body.data));
  return "";
}

/** Reads the shop's alert mailbox over Gmail's API. The refresh token lives only on the server. Not yet tried against a real mailbox. */
export class GmailMailbox implements AlertMailbox {
  private token: { value: string; until: number } | null = null;
  constructor(private cred: { clientId: string; clientSecret: string; refreshToken: string }, private doFetch: typeof fetch = fetch) {}

  private async access(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 30_000) return this.token.value;
    const r = await this.doFetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.cred.clientId, client_secret: this.cred.clientSecret, refresh_token: this.cred.refreshToken, grant_type: "refresh_token" }) });
    if (!r.ok) throw new Error(`google sign-in refused (${r.status})`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, until: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async fetch(o: { sender: string; afterMs: number }): Promise<RawAlert[]> {
    const t = await this.access();
    const get = async (path: string) => {
      const r = await this.doFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(`gmail refused (${r.status})`);
      return r.json() as Promise<any>;
    };
    const q = encodeURIComponent(`from:${o.sender} after:${Math.floor(o.afterMs / 1000)}`);
    const list = (await get(`messages?q=${q}&maxResults=50`)).messages as { id: string }[] | undefined;
    const out: RawAlert[] = [];
    for (const m of list ?? []) {
      const full = await get(`messages/${m.id}?format=full`);
      const hs = (full.payload?.headers ?? []) as { name: string; value: string }[];
      const h = (n: string) => hs.filter((x) => x.name.toLowerCase() === n).map((x) => x.value);
      out.push({ id: m.id, from: h("from")[0] ?? "", subject: h("subject")[0] ?? "", date: h("date")[0] ?? "", authResults: h("authentication-results").join(" ; "), body: gmailText(full.payload ?? {}) });
    }
    return out;
  }
}
