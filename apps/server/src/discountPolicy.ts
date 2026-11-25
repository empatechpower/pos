import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, canDo, checkStaffPin, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";

/** What a cashier may do alone. Anything beyond it needs a manager's PIN. Managers and owners are not limited. */
export interface DiscountPolicy {
  /** The largest percentage a cashier may take off alone (0 = none). */
  cashierMaxPercent: number;
  /** The largest fixed amount, in cents, a cashier may take off alone (0 = none). */
  cashierMaxAmountCents: number;
  /** Changing a line's price by hand always needs a manager (the safe default). */
  overrideNeedsManager: boolean;
  /** The shop's own list of reasons a discount can be given for (reason codes). Missing = the built-in list. "Other" is always offered after them. */
  reasons?: string[];
}
/** Up to 12 reasons, each a short line; blanks and repeats are dropped. Null when it is not a list of text. */
export function cleanReasons(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 30 || !v.every((x) => typeof x === "string")) return null;
  const out: string[] = [];
  for (const x of v as string[]) { const t = x.replace(/\s+/g, " ").trim().slice(0, 40); if (t && t.toLowerCase() !== "other" && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); }
  return out.slice(0, 12);
}

export const DEFAULT_POLICY: DiscountPolicy = { cashierMaxPercent: 10, cashierMaxAmountCents: 500, overrideNeedsManager: true };

export async function loadPolicy(db: Db | null, merchantId: string): Promise<DiscountPolicy> {
  const r = db ? (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='discounts'", [merchantId])).rows[0] : undefined;
  const v = r?.value ?? {};
  const int = (x: unknown, d: number, max: number) => (Number.isInteger(x) && (x as number) >= 0 ? Math.min(x as number, max) : d);
  return { cashierMaxPercent: int(v.cashierMaxPercent, DEFAULT_POLICY.cashierMaxPercent, 100), cashierMaxAmountCents: int(v.cashierMaxAmountCents, DEFAULT_POLICY.cashierMaxAmountCents, 1_000_000), overrideNeedsManager: v.overrideNeedsManager === undefined ? DEFAULT_POLICY.overrideNeedsManager : !!v.overrideNeedsManager, ...(cleanReasons(v.reasons)?.length ? { reasons: cleanReasons(v.reasons)! } : {}) };
}

/**
 * The shop's rules for discounts and price changes, and a way for a cashier's till to get a manager's approval (their staff code and PIN,
 * checked with the same lockout as signing in). The till stamps the approval onto the discount, so the order itself records who allowed it.
 */
export function registerDiscountPolicy(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, needs } = d;
  app.get("/api/settings/discounts", { preHandler: needs("wallet.read") }, async () => loadPolicy(db, merchantId));
  app.put<{ Body: Partial<DiscountPolicy> }>("/api/settings/discounts", { preHandler: needs("device.manage") }, async (req, reply) => {
    const b = req.body ?? {};
    const pct = Number(b.cashierMaxPercent), amt = Number(b.cashierMaxAmountCents);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100 || !Number.isInteger(amt) || amt < 0 || amt > 1_000_000) return reply.code(400).send({ error: "limits_not_allowed" });
    // The list of reasons: sent = replaced (an empty list goes back to the built-in one); not sent = left as it is.
    const reasons = b.reasons === undefined ? (await loadPolicy(db, merchantId)).reasons ?? [] : cleanReasons(b.reasons);
    if (!reasons) return reply.code(400).send({ error: "reasons is a list of short lines of text" });
    const policy: DiscountPolicy = { cashierMaxPercent: pct, cashierMaxAmountCents: amt, overrideNeedsManager: b.overrideNeedsManager !== false, ...(reasons.length ? { reasons } : {}) };
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'discounts',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(policy)]);
    await audit(db, merchantId, req.staff!.id, "settings.discounts", policy);
    return policy;
  });

  app.post<{ Body: { approverCode?: string; approverPin?: string; purpose?: string } }>("/api/approvals", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const code = String(req.body?.approverCode ?? "").trim(), pin = String(req.body?.approverPin ?? "");
    if (!code || !pin) return reply.code(428).send({ error: "manager_approval_needed" });
    const v = await checkStaffPin(db, merchantId, code, pin);
    if (!v.ok) return reply.code(v.reason === "locked" ? 423 : 422).send({ error: v.reason === "locked" ? "approver_locked" : "approval_refused" });
    if (!canDo(v.row, "discount.approve")) return reply.code(422).send({ error: "approver_cannot_approve" });
    await audit(db, merchantId, req.staff!.id, "approval.given", { approvedBy: v.row.id, approverName: v.row.name, purpose: String(req.body?.purpose ?? "").slice(0, 60) });
    return { ok: true, approver: { id: v.row.id, name: v.row.name } };
  });
}
