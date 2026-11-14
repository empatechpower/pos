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
  i: { merchantId: string; customerId: string; targetCents: number; idempotencyKey: string; staffId: string; deviceId?: string; outletId?: string; note: string },
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
