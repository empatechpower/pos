import type { Db } from "./db/pool.js";

export type EntryKind = "topup" | "spend" | "refund" | "adjust";

export interface LedgerEntry {
  id: string;
  walletId: string;
  kind: EntryKind;
  amountCents: number;
  balanceAfter: number;
  idempotencyKey: string;
  orderId: string | null;
}

export type LedgerResult =
  | { ok: true; entry: LedgerEntry; replayed: boolean }
  | { ok: false; reason: "insufficient_funds"; balanceCents: number };

interface PostInput {
  merchantId: string;
  customerId: string;
  /** Signed cents: positive adds credit, negative spends it. */
  amountCents: number;
  kind: EntryKind;
  /** Same key + same wallet = same entry. A retry or a duplicate sync can never post twice. */
  idempotencyKey: string;
  orderId?: string;
  outletId?: string;
  deviceId?: string;
  /** Who did it. Recorded on the entry so every money movement is attributable. */
  staffId?: string;
  note?: string;
}

const toEntry = (r: Record<string, unknown>): LedgerEntry => ({
  id: r.id as string,
  walletId: r.wallet_id as string,
  kind: r.kind as EntryKind,
  amountCents: Number(r.amount_cents),
  balanceAfter: Number(r.balance_after),
  idempotencyKey: r.idempotency_key as string,
  orderId: (r.order_id as string | null) ?? null,
});

/**
 * The only way money moves. The wallet row is locked for the length of the transaction, so two
 * simultaneous spends are applied one after the other and the second sees the first's result.
 */
async function post(db: Db, i: PostInput): Promise<LedgerResult> {
  if (!Number.isSafeInteger(i.amountCents) || i.amountCents === 0) throw new Error("amountCents must be a non-zero integer");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO wallets (merchant_id, customer_id) VALUES ($1,$2) ON CONFLICT (merchant_id, customer_id) DO NOTHING",
      [i.merchantId, i.customerId],
    );
    const w = await client.query(
      "SELECT id, balance_cents FROM wallets WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE",
      [i.merchantId, i.customerId],
    );
    const walletId = w.rows[0].id as string;
    const balance = Number(w.rows[0].balance_cents);

    const dup = await client.query("SELECT * FROM ledger_entries WHERE wallet_id=$1 AND idempotency_key=$2", [walletId, i.idempotencyKey]);
    if (dup.rowCount) {
      await client.query("COMMIT");
      return { ok: true, entry: toEntry(dup.rows[0]), replayed: true };
    }

    const after = balance + i.amountCents;
    if (after < 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient_funds", balanceCents: balance };
    }

    const ins = await client.query(
      `INSERT INTO ledger_entries (wallet_id, kind, amount_cents, balance_after, idempotency_key, order_id, outlet_id, device_id, note, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [walletId, i.kind, i.amountCents, after, i.idempotencyKey, i.orderId ?? null, i.outletId ?? null, i.deviceId ?? null, i.note ?? null, i.staffId ?? null],
    );
    await client.query("UPDATE wallets SET balance_cents=$1 WHERE id=$2", [after, walletId]);
    await client.query("COMMIT");
    return { ok: true, entry: toEntry(ins.rows[0]), replayed: false };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

type Ctx = Omit<PostInput, "amountCents" | "kind"> & { amountCents: number };

export const topUp = (db: Db, i: Ctx) => post(db, { ...i, kind: "topup", amountCents: Math.abs(i.amountCents) });
export const spend = (db: Db, i: Ctx) => post(db, { ...i, kind: "spend", amountCents: -Math.abs(i.amountCents) });
export const refund = (db: Db, i: Ctx) => post(db, { ...i, kind: "refund", amountCents: Math.abs(i.amountCents) });

export async function balanceOf(db: Db, merchantId: string, customerId: string): Promise<number> {
  const r = await db.query("SELECT balance_cents FROM wallets WHERE merchant_id=$1 AND customer_id=$2", [merchantId, customerId]);
  return r.rowCount ? Number(r.rows[0].balance_cents) : 0;
}

/** Recomputes a balance from the entries alone. Must always equal the wallet's stored balance. */
export async function rebuildBalance(db: Db, merchantId: string, customerId: string): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(e.amount_cents),0) AS s FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id
     WHERE w.merchant_id=$1 AND w.customer_id=$2`,
    [merchantId, customerId],
  );
  return Number(r.rows[0].s);
}

/**
 * A manager sets a member's credit to an exact amount. It is recorded as one adjustment entry for the difference (never an edit of
 * the balance), with the reason and who did it. The same key replays the same entry.
 */
export async function adjustTo(
  db: Db,
  i: { merchantId: string; customerId: string; targetCents: number; idempotencyKey: string; /** Null when the system does it (lapsed credit written off on the day). */ staffId: string | null; deviceId?: string; outletId?: string; note: string },
): Promise<{ ok: true; deltaCents: number; balanceCents: number; replayed: boolean; changed: boolean }> {
  if (!Number.isSafeInteger(i.targetCents) || i.targetCents < 0) throw new Error("targetCents must be a whole number of cents, zero or more");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO wallets (merchant_id, customer_id) VALUES ($1,$2) ON CONFLICT (merchant_id, customer_id) DO NOTHING", [i.merchantId, i.customerId]);
    const w = await client.query("SELECT id, balance_cents FROM wallets WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE", [i.merchantId, i.customerId]);
    const walletId = w.rows[0].id as string;
    const balance = Number(w.rows[0].balance_cents);
    const dup = await client.query("SELECT amount_cents, balance_after FROM ledger_entries WHERE wallet_id=$1 AND idempotency_key=$2", [walletId, i.idempotencyKey]);
    if (dup.rowCount) {
      await client.query("COMMIT");
      return { ok: true, deltaCents: Number(dup.rows[0].amount_cents), balanceCents: Number(dup.rows[0].balance_after), replayed: true, changed: true };
    }
    const delta = i.targetCents - balance;
    if (delta === 0) {
      await client.query("COMMIT");
      return { ok: true, deltaCents: 0, balanceCents: balance, replayed: false, changed: false };
    }
    await client.query(
      `INSERT INTO ledger_entries (wallet_id, kind, amount_cents, balance_after, idempotency_key, outlet_id, device_id, note, staff_id) VALUES ($1,'adjust',$2,$3,$4,$5,$6,$7,$8)`,
      [walletId, delta, i.targetCents, i.idempotencyKey, i.outletId ?? null, i.deviceId ?? null, i.note, i.staffId],
    );
    await client.query("UPDATE wallets SET balance_cents=$1 WHERE id=$2", [i.targetCents, walletId]);
    await client.query("COMMIT");
    return { ok: true, deltaCents: delta, balanceCents: i.targetCents, replayed: false, changed: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The freeze switch: while on, member credit cannot be spent. Balances, top-ups and refunds still work. */
export async function creditFrozen(db: Db, merchantId: string): Promise<boolean> {
  const r = await db.query("SELECT credit_frozen FROM shop_settings WHERE merchant_id=$1", [merchantId]);
  return r.rows[0]?.credit_frozen === true;
}

export async function setCreditFrozen(db: Db, merchantId: string, frozen: boolean): Promise<void> {
  await db.query(
    "INSERT INTO shop_settings (merchant_id, credit_frozen) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET credit_frozen=EXCLUDED.credit_frozen",
    [merchantId, frozen],
  );
}

/** Members allowed to spend while the freeze is on. */
export async function creditExemptIds(db: Db, merchantId: string): Promise<string[]> {
  const r = await db.query("SELECT member_id FROM credit_freeze_exempt WHERE merchant_id=$1", [merchantId]);
  return r.rows.map((x) => x.member_id as string);
}

export async function setCreditExempt(db: Db, merchantId: string, memberId: string, exempt: boolean): Promise<void> {
  if (exempt) await db.query("INSERT INTO credit_freeze_exempt (merchant_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [merchantId, memberId]);
  else await db.query("DELETE FROM credit_freeze_exempt WHERE merchant_id=$1 AND member_id=$2", [merchantId, memberId]);
}

/** True when this member's credit cannot be spent right now: the freeze is on and they are not on the allowed list. */
export async function creditBlockedFor(db: Db, merchantId: string, memberId: string): Promise<boolean> {
  if (!(await creditFrozen(db, merchantId))) return false;
  const r = await db.query("SELECT 1 FROM credit_freeze_exempt WHERE merchant_id=$1 AND member_id=$2", [merchantId, memberId]);
  return !r.rowCount;
}

// ---- how long credit lasts (owner's rules, 25 Nov 2026) ---------------------------------------------------------------------------------

/**
 * Credit is valid for a time counted from the LAST top-up (a year unless the shop says otherwise). After that it is expired: it cannot be
 * spent, but a top-up within the reinstatement time (three months) brings the whole balance back with a fresh validity. Past that, it has
 * lapsed: it is written off the next time the wallet is topped up. A top-up must be at least the shop's minimum (S$10). All three are the
 * shop's settings; 0 days of validity means credit never expires.
 */
export interface CreditRules { validityDays: number; reinstateDays: number; minTopupCents: number }
export const DEFAULT_CREDIT_RULES: CreditRules = { validityDays: 365, reinstateDays: 90, minTopupCents: 1000 };
const DAY = 86_400_000;

export function cleanCreditRules(v: unknown, base: CreditRules = DEFAULT_CREDIT_RULES): CreditRules | null {
  const o = (v ?? {}) as Partial<Record<keyof CreditRules, unknown>>;
  const int = (x: unknown, d: number, max: number): number | null => (x === undefined ? d : Number.isInteger(x) && (x as number) >= 0 && (x as number) <= max ? (x as number) : null);
  const validityDays = int(o.validityDays, base.validityDays, 3660), reinstateDays = int(o.reinstateDays, base.reinstateDays, 730), minTopupCents = int(o.minTopupCents, base.minTopupCents, 1_000_000);
  return validityDays === null || reinstateDays === null || minTopupCents === null ? null : { validityDays, reinstateDays, minTopupCents };
}
export async function loadCreditRules(db: Db, merchantId: string): Promise<CreditRules> {
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='credit'", [merchantId]);
  return cleanCreditRules(r.rows[0]?.value) ?? DEFAULT_CREDIT_RULES;
}
export async function saveCreditRules(db: Db, merchantId: string, rules: CreditRules): Promise<void> {
  await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'credit',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(rules)]);
}

export type CreditStatus = "none" | "active" | "expired" | "lapsed";
export interface CreditState { state: CreditStatus; balanceCents: number; lastTopupAt: number | null; /** The last day the credit can be spent. */ expiresAt: number | null; /** The last day a top-up brings expired credit back. */ reinstateBy: number | null }

/** Where one wallet stands under the shop's rules. The clock starts at its last top-up (or, for credit only ever given by hand, the last time credit was added). */
export async function creditState(db: Db, merchantId: string, customerId: string, now = Date.now(), rules?: CreditRules): Promise<CreditState> {
  const r = rules ?? (await loadCreditRules(db, merchantId));
  const w = await db.query(
    `SELECT w.balance_cents, (SELECT max(e.created_at) FROM ledger_entries e WHERE e.wallet_id=w.id AND e.kind='topup') AS last_topup,
            (SELECT max(e.created_at) FROM ledger_entries e WHERE e.wallet_id=w.id AND e.amount_cents > 0 AND e.kind <> 'refund') AS last_added
       FROM wallets w WHERE w.merchant_id=$1 AND w.customer_id=$2`, [merchantId, customerId]);
  const row = w.rows[0];
  const balanceCents = row ? Number(row.balance_cents) : 0;
  const from = row?.last_topup ?? row?.last_added ?? null;
  if (!row || !from) return { state: balanceCents > 0 ? "active" : "none", balanceCents, lastTopupAt: null, expiresAt: null, reinstateBy: null };
  const lastTopupAt = new Date(from).getTime();
  if (r.validityDays === 0) return { state: "active", balanceCents, lastTopupAt, expiresAt: null, reinstateBy: null };
  const expiresAt = lastTopupAt + r.validityDays * DAY, reinstateBy = expiresAt + r.reinstateDays * DAY;
  return { state: now <= expiresAt ? "active" : now <= reinstateBy ? "expired" : "lapsed", balanceCents, lastTopupAt, expiresAt, reinstateBy };
}
/** May this wallet's credit be spent right now under the validity rules? (The freeze is a separate check.) */
export async function creditSpendable(db: Db, merchantId: string, customerId: string, now = Date.now()): Promise<boolean> {
  const s = await creditState(db, merchantId, customerId, now);
  return s.state === "active" || s.state === "none";
}
/**
 * Before a top-up: credit that lapsed (expired and not reinstated in time) is written off, so the new money starts a clean balance.
 * Credit that is only expired is left alone: the top-up itself reinstates it. Returns the cents written off.
 */
/**
 * Every wallet whose credit lapsed (expired, and the reinstatement time passed without a top-up) is written off, on the day it lapses rather
 * than at the member's next top-up. Run by the server every hour. The write-off is the same entry a top-up would make (same key), so it is
 * never made twice. Returns how many wallets were written off and how much.
 */
export async function sweepLapsed(db: Db, merchantId: string, now = Date.now()): Promise<{ wallets: number; cents: number }> {
  const rules = await loadCreditRules(db, merchantId);
  if (rules.validityDays === 0) return { wallets: 0, cents: 0 };
  const w = await db.query("SELECT customer_id FROM wallets WHERE merchant_id=$1 AND balance_cents > 0", [merchantId]);
  let wallets = 0, cents = 0;
  for (const row of w.rows) {
    const s = await creditState(db, merchantId, row.customer_id as string, now, rules);
    if (s.state !== "lapsed" || s.balanceCents <= 0 || !s.expiresAt) continue;
    const day = new Date(s.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Singapore" });
    const r = await adjustTo(db, { merchantId, customerId: row.customer_id as string, targetCents: 0, idempotencyKey: `lapse:${s.expiresAt}`, staffId: null, note: `Credit expired on ${day} and was not reinstated in time (written off automatically)` });
    if (r.changed && !r.replayed) { wallets++; cents += -r.deltaCents; }
  }
  return { wallets, cents };
}
export async function writeOffLapsed(db: Db, i: { merchantId: string; customerId: string; staffId: string; deviceId?: string; outletId?: string }, now = Date.now()): Promise<number> {
  const s = await creditState(db, i.merchantId, i.customerId, now);
  if (s.state !== "lapsed" || s.balanceCents <= 0 || !s.expiresAt) return 0;
  const day = new Date(s.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Singapore" });
  const r = await adjustTo(db, { merchantId: i.merchantId, customerId: i.customerId, targetCents: 0, idempotencyKey: `lapse:${s.expiresAt}`, staffId: i.staffId, deviceId: i.deviceId, outletId: i.outletId, note: `Credit expired on ${day} and was not reinstated in time` });
  return r.changed ? -r.deltaCents : 0;
}
