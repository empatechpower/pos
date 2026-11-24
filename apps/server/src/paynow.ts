import { randomUUID } from "node:crypto";
import type { Db } from "./db/pool.js";
import { base36, buildPayload, buildReference, cleanPaynowConfig, issueDate, type PaynowChannel, type PaynowConfig } from "./paynowQr.js";

/** The amount asked for is outside what the shop allows for a PayNow QR. */
export class AmountNotAllowed extends Error { constructor(public readonly minCents?: number, public readonly maxCents?: number) { super("amount_not_allowed"); } }

const BASE_KEY = "paynow";
const OUTLETS_KEY = "paynow_outlets";
type Raw = Record<string, unknown>;

const baseRaw = async (db: Db | null, merchantId: string, env: NodeJS.ProcessEnv): Promise<Raw | null> => {
  const row = db ? (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key=$2", [merchantId, BASE_KEY])).rows[0] : undefined;
  return (row?.value as Raw | undefined) ?? (env.PAYNOW_PROXY_VALUE ? { proxyType: env.PAYNOW_PROXY_TYPE ?? "uen", proxyValue: env.PAYNOW_PROXY_VALUE, displayName: env.PAYNOW_NAME ?? "", outletCode: env.PAYNOW_OUTLET_CODE ?? "01", ttlMinutes: Number(env.PAYNOW_TTL_MINUTES) || 2 } : null);
};

/** What each outlet changes from the shop's PayNow settings (its own account, outlet code, mailbox...). Outlets not listed use the shop's. */
export async function loadPaynowOverrides(db: Db | null, merchantId: string): Promise<Record<string, Raw>> {
  if (!db) return {};
  const row = (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key=$2", [merchantId, OUTLETS_KEY])).rows[0];
  return (row?.value as Record<string, Raw> | undefined) ?? {};
}

/**
 * The PayNow settings in force: the shop's saved ones, else the environment (PAYNOW_PROXY_TYPE, PAYNOW_PROXY_VALUE, PAYNOW_NAME, PAYNOW_OUTLET_CODE).
 * For an outlet that has its own, those take the place of the shop's, field by field. Null when direct PayNow is not set up.
 */
export async function loadPaynow(db: Db | null, merchantId: string, env: NodeJS.ProcessEnv = process.env, outletId?: string | null): Promise<PaynowConfig | null> {
  const base = await baseRaw(db, merchantId, env);
  if (!base) return null;
  const over = outletId ? (await loadPaynowOverrides(db, merchantId))[outletId] : undefined;
  const c = cleanPaynowConfig(over ? { ...base, ...over } : base);
  return c.ok ? c.config : null;
}

/** Every setup in force: the shop's, and one for each outlet that has its own. */
export async function allPaynowConfigs(db: Db | null, merchantId: string, env: NodeJS.ProcessEnv = process.env): Promise<Array<{ outletId: string | null; config: PaynowConfig }>> {
  const base = await baseRaw(db, merchantId, env);
  if (!base) return [];
  const out: Array<{ outletId: string | null; config: PaynowConfig }> = [];
  const b = cleanPaynowConfig(base);
  if (b.ok) out.push({ outletId: null, config: b.config });
  for (const [outletId, over] of Object.entries(await loadPaynowOverrides(db, merchantId))) {
    const c = cleanPaynowConfig({ ...base, ...over });
    if (c.ok) out.push({ outletId, config: c.config });
  }
  return out;
}

export async function savePaynow(db: Db, merchantId: string, raw: unknown): Promise<{ ok: true; config: PaynowConfig } | { ok: false; error: string }> {
  const c = cleanPaynowConfig(raw);
  if (!c.ok) return c;
  await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, BASE_KEY, JSON.stringify(c.config)]);
  return c;
}

const FIELDS = ["proxyType", "proxyValue", "displayName", "outletCode", "ttlMinutes", "receivingAccountEnding", "alertSender", "mailboxId", "minCents", "maxCents"];

/**
 * Save what one outlet changes (only the fields given), or with null take its own settings away. The result must be a complete, valid setup,
 * and its outlet code must not be one another outlet or the shop already uses (the code is how a payment is traced on the bank statement).
 */
export async function savePaynowOverride(db: Db, merchantId: string, outletId: string, raw: Raw | null, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; config: PaynowConfig | null } | { ok: false; error: string }> {
  const base = await baseRaw(db, merchantId, env);
  if (!base) return { ok: false, error: "Set up the shop's PayNow first; an outlet only changes parts of it." };
  const all = await loadPaynowOverrides(db, merchantId);
  if (raw === null) delete all[outletId];
  else {
    const mine: Raw = Object.fromEntries(FIELDS.filter((f) => raw[f] !== undefined && raw[f] !== "").map((f) => [f, raw[f]]));
    if (!Object.keys(mine).length) return { ok: false, error: "Nothing to change for this outlet." };
    all[outletId] = mine;
  }
  const merged = raw === null ? null : cleanPaynowConfig({ ...base, ...all[outletId] });
  if (merged && !merged.ok) return merged;
  if (merged?.ok) {
    // An outlet with a setup of its own names itself in the reference: its own two-character code, different from every other.
    if (all[outletId]!.outletCode === undefined) return { ok: false, error: "Give this outlet its own outlet code (two letters or digits)." };
    const used = [cleanPaynowConfig(base), ...Object.entries(all).filter(([id]) => id !== outletId).map(([, o]) => cleanPaynowConfig({ ...base, ...o }))];
    if (used.some((o) => o.ok && o.config.outletCode === merged.config.outletCode)) return { ok: false, error: "Another outlet already uses that outlet code. Each outlet needs its own, so a payment can be traced on the bank statement." };
  }
  await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, OUTLETS_KEY, JSON.stringify(all)]);
  return { ok: true, config: merged?.ok ? merged.config : null };
}

export interface IssuedQr { paymentId: string; reference: string; payload: string; issuedAt: number; expiresAt: number }

/**
 * Issue a new QR for an order: a fresh reference, a stored expectation that lives for the configured minutes, and the payload.
 * Any earlier live QR for the same order is superseded (a payment against it will later land in the unassigned pool, never auto-claim).
 */
export async function issueQr(db: Db, cfg: PaynowConfig, o: { merchantId: string; orderId: string; amountCents: number; channel: PaynowChannel; now: number; skipLimits?: boolean }): Promise<IssuedQr> {
  if (!o.skipLimits && ((cfg.minCents && o.amountCents < cfg.minCents) || (cfg.maxCents && o.amountCents > cfg.maxCents))) throw new AmountNotAllowed(cfg.minCents, cfg.maxCents);
  const paymentId = randomUUID();
  const issuedAt = o.now;
  const expiresAt = issuedAt + cfg.ttlMinutes * 60_000;
  await db.query("UPDATE payment_expectations SET state='EXPIRED', updated_at=now() WHERE merchant_id=$1 AND order_id=$2 AND state='WAITING'", [o.merchantId, o.orderId]);
  // The sequence number comes from the table itself, so two QRs issued together never share a reference.
  const seq = Number((await db.query("SELECT nextval(pg_get_serial_sequence('payment_expectations','seq')) AS n")).rows[0].n);
  const reference = buildReference({ channel: o.channel, outletCode: cfg.outletCode, seq, amountCents: o.amountCents });
  // The amount inside the reference must be the amount in the QR; if not, the QR was mis-generated, so never hand it out.
  if (reference.slice(14, 19) !== base36(o.amountCents, 5)) throw new Error("reference amount does not match the QR amount");
  const payload = buildPayload({ config: cfg, amountCents: o.amountCents, reference, expiryDate: issueDate(issuedAt) });
  await db.query(
    "INSERT INTO payment_expectations (payment_id, seq, merchant_id, order_id, reference, outlet_code, channel, amount_cents, proxy_value, issued_at, expires_at, receiving_account_ending) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0),to_timestamp($11/1000.0),$12)",
    [paymentId, seq, o.merchantId, o.orderId, reference, cfg.outletCode, o.channel, o.amountCents, cfg.proxyValue, issuedAt, expiresAt, cfg.receivingAccountEnding ?? null],
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
