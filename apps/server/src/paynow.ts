import { randomUUID } from "node:crypto";
import type { Db } from "./db/pool.js";
import { buildPayload, buildReference, cleanPaynowConfig, issueDate, type PaynowChannel, type PaynowConfig } from "./paynowQr.js";

/** The shop's PayNow settings: the owner's saved ones, else the environment (PAYNOW_PROXY_TYPE, PAYNOW_PROXY_VALUE, PAYNOW_NAME, PAYNOW_OUTLET_CODE). Null when direct PayNow is not set up. */
export async function loadPaynow(db: Db | null, merchantId: string, env: NodeJS.ProcessEnv = process.env): Promise<PaynowConfig | null> {
  const row = db ? (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='paynow'", [merchantId])).rows[0] : undefined;
  const raw = row?.value ?? (env.PAYNOW_PROXY_VALUE ? { proxyType: env.PAYNOW_PROXY_TYPE ?? "uen", proxyValue: env.PAYNOW_PROXY_VALUE, displayName: env.PAYNOW_NAME ?? "", outletCode: env.PAYNOW_OUTLET_CODE ?? "01", ttlMinutes: Number(env.PAYNOW_TTL_MINUTES) || 3 } : null);
  if (!raw) return null;
  const c = cleanPaynowConfig(raw);
  return c.ok ? c.config : null;
}

export async function savePaynow(db: Db, merchantId: string, raw: unknown): Promise<{ ok: true; config: PaynowConfig } | { ok: false; error: string }> {
  const c = cleanPaynowConfig(raw);
  if (!c.ok) return c;
  await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'paynow',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(c.config)]);
  return c;
}

export interface IssuedQr { paymentId: string; reference: string; payload: string; issuedAt: number; expiresAt: number }

/**
 * Issue a new QR for an order: a fresh reference, a stored expectation that lives for the configured minutes, and the payload.
 * Any earlier live QR for the same order is superseded (a payment against it will later land in the unassigned pool, never auto-claim).
 */
export async function issueQr(db: Db, cfg: PaynowConfig, o: { merchantId: string; orderId: string; amountCents: number; channel: PaynowChannel; now: number }): Promise<IssuedQr> {
  const paymentId = randomUUID();
  const issuedAt = o.now;
  const expiresAt = issuedAt + cfg.ttlMinutes * 60_000;
  await db.query("UPDATE payment_expectations SET state='EXPIRED', updated_at=now() WHERE merchant_id=$1 AND order_id=$2 AND state='WAITING'", [o.merchantId, o.orderId]);
  // The sequence number comes from the table itself, so two QRs issued together never share a reference.
  const seq = Number((await db.query("SELECT nextval(pg_get_serial_sequence('payment_expectations','seq')) AS n")).rows[0].n);
  const reference = buildReference({ channel: o.channel, outletCode: cfg.outletCode, seq, amountCents: o.amountCents });
  const payload = buildPayload({ config: cfg, amountCents: o.amountCents, reference, expiryDate: issueDate(issuedAt) });
  await db.query(
    "INSERT INTO payment_expectations (payment_id, seq, merchant_id, order_id, reference, outlet_code, channel, amount_cents, proxy_value, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0),to_timestamp($11/1000.0))",
    [paymentId, seq, o.merchantId, o.orderId, reference, cfg.outletCode, o.channel, o.amountCents, cfg.proxyValue, issuedAt, expiresAt],
  );
  return { paymentId, reference, payload, issuedAt, expiresAt };
}

export type PaynowState = "WAITING" | "PAID" | "NOT_FOUND" | "EXPIRED";

/**
 * Where one QR stands. PAID when it was claimed, or when the order itself is already paid (staff confirmed it at the till).
 * NOT_FOUND is only a display state once the minutes are up; a late payment can still be applied to an unpaid order.
 */
export async function expectationStatus(db: Db, merchantId: string, paymentId: string, orderPaid: (orderId: string) => Promise<boolean>, now: number): Promise<{ state: PaynowState; orderId: string; expiresAt: number; paidAt?: number } | null> {
  const r = (await db.query("SELECT order_id, state, extract(epoch from expires_at)*1000 AS exp, extract(epoch from updated_at)*1000 AS upd FROM payment_expectations WHERE merchant_id=$1 AND payment_id=$2", [merchantId, paymentId])).rows[0];
  if (!r) return null;
  const expiresAt = Number(r.exp);
  if (r.state === "PAID") return { state: "PAID", orderId: r.order_id, expiresAt, paidAt: Number(r.upd) };
  if (r.state === "WAITING" && (await orderPaid(r.order_id))) return { state: "PAID", orderId: r.order_id, expiresAt, paidAt: now };
  if (r.state === "EXPIRED") return { state: "EXPIRED", orderId: r.order_id, expiresAt };
  return { state: now > expiresAt ? "NOT_FOUND" : "WAITING", orderId: r.order_id, expiresAt };
}
