import { createHash, randomBytes, randomInt } from "node:crypto";
import type { StampCardConfig } from "@pos/core";
import type { Db } from "./db/pool.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const CODE_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const SESSION_DAYS = 30;

export interface Member {
  id: string;
  /** Null for a customer who signed in by phone and never gave an email. */
  email: string | null;
  name: string | null;
  phone: string | null;
  pointsBalance: number;
  prefs: { orderUpdates: boolean; promos: boolean };
}

export interface Coupon {
  id: string;
  title: string;
  amountCents: number;
  minSpendCents: number;
  expiresAt: Date | null;
  usedOrderId: string | null;
}

const toCoupon = (r: Record<string, any>): Coupon => ({ id: r.id, title: r.title, amountCents: Number(r.amount_cents), minSpendCents: Number(r.min_spend_cents), expiresAt: r.expires_at, usedOrderId: r.used_order_id });

export type PointsKind = "welcome" | "earn" | "redeem" | "refund" | "adjust";

const toMember = (r: Record<string, any>): Member => ({ id: r.id, email: r.email, name: r.name, phone: r.phone, pointsBalance: Number(r.points_balance), prefs: { orderUpdates: r.pref_order_updates !== false, promos: r.pref_promos === true } });

export const normaliseEmail = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const e = s.trim().toLowerCase();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
};

/**
 * Customer accounts. Sign-in is an emailed 6-digit code (single use, 10 minutes, 5 tries). There is no mail
 * service wired up yet, so the code is handed to `deliver`: the server logs it and, outside production, returns it.
 */
export class MemberStore {
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
    private readonly welcomePoints: number,
    private readonly welcomeVoucherCents = 0,
  ) {}

  async startEmail(email: string): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.db.query("UPDATE member_challenges SET used=true WHERE merchant_id=$1 AND email=$2 AND NOT used", [this.merchantId, email]);
    await this.db.query(
      "INSERT INTO member_challenges (merchant_id, email, code_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))",
      [this.merchantId, email, sha256(`${email}:${code}`), CODE_MINUTES],
    );
    return code;
  }

  /** Check the code. On success: find or create the member (welcome points once) and open a session. */
  async verifyEmail(email: string, code: string, name?: string): Promise<{ token: string; member: Member; created: boolean } | null> {
    const c = await this.db.query(
      "SELECT id, code_hash, attempts FROM member_challenges WHERE merchant_id=$1 AND email=$2 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [this.merchantId, email],
    );
    const ch = c.rows[0];
    if (!ch) return null;
    if (ch.attempts >= MAX_CODE_ATTEMPTS) return null;
    if (ch.code_hash !== sha256(`${email}:${code}`)) {
      await this.db.query("UPDATE member_challenges SET attempts = attempts + 1 WHERE id=$1", [ch.id]);
      return null;
    }
    const used = await this.db.query("UPDATE member_challenges SET used=true WHERE id=$1 AND NOT used RETURNING id", [ch.id]);
    if (!used.rowCount) return null;

    const ins = await this.db.query(
      "INSERT INTO members (merchant_id, email, name) VALUES ($1,$2,$3) ON CONFLICT (merchant_id, email) DO NOTHING RETURNING id",
      [this.merchantId, email, name?.trim().slice(0, 40) || null],
    );
    const created = (ins.rowCount ?? 0) > 0;
    const m = await this.db.query("SELECT * FROM members WHERE merchant_id=$1 AND email=$2", [this.merchantId, email]);
    const member = await this.welcome(toMember(m.rows[0]));
    return { token: await this.openSession(member.id), member, created };
  }

  /** Welcome points and voucher, once: the entries have fixed keys, so a second sign-in finds them already there. */
  private async welcome(member: Member): Promise<Member> {
    if (this.welcomePoints > 0) await this.post(member.id, "welcome", this.welcomePoints, "welcome");
    if (this.welcomeVoucherCents > 0) await this.grantCoupon(member.id, "welcome", { title: `Welcome voucher S$${(this.welcomeVoucherCents / 100).toFixed(2)} off`, amountCents: this.welcomeVoucherCents, minSpendCents: 0 });
    return (await this.byId(member.id))!;
  }

  async openSession(memberId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO member_sessions (token_hash, merchant_id, member_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))", [sha256(token), this.merchantId, memberId, SESSION_DAYS]);
    return token;
  }

  // ---- other ways in: Google, Microsoft, a text from the customer's phone --------------------------

  /**
   * Find or create the member for an identity from a sign-in provider. A returning identity always maps to the
   * same member. A new one joins an existing account with the same email only when the provider vouches for that
   * email (`emailVerified`); otherwise it gets its own account, so nobody can take over an account by claiming
   * its email address at a provider that does not check it.
   */
  async signInWithIdentity(provider: string, subject: string, p: { email?: string | null; emailVerified?: boolean; name?: string | null; phone?: string | null }): Promise<{ token: string; member: Member; created: boolean }> {
    const known = await this.db.query("SELECT member_id FROM member_identities WHERE merchant_id=$1 AND provider=$2 AND subject=$3", [this.merchantId, provider, subject]);
    let memberId: string | undefined = known.rows[0]?.member_id;
    let created = false;
    if (!memberId) {
      const email = p.email ? normaliseEmail(p.email) : null;
      let existing: string | undefined;
      if (email && p.emailVerified) existing = (await this.db.query("SELECT id FROM members WHERE merchant_id=$1 AND email=$2", [this.merchantId, email])).rows[0]?.id;
      if (!existing && p.phone) existing = (await this.db.query("SELECT id FROM members WHERE merchant_id=$1 AND phone=$2 ORDER BY created_at LIMIT 1", [this.merchantId, p.phone])).rows[0]?.id;
      if (existing) memberId = existing;
      else {
        // The email column is unique: when it is already another account's, this one simply has no email.
        const taken = email ? (await this.db.query("SELECT 1 FROM members WHERE merchant_id=$1 AND email=$2", [this.merchantId, email])).rowCount : 0;
        const ins = await this.db.query("INSERT INTO members (merchant_id, email, name, phone) VALUES ($1,$2,$3,$4) RETURNING id", [this.merchantId, taken ? null : email, p.name?.trim().slice(0, 40) || null, p.phone ?? null]);
        memberId = ins.rows[0].id as string;
        created = true;
      }
      // A lost race with another sign-in for the same identity resolves to whichever row won.
      await this.db.query("INSERT INTO member_identities (merchant_id, provider, subject, member_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [this.merchantId, provider, subject, memberId]);
      memberId = (await this.db.query("SELECT member_id FROM member_identities WHERE merchant_id=$1 AND provider=$2 AND subject=$3", [this.merchantId, provider, subject])).rows[0].member_id as string;
    }
    if (p.name && !(await this.byId(memberId))?.name) await this.updateProfile(memberId, { name: p.name });
    const member = await this.welcome((await this.byId(memberId))!);
    return { token: await this.openSession(member.id), member, created };
  }

  async saveOAuthState(state: string, provider: string, verifier: string, minutes = 10): Promise<void> {
    await this.db.query("DELETE FROM oauth_states WHERE expires_at < now()");
    await this.db.query("INSERT INTO oauth_states (state_hash, merchant_id, provider, verifier, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))", [sha256(state), this.merchantId, provider, verifier, minutes]);
  }

  /** Single use: a callback can be completed once. */
  async takeOAuthState(state: string, provider: string): Promise<string | null> {
    const r = await this.db.query("DELETE FROM oauth_states WHERE state_hash=$1 AND merchant_id=$2 AND provider=$3 AND expires_at > now() RETURNING verifier", [sha256(state), this.merchantId, provider]);
    return r.rows[0]?.verifier ?? null;
  }

  async issueTicket(memberId: string, minutes = 2): Promise<string> {
    const ticket = randomBytes(24).toString("base64url");
    await this.db.query("INSERT INTO login_tickets (ticket_hash, merchant_id, member_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))", [sha256(ticket), this.merchantId, memberId, minutes]);
    return ticket;
  }

  async redeemTicket(ticket: string): Promise<{ token: string; member: Member } | null> {
    const r = await this.db.query("UPDATE login_tickets SET used=true WHERE ticket_hash=$1 AND merchant_id=$2 AND NOT used AND expires_at > now() RETURNING member_id", [sha256(ticket), this.merchantId]);
    if (!r.rows[0]) return null;
    const member = await this.byId(r.rows[0].member_id);
    return member ? { token: await this.openSession(member.id), member } : null;
  }

  /** Start a reverse-SMS sign-in for this phone (digits only, with country code). Older open ones for it are retired. */
  async startSms(phone: string, seconds: number): Promise<{ id: string; code: string; expiresAt: Date }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.db.query("UPDATE sms_challenges SET expires_at = now() WHERE merchant_id=$1 AND phone=$2 AND verified_at IS NULL AND expires_at > now()", [this.merchantId, phone]);
    const r = await this.db.query("INSERT INTO sms_challenges (merchant_id, phone, code, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4)) RETURNING id, expires_at", [this.merchantId, phone, code, seconds]);
    return { id: r.rows[0].id, code, expiresAt: r.rows[0].expires_at };
  }

  /** A text arrived: when its sender and code match an open challenge, that challenge is proven. */
  async matchSms(fromDigits: string, body: string): Promise<boolean> {
    const code = body.replace(/\D/g, "");
    if (code.length !== 6) return false;
    const r = await this.db.query("UPDATE sms_challenges SET verified_at = now() WHERE merchant_id=$1 AND phone=$2 AND code=$3 AND verified_at IS NULL AND expires_at > now() RETURNING id", [this.merchantId, fromDigits, code]);
    return (r.rowCount ?? 0) > 0;
  }

  async smsStatus(id: string): Promise<{ state: "pending" | "verified" | "expired"; secondsLeft: number; phone: string; claimed: boolean } | null> {
    const r = await this.db.query("SELECT phone, verified_at, claimed, GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now()))) AS left FROM sms_challenges WHERE id::text=$1 AND merchant_id=$2", [id, this.merchantId]);
    const x = r.rows[0];
    if (!x) return null;
    const left = Math.floor(Number(x.left));
    return { state: x.verified_at ? "verified" : left > 0 ? "pending" : "expired", secondsLeft: left, phone: x.phone, claimed: x.claimed };
  }

  /** The browser collects the session once, after the text has matched. */
  async claimSms(id: string): Promise<string | null> {
    const r = await this.db.query("UPDATE sms_challenges SET claimed=true WHERE id::text=$1 AND merchant_id=$2 AND verified_at IS NOT NULL AND NOT claimed RETURNING phone", [id, this.merchantId]);
    return r.rows[0]?.phone ?? null;
  }

  /** A member's own orders, newest first. */
  async orderIds(memberId: string, limit = 20): Promise<Array<{ orderId: string; at: Date }>> {
    const r = await this.db.query("SELECT order_id, created_at FROM member_orders WHERE member_id=$1 AND merchant_id=$2 ORDER BY created_at DESC LIMIT $3", [memberId, this.merchantId, Math.min(limit, 50)]);
    return r.rows.map((x) => ({ orderId: x.order_id as string, at: x.created_at as Date }));
  }

  async fromToken(token: string | undefined): Promise<Member | null> {
    if (!token) return null;
    const r = await this.db.query(
      "SELECT m.* FROM member_sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=$1 AND s.merchant_id=$2 AND s.expires_at > now()",
      [sha256(token), this.merchantId],
    );
    return r.rows[0] ? toMember(r.rows[0]) : null;
  }

  async logout(token: string): Promise<void> {
    await this.db.query("DELETE FROM member_sessions WHERE token_hash=$1", [sha256(token)]);
  }

  async byId(id: string): Promise<Member | null> {
    const r = await this.db.query("SELECT * FROM members WHERE id=$1 AND merchant_id=$2", [id, this.merchantId]);
    return r.rows[0] ? toMember(r.rows[0]) : null;
  }

  async updateProfile(id: string, p: { name?: string; phone?: string; orderUpdates?: boolean; promos?: boolean }): Promise<void> {
    await this.db.query("UPDATE members SET name=COALESCE($3,name), phone=COALESCE($4,phone), pref_order_updates=COALESCE($5,pref_order_updates), pref_promos=COALESCE($6,pref_promos) WHERE id=$1 AND merchant_id=$2", [id, this.merchantId, p.name?.trim().slice(0, 40) || null, p.phone?.trim().slice(0, 20) || null, typeof p.orderUpdates === "boolean" ? p.orderUpdates : null, typeof p.promos === "boolean" ? p.promos : null]);
  }

  /** True the first time this notice is claimed for the order, so an email goes out once however often the order changes. */
  async claimNotice(orderId: string, kind: string): Promise<boolean> {
    const r = await this.db.query("INSERT INTO member_notices (order_id, kind) VALUES ($1,$2) ON CONFLICT DO NOTHING", [orderId, kind]);
    return r.rowCount === 1;
  }

  /**
   * The only way points move. Same key = same entry (a retry never posts twice); a spend that would take the
   * balance below zero is refused. Returns the new balance, or null when refused.
   */
  async post(memberId: string, kind: PointsKind, points: number, key: string, o: { orderId?: string; note?: string } = {}): Promise<{ balance: number; replayed: boolean } | null> {
    if (!Number.isSafeInteger(points) || points === 0) throw new Error("points must be a non-zero integer");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const m = await client.query("SELECT points_balance FROM members WHERE id=$1 AND merchant_id=$2 FOR UPDATE", [memberId, this.merchantId]);
      if (!m.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const dup = await client.query("SELECT balance_after FROM points_entries WHERE member_id=$1 AND idempotency_key=$2", [memberId, key]);
      if (dup.rowCount) {
        await client.query("COMMIT");
        return { balance: Number(dup.rows[0].balance_after), replayed: true };
      }
      const after = Number(m.rows[0].points_balance) + points;
      if (after < 0) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("INSERT INTO points_entries (member_id, kind, points, balance_after, idempotency_key, order_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)", [memberId, kind, points, after, key, o.orderId ?? null, o.note ?? null]);
      await client.query("UPDATE members SET points_balance=$2 WHERE id=$1", [memberId, after]);
      await client.query("COMMIT");
      return { balance: after, replayed: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async history(memberId: string, limit = 50) {
    const r = await this.db.query("SELECT kind, points, balance_after, order_id, note, created_at FROM points_entries WHERE member_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2", [memberId, Math.min(limit, 200)]);
    return r.rows.map((x) => ({ kind: x.kind as PointsKind, points: Number(x.points), balanceAfter: Number(x.balance_after), orderId: x.order_id as string | null, note: x.note as string | null, at: x.created_at as Date }));
  }

  // ---- stamp cards ------------------------------------------------------------------------------

  async stamps(memberId: string): Promise<{ count: number; completed: number }> {
    const r = await this.db.query("SELECT count, cards_completed FROM member_stamps WHERE member_id=$1", [memberId]);
    return { count: Number(r.rows[0]?.count ?? 0), completed: Number(r.rows[0]?.cards_completed ?? 0) };
  }

  /**
   * One stamp for a paid order that reaches the card's minimum, once. When the card fills, the member gets the
   * reward voucher and the card starts again. Returns the new count, or null when nothing was stamped.
   */
  async stampForOrder(orderId: string, paidCents: number, card: StampCardConfig): Promise<{ count: number; rewarded: boolean } | null> {
    if (!card.enabled || card.target < 1) return null;
    const claim = await this.db.query("UPDATE member_orders SET stamped=true WHERE order_id=$1 AND merchant_id=$2 AND NOT stamped RETURNING member_id", [orderId, this.merchantId]);
    // A free order (a voucher or points covered it all) earns no stamp: something must actually have been paid.
    if (!claim.rows[0] || paidCents <= 0 || paidCents < card.minPaidCents) return null;
    const memberId = claim.rows[0].member_id as string;
    const r = await this.db.query(
      `INSERT INTO member_stamps (member_id, count) VALUES ($1, 1)
       ON CONFLICT (member_id) DO UPDATE SET count = member_stamps.count + 1 RETURNING count`,
      [memberId],
    );
    let count = Number(r.rows[0].count);
    let rewarded = false;
    if (count >= card.target) {
      await this.db.query("UPDATE member_stamps SET count = count - $2, cards_completed = cards_completed + 1 WHERE member_id=$1", [memberId, card.target]);
      count -= card.target;
      rewarded = true;
      await this.grantCoupon(memberId, `stamp:${orderId}`, { title: card.rewardTitle, amountCents: card.rewardCents, minSpendCents: 0 });
    }
    return { count, rewarded };
  }

  // ---- coupons ----------------------------------------------------------------------------------

  /** Give a coupon. The source key makes it idempotent: the same grant twice is one coupon. */
  async grantCoupon(memberId: string, sourceKey: string, c: { title: string; amountCents: number; minSpendCents: number; expiresAt?: Date }): Promise<void> {
    await this.db.query(
      "INSERT INTO member_coupons (merchant_id, member_id, title, amount_cents, min_spend_cents, expires_at, source_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (member_id, source_key) DO NOTHING",
      [this.merchantId, memberId, c.title, c.amountCents, c.minSpendCents, c.expiresAt ?? null, sourceKey],
    );
  }

  /** The coupons a member can still use (unused and not expired). */
  async coupons(memberId: string): Promise<Coupon[]> {
    const r = await this.db.query("SELECT * FROM member_coupons WHERE member_id=$1 AND merchant_id=$2 AND used_order_id IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at", [memberId, this.merchantId]);
    return r.rows.map(toCoupon);
  }

  async coupon(memberId: string, couponId: string): Promise<Coupon | null> {
    const r = await this.db.query("SELECT * FROM member_coupons WHERE id::text=$1 AND member_id=$2 AND merchant_id=$3 AND used_order_id IS NULL AND (expires_at IS NULL OR expires_at > now())", [couponId, memberId, this.merchantId]);
    return r.rows[0] ? toCoupon(r.rows[0]) : null;
  }

  /** Spend a coupon on an order, atomically: two orders cannot use the same one. */
  async useCoupon(memberId: string, couponId: string, orderId: string): Promise<boolean> {
    const r = await this.db.query(
      "UPDATE member_coupons SET used_order_id=$3 WHERE id::text=$1 AND member_id=$2 AND merchant_id=$4 AND used_order_id IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id",
      [couponId, memberId, orderId, this.merchantId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ---- member orders: spend at placement, earn once paid, refund if cancelled -------------------

  async linkOrder(orderId: string, memberId: string, pointsRedeemed: number): Promise<void> {
    await this.db.query("INSERT INTO member_orders (order_id, merchant_id, member_id, points_redeemed) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [orderId, this.merchantId, memberId, pointsRedeemed]);
  }

  /** Earn on the amount actually paid, once. */
  async earnForOrder(orderId: string, paidCents: number, perDollar: number): Promise<number> {
    const claim = await this.db.query("UPDATE member_orders SET earned_points = 0 WHERE order_id=$1 AND merchant_id=$2 AND earned_points IS NULL RETURNING member_id", [orderId, this.merchantId]);
    if (!claim.rows[0]) return 0;
    const pts = Math.floor((paidCents / 100) * perDollar);
    if (pts > 0) {
      await this.post(claim.rows[0].member_id, "earn", pts, `earn:${orderId}`, { orderId });
      await this.db.query("UPDATE member_orders SET earned_points=$2 WHERE order_id=$1", [orderId, pts]);
    }
    return pts;
  }

  /** A cancelled order gives back the points it spent, once. Points it earned (if paid) are taken back too. */
  async reverseForOrder(orderId: string): Promise<void> {
    const r = await this.db.query("UPDATE member_orders SET redeem_refunded=true WHERE order_id=$1 AND merchant_id=$2 AND NOT redeem_refunded RETURNING member_id, points_redeemed, earned_points", [orderId, this.merchantId]);
    const row = r.rows[0];
    if (!row) return;
    await this.db.query("UPDATE member_coupons SET used_order_id=NULL WHERE used_order_id=$1 AND merchant_id=$2", [orderId, this.merchantId]);
    if (Number(row.points_redeemed) > 0) await this.post(row.member_id, "refund", Number(row.points_redeemed), `refund:${orderId}`, { orderId });
  }
}
