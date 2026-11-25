import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db/pool.js";
import type { Permission } from "./auth.js";
import { audit } from "./auth.js";

/** What a promo code says it is worth, and the basis it is judged on. */
export const PROMO_BASIS = "items subtotal before service charge, tax and deposits";

export interface Promo {
  code: string;
  title: string;
  kind: "percent" | "amount";
  value: number;
  minSpendCents: number;
  startsAt: Date | null;
  endsAt: Date | null;
  maxUses: number | null;
  maxPerMember: number | null;
  active: boolean;
}

export type PromoReason = "unknown" | "inactive" | "not_started" | "expired" | "below_minimum" | "usage_exhausted" | "member_limit_reached" | "sign_in_required";

export type PromoVerdict =
  | { ok: true; promo: Promo; discountCents: number }
  | { ok: false; reason: PromoReason; shortfallCents?: number; minSpendCents?: number };

const norm = (code: unknown) => String(code ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
export const normalisePromoCode = norm;

const toPromo = (r: Record<string, any>): Promo => ({
  code: r.code, title: r.title, kind: r.kind, value: Number(r.value), minSpendCents: Number(r.min_spend_cents),
  startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null, maxUses: r.max_uses ?? null, maxPerMember: r.max_per_member ?? null, active: !!r.active,
});

/** The discount: a percentage of the items subtotal (rounded down to the cent), or a fixed amount, never more than the subtotal. */
export const promoDiscount = (p: Pick<Promo, "kind" | "value">, subtotalCents: number): number =>
  Math.max(0, Math.min(subtotalCents, p.kind === "percent" ? Math.floor((subtotalCents * p.value) / 100) : p.value));

/**
 * Accept or reject a code for a cart, with the reason. Never silent. The minimum is judged on the ITEMS SUBTOTAL, before service charge, tax and
 * deposits (locked coupon rule): a cart of S$19.50 of items fails a S$20 minimum even if charges would take the total over S$20.
 */
export async function judgePromo(db: Db, merchantId: string, rawCode: unknown, ctx: { now: number; subtotalCents: number; memberId?: string | null }): Promise<PromoVerdict> {
  const code = norm(rawCode);
  const row = code ? (await db.query("SELECT * FROM promo_codes WHERE merchant_id=$1 AND code=$2", [merchantId, code])).rows[0] : undefined;
  if (!row) return { ok: false, reason: "unknown" };
  const p = toPromo(row);
  if (!p.active) return { ok: false, reason: "inactive" };
  if (p.startsAt && ctx.now < new Date(p.startsAt).getTime()) return { ok: false, reason: "not_started" };
  if (p.endsAt && ctx.now >= new Date(p.endsAt).getTime()) return { ok: false, reason: "expired" };
  if (ctx.subtotalCents < p.minSpendCents) return { ok: false, reason: "below_minimum", minSpendCents: p.minSpendCents, shortfallCents: p.minSpendCents - ctx.subtotalCents };
  if (p.maxUses !== null) {
    const used = Number((await db.query("SELECT count(*) FROM promo_redemptions WHERE merchant_id=$1 AND code=$2 AND reversed_at IS NULL", [merchantId, code])).rows[0].count);
    if (used >= p.maxUses) return { ok: false, reason: "usage_exhausted" };
  }
  if (p.maxPerMember !== null) {
    if (!ctx.memberId) return { ok: false, reason: "sign_in_required" }; // a per-member limit cannot be kept for someone nobody can identify
    const used = Number((await db.query("SELECT count(*) FROM promo_redemptions WHERE merchant_id=$1 AND code=$2 AND member_id=$3 AND reversed_at IS NULL", [merchantId, code, ctx.memberId])).rows[0].count);
    if (used >= p.maxPerMember) return { ok: false, reason: "member_limit_reached" };
  }
  return { ok: true, promo: p, discountCents: promoDiscount(p, ctx.subtotalCents) };
}

/** Record that an order used a code, checking the limits again in the same step. False if a limit was reached in the meantime. */
export async function claimPromo(db: Db, merchantId: string, code: string, orderId: string, memberId: string | null, discountCents: number): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`promo/${merchantId}/${code}`]);
    const p = (await client.query("SELECT max_uses, max_per_member FROM promo_codes WHERE merchant_id=$1 AND code=$2", [merchantId, code])).rows[0];
    if (!p) { await client.query("ROLLBACK"); return false; }
    if (p.max_uses !== null) {
      const used = Number((await client.query("SELECT count(*) FROM promo_redemptions WHERE merchant_id=$1 AND code=$2 AND reversed_at IS NULL", [merchantId, code])).rows[0].count);
      if (used >= p.max_uses) { await client.query("ROLLBACK"); return false; }
    }
    if (p.max_per_member !== null && memberId) {
      const used = Number((await client.query("SELECT count(*) FROM promo_redemptions WHERE merchant_id=$1 AND code=$2 AND member_id=$3 AND reversed_at IS NULL", [merchantId, code, memberId])).rows[0].count);
      if (used >= p.max_per_member) { await client.query("ROLLBACK"); return false; }
    }
    await client.query("INSERT INTO promo_redemptions (merchant_id, code, order_id, member_id, discount_cents) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (merchant_id, order_id) DO NOTHING", [merchantId, code, orderId, memberId, discountCents]);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** A cancelled (or never recorded) order gives its use back. Safe to call twice. */
export async function releasePromo(db: Db, merchantId: string, orderId: string): Promise<void> {
  await db.query("UPDATE promo_redemptions SET reversed_at=now() WHERE merchant_id=$1 AND order_id=$2 AND reversed_at IS NULL", [merchantId, orderId]);
}

export async function promoStacksWithCoupons(db: Db, merchantId: string): Promise<boolean> {
  return !!(await db.query("SELECT stack_with_coupons FROM promo_settings WHERE merchant_id=$1", [merchantId])).rows[0]?.stack_with_coupons;
}

/** Checked before saving a code. */
export function validatePromoInput(b: Record<string, unknown>): { problems: string[]; promo?: Omit<Promo, "code"> } {
  const problems: string[] = [];
  const title = typeof b.title === "string" ? b.title.trim().slice(0, 80) : "";
  if (!title) problems.push("title is required");
  if (b.kind !== "percent" && b.kind !== "amount") problems.push("kind is percent or amount");
  const value = Number(b.value);
  if (!Number.isInteger(value) || value < 1) problems.push("value is a whole number (a percentage, or cents)");
  else if (b.kind === "percent" && value > 100) problems.push("a percentage is 1 to 100");
  else if (b.kind === "amount" && value > 10_000_000) problems.push("amount is too large");
  const min = b.minSpendCents === undefined || b.minSpendCents === null ? 0 : Number(b.minSpendCents);
  if (!Number.isInteger(min) || min < 0) problems.push("minSpendCents is a whole number of cents, 0 or more");
  const date = (v: unknown, name: string) => { if (v === undefined || v === null || v === "") return null; const d = new Date(String(v)); if (Number.isNaN(d.getTime())) { problems.push(`${name} is not a date`); return null; } return d; };
  const startsAt = date(b.startsAt, "startsAt");
  const endsAt = date(b.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) problems.push("endsAt must be after startsAt");
  const limit = (v: unknown, name: string) => { if (v === undefined || v === null || v === "") return null; const n = Number(v); if (!Number.isInteger(n) || n < 1) { problems.push(`${name} is a whole number, 1 or more`); return null; } return n; };
  const maxUses = limit(b.maxUses, "maxUses");
  const maxPerMember = limit(b.maxPerMember, "maxPerMember");
  if (problems.length) return { problems };
  return { problems, promo: { title, kind: b.kind as Promo["kind"], value, minSpendCents: min, startsAt, endsAt, maxUses, maxPerMember, active: b.active !== false } };
}

/** Staff routes: list, save and switch codes on or off, and the stacking setting. */
export function registerPromoAdmin(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const manage = { preHandler: d.needs("catalog.manage") };
  /**
   * Scan Coupon at the till: is this code good for an order of this size? The answer says why not when it is not. Nothing is used up here.
   */
  const till = { preHandler: d.needs("wallet.spend") };
  const WHY: Record<PromoReason, string> = { unknown: "That code is not known.", inactive: "That code is switched off.", not_started: "That code has not started yet.", expired: "That code has ended.", below_minimum: "The order is below the code's minimum spend.", usage_exhausted: "That code has been used up.", member_limit_reached: "This member has already used that code.", sign_in_required: "Attach a member to use that code." };
  app.post<{ Body: { code?: string; subtotalCents?: number; memberId?: string | null } }>("/api/promos/check", till, async (req, reply) => {
    const sub = req.body?.subtotalCents;
    if (!Number.isSafeInteger(sub) || (sub as number) < 0) return reply.code(400).send({ error: "subtotalCents is required" });
    const v = await judgePromo(d.db, d.merchantId, req.body?.code, { now: Date.now(), subtotalCents: sub as number, memberId: req.body?.memberId ?? null });
    if (!v.ok) return reply.code(409).send({ error: v.reason, message: WHY[v.reason], ...(v.minSpendCents !== undefined ? { minSpendCents: v.minSpendCents, shortfallCents: v.shortfallCents } : {}) });
    return { code: v.promo.code, title: v.promo.title, kind: v.promo.kind, value: v.promo.value, minSpendCents: v.promo.minSpendCents, discountCents: v.discountCents };
  });
  /** The code is used for one order when it is paid: checked again and counted, once per order. Cancelling the order gives the use back. */
  app.post<{ Body: { code?: string; orderId?: string; subtotalCents?: number; memberId?: string | null } }>("/api/promos/claim", till, async (req, reply) => {
    const sub = req.body?.subtotalCents, orderId = String(req.body?.orderId ?? "");
    if (!Number.isSafeInteger(sub) || (sub as number) < 0 || !orderId || orderId.length > 64) return reply.code(400).send({ error: "subtotalCents and orderId are required" });
    const memberId = req.body?.memberId ?? null;
    const had = await d.db.query("SELECT code, discount_cents FROM promo_redemptions WHERE merchant_id=$1 AND order_id=$2 AND reversed_at IS NULL", [d.merchantId, orderId]);
    if (had.rows[0]) return { code: had.rows[0].code as string, discountCents: Number(had.rows[0].discount_cents), replayed: true };
    const v = await judgePromo(d.db, d.merchantId, req.body?.code, { now: Date.now(), subtotalCents: sub as number, memberId });
    if (!v.ok) return reply.code(409).send({ error: v.reason, message: WHY[v.reason] });
    if (!(await claimPromo(d.db, d.merchantId, v.promo.code, orderId, memberId, v.discountCents))) return reply.code(409).send({ error: "usage_exhausted", message: WHY.usage_exhausted });
    await audit(d.db, d.merchantId, req.staff!.id, "promo.claim_till", { code: v.promo.code, orderId, discountCents: v.discountCents });
    return { code: v.promo.code, title: v.promo.title, discountCents: v.discountCents, minSpendCents: v.promo.minSpendCents, replayed: false };
  });

  app.get("/api/promos", manage, async () => {
    const r = await d.db.query(
      `SELECT c.*, (SELECT count(*) FROM promo_redemptions x WHERE x.merchant_id=c.merchant_id AND x.code=c.code AND x.reversed_at IS NULL) AS uses,
              (SELECT COALESCE(sum(discount_cents),0) FROM promo_redemptions x WHERE x.merchant_id=c.merchant_id AND x.code=c.code AND x.reversed_at IS NULL) AS discounted
       FROM promo_codes c WHERE c.merchant_id=$1 ORDER BY c.created_at DESC`, [d.merchantId]);
    return { basis: PROMO_BASIS, promos: r.rows.map((x) => ({ ...toPromo(x), uses: Number(x.uses), discountedCents: Number(x.discounted) })) };
  });
  app.put<{ Params: { code: string }; Body: Record<string, unknown> }>("/api/promos/:code", manage, async (req, reply) => {
    const code = norm(req.params.code);
    if (code.length < 3 || code.length > 30) return reply.code(400).send({ error: "invalid_promo", problems: ["the code is 3 to 30 letters, digits, dashes or underscores"] });
    const v = validatePromoInput(req.body ?? {});
    if (!v.promo) return reply.code(400).send({ error: "invalid_promo", problems: v.problems });
    const p = v.promo;
    await d.db.query(
      `INSERT INTO promo_codes (merchant_id, code, title, kind, value, min_spend_cents, starts_at, ends_at, max_uses, max_per_member, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (merchant_id, code) DO UPDATE SET title=EXCLUDED.title, kind=EXCLUDED.kind, value=EXCLUDED.value, min_spend_cents=EXCLUDED.min_spend_cents, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, max_uses=EXCLUDED.max_uses, max_per_member=EXCLUDED.max_per_member, active=EXCLUDED.active`,
      [d.merchantId, code, p.title, p.kind, p.value, p.minSpendCents, p.startsAt, p.endsAt, p.maxUses, p.maxPerMember, p.active]);
    await audit(d.db, d.merchantId, req.staff!.id, "promo.save", { code, kind: p.kind, value: p.value, minSpendCents: p.minSpendCents, active: p.active });
    return { ok: true, code };
  });
  app.get("/api/promo/settings", manage, async () => ({ stackWithCoupons: await promoStacksWithCoupons(d.db, d.merchantId) }));
  app.put<{ Body: { stackWithCoupons?: boolean } }>("/api/promo/settings", manage, async (req, reply) => {
    if (typeof req.body?.stackWithCoupons !== "boolean") return reply.code(400).send({ error: "stackWithCoupons is true or false" });
    await d.db.query("INSERT INTO promo_settings (merchant_id, stack_with_coupons) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET stack_with_coupons=EXCLUDED.stack_with_coupons", [d.merchantId, req.body.stackWithCoupons]);
    await audit(d.db, d.merchantId, req.staff!.id, "promo.stacking", { stackWithCoupons: req.body.stackWithCoupons });
    return { stackWithCoupons: req.body.stackWithCoupons };
  });
}
