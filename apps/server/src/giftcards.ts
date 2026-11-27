import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";
import { openShiftOf } from "./shifts.js";

/**
 * Gift cards (developer handout 4.11): a code with a balance. A card is loaded when it is sold, spent as a tender at payment, and given
 * back to when an order paid with it is refunded. Every movement is an immutable entry; the card row is locked for the length of the
 * transaction, so two tills spending one card at once are applied one after the other; and the same key on the same card is the same
 * entry, so a retry or a double tap can never spend or load twice.
 */
export type GiftKind = "load" | "redeem" | "refund" | "adjust";
export interface GiftEntry { id: string; kind: GiftKind; amountCents: number; balanceAfter: number; orderId: string | null; tender: string | null; note: string | null; at: number }
export interface GiftCard { code: string; balanceCents: number; active: boolean; createdAt: number }
export type GiftResult =
  | { ok: true; card: GiftCard; entry: GiftEntry; replayed: boolean }
  | { ok: false; reason: "unknown_card" | "code_taken" | "card_inactive" | "bad_code" }
  | { ok: false; reason: "insufficient_funds"; balanceCents: number };

/** A card's code as it is kept: capitals and digits only, 4 to 24 of them. Spaces and dashes typed or printed are ignored. */
export function cleanGiftCode(v: unknown): string | null {
  const c = String(v ?? "").toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{4,24}$/.test(c) ? c : null;
}
/** A new code: twelve characters with the look-alikes (0/O, 1/I/L) left out, so it can be read aloud and typed. */
export function newGiftCode(): string {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 12 }, () => A[randomInt(A.length)]).join("");
}
/** How a code is shown to people: in fours. */
export const showGiftCode = (c: string) => c.replace(/(.{4})(?=.)/g, "$1 ");

const toCard = (r: Record<string, unknown>): GiftCard => ({ code: r.code as string, balanceCents: Number(r.balance_cents), active: r.active as boolean, createdAt: new Date(r.created_at as string).getTime() });
const toEntry = (r: Record<string, unknown>): GiftEntry => ({ id: r.id as string, kind: r.kind as GiftKind, amountCents: Number(r.amount_cents), balanceAfter: Number(r.balance_after), orderId: (r.order_id as string | null) ?? null, tender: (r.tender as string | null) ?? null, note: (r.note as string | null) ?? null, at: new Date(r.created_at as string).getTime() });

interface Move {
  merchantId: string; code: string; kind: GiftKind;
  /** Signed cents: positive adds to the card, negative takes from it. */
  amountCents: number; idempotencyKey: string;
  /** Make the card if it does not exist (selling a new one). Without it an unknown code is refused. */
  create?: boolean;
  orderId?: string; outletId?: string; deviceId?: string; staffId?: string; tender?: string; note?: string;
}

/** The only way a card's balance moves. */
export async function moveGift(db: Db, i: Move): Promise<GiftResult> {
  if (!Number.isSafeInteger(i.amountCents) || i.amountCents === 0) throw new Error("amountCents must be a non-zero integer");
  const code = cleanGiftCode(i.code);
  if (!code) return { ok: false, reason: "bad_code" };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let made = false;
    if (i.create) made = !!(await client.query("INSERT INTO gift_cards (merchant_id, code, outlet_id) VALUES ($1,$2,$3) ON CONFLICT (merchant_id, code) DO NOTHING RETURNING id", [i.merchantId, code, i.outletId ?? null])).rowCount;
    const c = await client.query("SELECT * FROM gift_cards WHERE merchant_id=$1 AND code=$2 FOR UPDATE", [i.merchantId, code]);
    if (!c.rowCount) { await client.query("ROLLBACK"); return { ok: false, reason: "unknown_card" }; }
    const card = c.rows[0] as Record<string, unknown>;
    const dup = await client.query("SELECT * FROM gift_card_entries WHERE card_id=$1 AND idempotency_key=$2", [card.id, i.idempotencyKey]);
    if (dup.rowCount) { await client.query("COMMIT"); return { ok: true, card: toCard(card), entry: toEntry(dup.rows[0]), replayed: true }; }
    // Selling a "new" card under a code that already exists is refused: the cashier meant a fresh card, not someone else's.
    if (i.create && !made) { await client.query("ROLLBACK"); return { ok: false, reason: "code_taken" }; }
    // A switched-off card (lost, or cancelled) cannot be spent or loaded; a refund still goes back to it, so the money is not lost.
    if (!card.active && i.kind !== "refund") { await client.query("ROLLBACK"); return { ok: false, reason: "card_inactive" }; }
    const balance = Number(card.balance_cents), after = balance + i.amountCents;
    if (after < 0) { await client.query("ROLLBACK"); return { ok: false, reason: "insufficient_funds", balanceCents: balance }; }
    const ins = await client.query(
      `INSERT INTO gift_card_entries (card_id, kind, amount_cents, balance_after, idempotency_key, order_id, outlet_id, device_id, staff_id, tender, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [card.id, i.kind, i.amountCents, after, i.idempotencyKey, i.orderId ?? null, i.outletId ?? null, i.deviceId ?? null, i.staffId ?? null, i.tender ?? null, i.note ?? null],
    );
    const upd = await client.query("UPDATE gift_cards SET balance_cents=$1 WHERE id=$2 RETURNING *", [after, card.id]);
    await client.query("COMMIT");
    return { ok: true, card: toCard(upd.rows[0]), entry: toEntry(ins.rows[0]), replayed: false };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function giftCard(db: Db, merchantId: string, rawCode: unknown): Promise<{ card: GiftCard; entries: GiftEntry[] } | null> {
  const code = cleanGiftCode(rawCode);
  if (!code) return null;
  const c = await db.query("SELECT * FROM gift_cards WHERE merchant_id=$1 AND code=$2", [merchantId, code]);
  if (!c.rowCount) return null;
  const e = await db.query("SELECT * FROM gift_card_entries WHERE card_id=$1 ORDER BY created_at DESC LIMIT 30", [c.rows[0].id]);
  return { card: toCard(c.rows[0]), entries: e.rows.map(toEntry) };
}

/** A cashier may load at most this much onto a card at once (the same ceiling as a member credit top-up); managers and owners are not capped. */
export const CASHIER_GIFT_LOAD_LIMIT_CENTS = 20_000;
const LOAD_TENDERS = ["cash", "card", "paynow", "other"];

export function registerGiftCards(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; outletOf: (req: FastifyRequest) => string | undefined }) {
  const { db, merchantId, needs } = d;
  const key = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9:_-]{6,80}$/.test(v) ? v : null);
  const cents = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000 ? (v as number) : null);
  const refuse = (reply: FastifyReply, r: Extract<GiftResult, { ok: false }>) =>
    reply.code(r.reason === "unknown_card" ? 404 : r.reason === "bad_code" ? 400 : 409).send({ error: r.reason, ...(r.reason === "insufficient_funds" ? { balanceCents: r.balanceCents } : {}) });

  /** The cards with money on them, newest first, and what is owed on all of them together. */
  app.get("/api/giftcards", { preHandler: needs("audit.read") }, async () => {
    const r = await db.query("SELECT * FROM gift_cards WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 300", [merchantId]);
    const t = await db.query("SELECT COALESCE(SUM(balance_cents),0) AS owed, COUNT(*) AS n FROM gift_cards WHERE merchant_id=$1 AND balance_cents > 0", [merchantId]);
    // The books: what was loaded, spent and given back, and whether every card's balance is the sum of its own entries.
    const k = await db.query(`SELECT e.kind, COALESCE(SUM(e.amount_cents),0) AS s FROM gift_card_entries e JOIN gift_cards c ON c.id=e.card_id WHERE c.merchant_id=$1 GROUP BY e.kind`, [merchantId]);
    const by = Object.fromEntries(k.rows.map((x) => [x.kind as string, Number(x.s)]));
    const off = await db.query(`SELECT c.code FROM gift_cards c LEFT JOIN gift_card_entries e ON e.card_id=c.id WHERE c.merchant_id=$1 GROUP BY c.id HAVING c.balance_cents <> COALESCE(SUM(e.amount_cents),0)`, [merchantId]);
    return {
      cards: r.rows.map(toCard), outstandingCents: Number(t.rows[0].owed), withBalance: Number(t.rows[0].n),
      books: { loadedCents: by.load ?? 0, redeemedCents: by.redeem ?? 0, refundedCents: by.refund ?? 0, adjustedCents: by.adjust ?? 0, mismatched: off.rows.map((x) => x.code as string) },
    };
  });

  /** One card: what is on it and what happened to it. */
  app.get<{ Params: { code: string } }>("/api/giftcards/:code", { preHandler: needs("wallet.read") }, async (req, reply) => {
    const c = await giftCard(db, merchantId, req.params.code);
    return c ?? reply.code(404).send({ error: "unknown_card" });
  });

  /** Sell a new card (no code given: one is made up; a code given: a pre-printed card), or load more onto an existing one (`code` + `existing: true`). */
  app.post<{ Body: { code?: string; existing?: boolean; amountCents?: number; tender?: string; idempotencyKey?: string } }>("/api/giftcards/load", { preHandler: needs("wallet.topup") }, async (req, reply) => {
    const b = req.body ?? {};
    const amount = cents(b.amountCents), k = key(b.idempotencyKey);
    if (!amount || !k) return reply.code(400).send({ error: "amountCents (1 to 1000000) and idempotencyKey are required" });
    if (req.staff!.role === "cashier" && amount > CASHIER_GIFT_LOAD_LIMIT_CENTS) return reply.code(403).send({ error: "over_cashier_limit", limitCents: CASHIER_GIFT_LOAD_LIMIT_CENTS });
    const tender = LOAD_TENDERS.includes(String(b.tender)) ? String(b.tender) : "cash";
    const code = b.code ? cleanGiftCode(b.code) : newGiftCode();
    if (!code) return reply.code(400).send({ error: "bad_code" });
    const r = await moveGift(db, { merchantId, code, kind: "load", amountCents: amount, idempotencyKey: k, create: !b.existing, staffId: req.staff!.id, outletId: d.outletOf(req), deviceId: req.device?.id, tender });
    if (!r.ok) return refuse(reply, r);
    // Cash taken for a card goes into the cashier's drawer: it is counted there, or the drawer would be over at close.
    let inDrawer = false;
    if (!r.replayed) {
      if (tender === "cash") {
        const sh = await openShiftOf(db, merchantId, req.staff!.id);
        if (sh) { await db.query("INSERT INTO cash_moves (shift_id, kind, amount_cents, reason, staff_name) VALUES ($1,'in',$2,$3,$4)", [sh.id, amount, `Gift card ${showGiftCode(code)}`, req.staff!.name]); inDrawer = true; }
      }
      await audit(db, merchantId, req.staff!.id, "giftcard.load", { code, amountCents: amount, tender, balanceCents: r.card.balanceCents });
    }
    return { card: r.card, entry: r.entry, replayed: r.replayed, inDrawer };
  });

  /** Spend from a card at payment. The whole amount or nothing: a card that cannot cover it is refused with what it holds. */
  app.post<{ Params: { code: string }; Body: { amountCents?: number; orderId?: string; idempotencyKey?: string } }>("/api/giftcards/:code/redeem", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const b = req.body ?? {};
    const amount = cents(b.amountCents), k = key(b.idempotencyKey);
    if (!amount || !k) return reply.code(400).send({ error: "amountCents and idempotencyKey are required" });
    const r = await moveGift(db, { merchantId, code: req.params.code, kind: "redeem", amountCents: -amount, idempotencyKey: k, orderId: typeof b.orderId === "string" ? b.orderId.slice(0, 64) : undefined, staffId: req.staff!.id, outletId: d.outletOf(req), deviceId: req.device?.id });
    if (!r.ok) return refuse(reply, r);
    return { card: r.card, entry: r.entry, replayed: r.replayed };
  });

  /** Switch a card off (lost or cancelled) or back on. Its balance stays on it. */
  app.put<{ Params: { code: string }; Body: { active?: boolean } }>("/api/giftcards/:code", { preHandler: needs("wallet.refund") }, async (req, reply) => {
    const code = cleanGiftCode(req.params.code);
    if (!code || typeof req.body?.active !== "boolean") return reply.code(400).send({ error: "active is true or false" });
    const r = await db.query("UPDATE gift_cards SET active=$3 WHERE merchant_id=$1 AND code=$2 RETURNING *", [merchantId, code, req.body.active]);
    if (!r.rowCount) return reply.code(404).send({ error: "unknown_card" });
    await audit(db, merchantId, req.staff!.id, "giftcard.active", { code, active: req.body.active });
    return { card: toCard(r.rows[0]) };
  });
}
