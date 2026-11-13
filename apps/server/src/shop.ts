import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { collectionNumber, confirmedPaid, newId, optionLines, orderTotals, quoteOrder, reduceOrder, shopStatus, type BusinessConfig, type OrderEvent } from "@pos/core";
import { audit, type Permission } from "./auth.js";
import type { BrandStore } from "./brand.js";
import type { CatalogStore, PgCatalogStore } from "./catalog.js";
import { liveSmsNumber } from "./devices.js";
import type { Db } from "./db/pool.js";
import { balanceOf, refund as refundCredit, spend as spendCredit } from "./ledger.js";
import { FailureLimiter } from "./rateLimit.js";
import { normaliseEmail, type MemberStore } from "./members.js";
import { authorizeUrl, createStripeCheckout, createStripeRefund, fetchProfile, sendMail, newState, newVerifier, sameSecret, verifyStripeSignature, type Integrations, type OAuthProvider } from "./integrations.js";
import type { EventStore } from "./store.js";
import { createHash } from "node:crypto";

/** The server's own device id on events it creates for customers. */
export const SHOP_DEVICE = "shop";

interface ShopDeps {
  db: Db;
  config: BusinessConfig;
  store: EventStore;
  catalog: CatalogStore;
  /** Present with a database: serves item photos. */
  catalogAdmin?: PgCatalogStore;
  brand: BrandStore;
  /** Stores events, nudges live screens, queues prints (same path as a till's push). */
  ingest: (events: OrderEvent[]) => Promise<unknown>;
  /** Customer accounts and points (needs a database). */
  members?: MemberStore;
  needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** Google / Microsoft / SMS / Stripe settings. Any that are missing simply switch that feature off. */
  integrations?: Integrations;
}

const singaporeDay = (now = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(now);

/** W001, W002… restarting each day. Atomic, so two customers ordering together never share a number. */
async function nextOnlineNumber(db: Db, merchantId: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO counters (merchant_id, name, day, value) VALUES ($1,'online',$2,1)
     ON CONFLICT (merchant_id, name, day) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [merchantId, singaporeDay()],
  );
  return `W${String(r.rows[0].value).padStart(3, "0")}`;
}

/**
 * Queue numbers of orders still in progress today. Their collection numbers are "taken"; a completed or
 * cancelled order frees its number for the next customer.
 */
async function activeQueueNumbers(db: Db, merchantId: string): Promise<Set<string>> {
  const r = await db.query(
    `SELECT o.body->>'queueNumber' AS q FROM events o
     WHERE o.merchant_id=$1 AND o.type='OrderOpened' AND o.body->>'queueNumber' IS NOT NULL
       AND o.created_at >= now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM events s WHERE s.merchant_id=o.merchant_id AND s.order_id=o.order_id AND s.type='StageSet' AND s.body->>'stage' IN ('completed','cancelled'))`,
    [merchantId],
  );
  return new Set(r.rows.map((x) => x.q as string));
}

/** "1-26,31,32,33" -> ["Table 1", ..., "Table 26", "Table 31", ...]. Empty or unset means any table text is accepted. */
export function parseTables(text: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (text ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(part);
    if (m) for (let n = Number(m[1]); n <= Number(m[2]) && n - Number(m[1]) < 500; n++) out.push(`Table ${n}`);
    else if (/^\d{1,3}$/.test(part)) out.push(`Table ${Number(part)}`);
  }
  return [...new Set(out)];
}

/** One at a time, so two customers with the same phone digits cannot both be given the same number. */
let numbering: Promise<unknown> = Promise.resolve();
const serially = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = numbering.then(fn, fn);
  numbering = run.catch(() => undefined);
  return run;
};

/** Strip control characters and cap length: customer text ends up on staff screens and printers. */
const clean = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || undefined;
};

export function registerShop(app: FastifyInstance, d: ShopDeps) {
  const merchantId = d.config.businessId;
  const integ: Integrations = d.integrations ?? { publicUrl: "" };
  const showCodes = process.env.NODE_ENV !== "production";
  // Ordering is open to anyone, so it is limited per address: few orders, many status checks.
  const orderLimit = new FailureLimiter(10, 10 * 60_000);
  const readLimit = new FailureLimiter(300, 60_000);
  const limited = (lim: FailureLimiter, req: FastifyRequest, reply: FastifyReply) => {
    if (lim.blocked(req.ip)) {
      void reply.code(429).send({ error: "too_many_requests" });
      return true;
    }
    lim.fail(req.ip); // counts every attempt
    return false;
  };

  const brandPayload = async () => {
    const b = await d.brand.get();
    return {
      primary: b.primary,
      accent: b.accent,
      ink: b.ink,
      logoUrl: b.hasLogo ? `/api/brand/logo?v=${b.logoVersion}` : null,
      heroUrl: b.hasHero ? `/api/brand/hero?v=${b.heroVersion}` : null,
      tagline: b.tagline,
      promoTitle: b.promoTitle,
      promoBody: b.promoBody,
    };
  };

  const tables = parseTables(process.env.SHOP_TABLES);
  // Members only: phone sign-in is the only way in, and every online order is paid from the member's credit.
  const membersOnly = /^(1|true|yes)$/i.test(process.env.SHOP_MEMBERS_ONLY ?? "");
  // TEMPORARY, for one event: anyone who types a member's phone number is let in as that member, with no code. This lets anybody who knows
  // a member's number spend that member's credit, so it is off unless SHOP_OPEN_SIGNIN=1, and must be switched off again afterwards.
  const openSignin = /^(1|true|yes)$/i.test(process.env.SHOP_OPEN_SIGNIN ?? "");
  if (openSignin) console.log("[security] SHOP_OPEN_SIGNIN is ON: phone numbers sign in with no code. Switch it off after the event.");
  if (membersOnly) {
    app.addHook("onRequest", async (req, reply) => {
      if (/^\/api\/shop\/auth\/(email|oauth)\//.test(req.url)) return reply.code(404).send({ error: "not_available" });
    });
  }
  /** The number customers text to sign in: the SIM of a tablet running Rezein right now, else the server's own setting. */
  const smsNumber = async () => (await liveSmsNumber(d.db, merchantId)) ?? integ.sms?.number ?? null;
  /** Everything the ordering page needs to dress itself. Public. */
  app.get("/api/shop/info", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const cat = await d.catalog.load();
    const smsTo = await smsNumber();
    return {
      name: d.config.name,
      outletName: d.config.outletName,
      // Set OUTLET_HOURS (e.g. "Daily 8am-9pm") and OUTLET_PHONE on the server to show them under Help & support.
      contact: process.env.OUTLET_HOURS || process.env.OUTLET_PHONE ? { hours: process.env.OUTLET_HOURS?.trim() || undefined, phone: process.env.OUTLET_PHONE?.trim() || undefined } : undefined,
      paymentTiming: d.config.paymentTiming,
      // With a table list set, ordering is dine-in only, one fixed list of tables.
      tables,
      membersOnly,
      channels: cat.channels.filter((c) => c.active && (!tables.length || c.kind === "dine_in")).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      brand: await brandPayload(),
      // What this deployment can do beyond email sign-in and paying at the counter. The page enables only these.
      auth: { google: !!integ.google && !!d.members, microsoft: !!integ.microsoft && !!d.members, phone: !!d.members && (openSignin ? { number: "", open: true } : smsTo ? { number: smsTo } : membersOnly ? { number: "", manual: true } : showCodes ? { number: "+65 8000 0000", simulated: true } : null) },
      payments: { online: !!integ.stripe, methods: integ.stripe ? ["card", "paynow"] : [] },
    };
  });

  app.get("/api/brand", async () => brandPayload());

  app.get("/api/brand/logo", async (_req, reply) => {
    const logo = await d.brand.getLogo();
    if (!logo) return reply.code(404).send({ error: "no_logo" });
    return reply
      .header("content-type", logo.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "public, max-age=300")
      .send(logo.bytes);
  });

  const manage = { preHandler: d.needs("catalog.manage") };
  app.put<{ Body: { primary?: string; accent?: string } }>("/api/brand", manage, async (req, reply) => {
    const problem = await d.brand.setColors(req.body?.primary ?? "", req.body?.accent ?? "");
    if (problem) return reply.code(400).send({ error: problem });
    await audit(d.db, merchantId, req.staff!.id, "brand.colors", { primary: req.body!.primary, accent: req.body!.accent });
    return brandPayload();
  });
  app.put("/api/brand/logo", manage, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "send the image as image/png, image/jpeg or image/webp" });
    const problem = await d.brand.setLogo(req.body);
    if (problem) return reply.code(400).send({ error: problem });
    await audit(d.db, merchantId, req.staff!.id, "brand.logo", { bytes: req.body.length });
    return brandPayload();
  });

  app.get("/api/brand/hero", async (_req, reply) => {
    const hero = await d.brand.getHero();
    if (!hero) return reply.code(404).send({ error: "no_hero" });
    return reply
      .header("content-type", hero.type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "public, max-age=300")
      .send(hero.bytes);
  });
  app.put("/api/brand/hero", manage, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "send the image as image/png, image/jpeg or image/webp" });
    const problem = await d.brand.setHero(req.body);
    if (problem) return reply.code(400).send({ error: problem });
    await audit(d.db, merchantId, req.staff!.id, "brand.hero", { bytes: req.body.length });
    return brandPayload();
  });
  app.put<{ Body: { tagline?: string; promoTitle?: string; promoBody?: string } }>("/api/brand/content", manage, async (req, reply) => {
    const problem = await d.brand.setContent(req.body ?? {});
    if (problem) return reply.code(400).send({ error: problem });
    await audit(d.db, merchantId, req.staff!.id, "brand.content", { tagline: req.body?.tagline, promoTitle: req.body?.promoTitle });
    return brandPayload();
  });

  /** An item's photo. Public; the URL carries the photo's version, so browsers can keep it for a long time. */
  if (d.catalogAdmin) {
    const images = d.catalogAdmin;
    app.get<{ Params: { id: string } }>("/api/products/:id/image", async (req, reply) => {
      const img = await images.getImage(req.params.id);
      if (!img) return reply.code(404).send({ error: "no_photo" });
      return reply
        .header("content-type", img.type)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "public, max-age=86400")
        .send(img.bytes);
    });
  }

  // ---- customer accounts --------------------------------------------------------------------

  const bearer = (req: FastifyRequest) => (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
  const authLimit = new FailureLimiter(10, 10 * 60_000);
  const members = d.members;

  if (members) {
    /** Step 1: ask for a sign-in code. Same answer whether or not the email has an account. */
    app.post<{ Body: { email?: string } }>("/api/shop/auth/email/start", async (req, reply) => {
      if (limited(authLimit, req, reply)) return;
      const email = normaliseEmail(req.body?.email);
      if (!email) return reply.code(400).send({ error: "email looks wrong" });
      const code = await members.startEmail(email);
      // With mail set up the code is emailed. Without it the code goes to the server log (and to the caller outside production).
      const mailed = await sendMail(integ, { to: email, subject: `${code} is your ${d.config.name} sign-in code`, text: `Your sign-in code is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this email.\n\n${d.config.name}` });
      if (!mailed) console.log(`[sign-in code] ${email}: ${code}`);
      // Once real mail is set up the code is never handed back to the page, even outside production.
      return { sent: true, ...(showCodes && !integ.mail ? { devCode: code } : {}) };
    });

    /** Step 2: trade the code for a session. A new email becomes a new member and gets the welcome points once. */
    app.post<{ Body: { email?: string; code?: string; name?: string } }>("/api/shop/auth/email/verify", async (req, reply) => {
      if (limited(authLimit, req, reply)) return;
      const email = normaliseEmail(req.body?.email);
      const code = String(req.body?.code ?? "").replace(/\D/g, "");
      if (!email || code.length !== 6) return reply.code(400).send({ error: "email and a 6-digit code are required" });
      const r = await members.verifyEmail(email, code, clean(req.body?.name, 40));
      if (!r) return reply.code(401).send({ error: "wrong_or_expired_code" });
      return { token: r.token, created: r.created, member: r.member };
    });

    app.get("/api/shop/me", async (req, reply) => {
      const m = await members.fromToken(bearer(req));
      if (!m) return reply.code(401).send({ error: "not_signed_in" });
      return { member: m, creditCents: await balanceOf(d.db, merchantId, m.id), history: await members.history(m.id, 20), coupons: await members.coupons(m.id), stamps: d.config.rewards.stampCard.enabled ? { ...(await members.stamps(m.id)), target: d.config.rewards.stampCard.target, rewardTitle: d.config.rewards.stampCard.rewardTitle, minPaidCents: d.config.rewards.stampCard.minPaidCents } : null, pointsEnabled: d.config.rewards.pointsEnabled };
    });

    app.post("/api/shop/auth/logout", async (req) => {
      const t = bearer(req);
      if (t) await members.logout(t);
      return { ok: true };
    });

    app.patch<{ Body: { name?: string; phone?: string; orderUpdates?: boolean; promos?: boolean } }>("/api/shop/me", async (req, reply) => {
      const m = await members.fromToken(bearer(req));
      if (!m) return reply.code(401).send({ error: "not_signed_in" });
      await members.updateProfile(m.id, { name: clean(req.body?.name, 40), phone: clean(req.body?.phone, 20), orderUpdates: req.body?.orderUpdates, promos: req.body?.promos });
      return { member: await members.byId(m.id) };
    });
  }

  if (members) {
    // ---- Google and Microsoft ----------------------------------------------------------------------
    const oauthLimit = new FailureLimiter(30, 10 * 60_000);
    const back = (q: string) => `${integ.publicUrl}/#/shop?${q}`;

    /** Send the browser to the provider's sign-in page. */
    app.get<{ Params: { provider: string } }>("/api/shop/auth/oauth/:provider/start", async (req, reply) => {
      if (limited(oauthLimit, req, reply)) return;
      const p = req.params.provider as OAuthProvider;
      if ((p !== "google" && p !== "microsoft") || !integ[p]) return reply.code(404).send({ error: "provider_not_available" });
      const state = newState();
      const verifier = newVerifier();
      await members.saveOAuthState(state, p, verifier);
      return reply.redirect(authorizeUrl(integ, p, state, verifier));
    });

    /** The provider sends the person back here. We trade the code, then hand the browser a one-time ticket. */
    app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>("/api/shop/auth/oauth/:provider/callback", async (req, reply) => {
      const p = req.params.provider as OAuthProvider;
      if ((p !== "google" && p !== "microsoft") || !integ[p]) return reply.code(404).send({ error: "provider_not_available" });
      const { code, state, error } = req.query;
      if (error || !code || !state) return reply.redirect(back("login_error=cancelled"));
      const verifier = await members.takeOAuthState(state, p);
      if (!verifier) return reply.redirect(back("login_error=expired"));
      const profile = await fetchProfile(integ, p, code, verifier);
      if (!profile) return reply.redirect(back("login_error=failed"));
      const r = await members.signInWithIdentity(p, profile.subject, { email: profile.email, emailVerified: profile.emailVerified, name: profile.name });
      return reply.redirect(back(`ticket=${await members.issueTicket(r.member.id)}`));
    });

    /** The page trades its ticket for a session. Works once, within two minutes. */
    app.post<{ Body: { ticket?: string } }>("/api/shop/auth/ticket", async (req, reply) => {
      if (limited(authLimit, req, reply)) return;
      const r = await members.redeemTicket(String(req.body?.ticket ?? ""));
      if (!r) return reply.code(401).send({ error: "ticket_invalid" });
      return r;
    });

    // ---- phone number, "reverse SMS": the customer texts us a code --------------------------------
    const SMS_SECONDS = 300;
    const digitsOf = (s: unknown) => String(s ?? "").replace(/\D/g, "");

    app.post<{ Body: { phone?: string } }>("/api/shop/auth/phone/open", async (req, reply) => {
      if (!openSignin) return reply.code(404).send({ error: "not_available" });
      if (limited(authLimit, req, reply)) return;
      const phone = digitsOf(req.body?.phone);
      if (phone.length < 8 || phone.length > 15) return reply.code(400).send({ error: "phone number looks wrong" });
      const r = await members.signInWithIdentity("phone", phone, { phone: `+${phone}` });
      console.log(`[open sign-in] +${phone.slice(0, 4)}…${phone.slice(-2)} from ${req.ip} (${r.created ? "new member" : "existing member"})`);
      return { token: r.token, member: r.member, created: r.created };
    });

    app.post<{ Body: { phone?: string } }>("/api/shop/auth/phone/start", async (req, reply) => {
      if (limited(authLimit, req, reply)) return;
      const smsTo = await smsNumber();
      if (!smsTo && !showCodes && !membersOnly) return reply.code(404).send({ error: "provider_not_available" });
      const phone = digitsOf(req.body?.phone);
      if (phone.length < 8 || phone.length > 15) return reply.code(400).send({ error: "phone number looks wrong" });
      const c = await members.startSms(phone, SMS_SECONDS);
      return { id: c.id, code: c.code, to: smsTo ?? (membersOnly ? null : "+65 8000 0000"), expiresInSeconds: SMS_SECONDS };
    });

    /** The customer's browser asks whether the text has arrived. The session is handed over once. */
    const statusLimit = new FailureLimiter(600, 10 * 60_000);
    app.get<{ Params: { id: string } }>("/api/shop/auth/phone/:id", async (req, reply) => {
      if (limited(statusLimit, req, reply)) return;
      const st = await members.smsStatus(req.params.id);
      if (!st) return reply.code(404).send({ error: "not_found" });
      if (st.state !== "verified") return { state: st.state, secondsLeft: st.secondsLeft };
      const phone = await members.claimSms(req.params.id);
      if (!phone) return reply.code(410).send({ error: "already_used" });
      const r = await members.signInWithIdentity("phone", phone, { phone: `+${phone}` });
      return { state: "verified", token: r.token, member: r.member, created: r.created };
    });

    /**
     * The SMS provider calls this for every text sent to our number (Twilio form fields From and Body).
     * It presents a secret in the address; without it nothing is accepted.
     */
    app.register(async (scope) => {
      scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
      scope.post<{ Querystring: { secret?: string }; Body: { From?: string; Body?: string } }>("/api/shop/auth/phone/inbound", async (req, reply) => {
        if (!integ.sms || !integ.sms.webhookSecret || !sameSecret(String(req.query.secret ?? ""), integ.sms.webhookSecret)) return reply.code(403).send({ error: "forbidden" });
        const from = digitsOf(req.body?.From);
        const ok = from.length >= 8 && (await members.matchSms(from, String(req.body?.Body ?? "")));
        if (ok) console.log(`[sms sign-in] verified ${from.slice(0, 4)}…`);
        return reply.type("text/xml").send("<Response/>");
      });
    });

    /** Development only: stand in for the text arriving, so the whole flow can be tried without an SMS provider. */
    if (showCodes) {
      app.post<{ Body: { phone?: string; code?: string } }>("/api/shop/auth/phone/simulate", async (req, reply) => {
        const ok = await members.matchSms(digitsOf(req.body?.phone), String(req.body?.code ?? ""));
        return ok ? { ok: true } : reply.code(404).send({ error: "no_open_challenge" });
      });
    }

    /** The signed-in customer's own orders, newest first. */
    app.get("/api/shop/me/orders", async (req, reply) => {
      const m = await members.fromToken(bearer(req));
      if (!m) return reply.code(401).send({ error: "not_signed_in" });
      const out = [];
      for (const { orderId, at } of await members.orderIds(m.id, 20)) {
        const o = reduceOrder(orderId, await d.store.eventsForOrder(orderId));
        if (!o) continue;
        out.push({ orderId, at, queueNumber: o.queueNumber, status: shopStatus(o, d.config), channelName: o.channelName, itemCount: o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0), totalCents: orderTotals(o, d.config).total });
      }
      return { orders: out };
    });
  }

  interface OrderBody {
    channelId?: string;
    items?: Array<{ productId?: string; qty?: number; options?: Array<{ groupId?: string; choiceId?: string; qty?: number }> }>;
    customerName?: string;
    customerPhone?: string;
    spot?: string;
    /** The total the customer was shown. If prices moved since, they are told before anything is placed. */
    expectedTotalCents?: number;
    /** Points to spend: a number, or "max". Needs a signed-in member. */
    usePoints?: number | "max";
    /** A coupon from the member's wallet. Needs a signed-in member. */
    couponId?: string;
    /** Pay the whole order from the member's prepaid credit. Needs a signed-in member. The order is then paid and accepted at once. */
    payWithCredit?: boolean;
    /** Made by the phone for this checkout attempt; required with credit. A retry with the same key never debits twice. */
    idempotencyKey?: string;
  }

  /** A customer places an order. Held for staff to accept; nothing reaches the kitchen yet. */
  app.post<{ Body: OrderBody }>("/api/shop/orders", async (req, reply) => {
    if (limited(orderLimit, req, reply)) return;
    const b = req.body ?? {};
    if (typeof b.channelId !== "string" || !Array.isArray(b.items)) return reply.code(400).send({ error: "channelId and items are required" });
    const items = b.items.map((i) => ({
      productId: String(i?.productId ?? ""),
      qty: Number(i?.qty),
      // Only ids and counts are read; any name or price a client sends here is ignored.
      options: (Array.isArray(i?.options) ? i.options.slice(0, 40) : []).map((o) => ({ groupId: String(o?.groupId ?? ""), choiceId: String(o?.choiceId ?? ""), qty: o?.qty === undefined ? undefined : Number(o.qty) })),
    }));

    // Dine-in only, at one of the shop's own tables, when a table list is set.
    let table: string | undefined;
    if (tables.length) {
      const wanted = String(b.spot ?? "").trim().replace(/^table\s*/i, "");
      table = tables.find((x) => x === `Table ${Number(wanted)}`);
      if (!/^\d{1,3}$/.test(wanted) || !table) return reply.code(400).send({ error: "choose your table" });
    }
    const phone = clean(b.customerPhone, 20);
    if (phone && !/^[+\d][\d\s-]{5,19}$/.test(phone)) return reply.code(400).send({ error: "phone number looks wrong" });

    const cat = await d.catalog.load();
    const member = members ? await members.fromToken(bearer(req)) : null;
    if (membersOnly) {
      if (!member) return reply.code(401).send({ error: "sign_in_to_order" });
      if (!b.payWithCredit) return reply.code(400).send({ error: "pay_with_credit" });
    }
    let pointsAsk: { balance: number; requested: number | null } | null = null;
    if (b.usePoints !== undefined && b.usePoints !== 0) {
      if (!member || !d.config.rewards.pointsEnabled) return reply.code(401).send({ error: "sign_in_to_use_points" });
      if (b.usePoints !== "max" && (!Number.isInteger(b.usePoints) || b.usePoints < d.config.pricing.minPointsRedeem)) return reply.code(400).send({ error: "points_too_low", min: d.config.pricing.minPointsRedeem });
      pointsAsk = { balance: member.pointsBalance, requested: b.usePoints === "max" ? null : (b.usePoints as number) };
    }
    let coupon: Awaited<ReturnType<MemberStore["coupon"]>> = null;
    if (b.couponId !== undefined && b.couponId !== "") {
      if (!member) return reply.code(401).send({ error: "sign_in_to_use_coupons" });
      coupon = await members!.coupon(member.id, String(b.couponId));
      if (!coupon) return reply.code(400).send({ error: "coupon_not_available" });
    }
    if (tables.length && cat.channels.find((c) => c.id === b.channelId)?.kind !== "dine_in") return reply.code(400).send({ error: "this shop takes dine-in orders only" });
    const quote = quoteOrder(cat, d.config, { outletId: d.config.outletName, channelId: b.channelId }, items, pointsAsk, coupon ? { amountCents: coupon.amountCents, minSpendCents: coupon.minSpendCents } : null);
    if (!quote.ok) return reply.code(400).send({ error: quote.error, productId: quote.productId });
    if (b.expectedTotalCents !== undefined && b.expectedTotalCents !== quote.priced.total) {
      return reply.code(409).send({ error: "price_changed", totalCents: quote.priced.total });
    }

    // The minimum spend is on the items subtotal only (before service charge, tax and deposits).
    if (coupon && quote.priced.couponIneligible) return reply.code(400).send({ error: "coupon_not_eligible", shortfallCents: coupon.minSpendCents - quote.priced.subtotal });
    if (b.payWithCredit && !member) return reply.code(401).send({ error: "sign_in_to_use_credit" });
    let orderId = newId();

    // A credit purchase carries an idempotency key made by the customer's phone for this attempt. A retry (double tap,
    // timeout, refresh) with the same key gets the first result back and never a second debit; the same key with
    // different content is refused. Without one, a credit purchase is not accepted.
    let idemKey: string | null = null;
    if (b.payWithCredit && member) {
      const key = String(b.idempotencyKey ?? "");
      if (!/^[\w-]{8,64}$/.test(key)) return reply.code(400).send({ error: "idempotency_key_required" });
      const hash = createHash("sha256").update(JSON.stringify({ m: member.id, c: b.channelId, i: items.map((x) => [x.productId, x.qty, x.options]), s: table ?? clean(b.spot, 30) ?? null, p: b.usePoints ?? null, k: b.couponId ?? null })).digest("hex");
      const ins = await d.db.query("INSERT INTO purchase_requests (merchant_id, idem_key, request_hash, member_id, order_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [merchantId, key, hash, member.id, orderId]);
      if (!ins.rowCount) {
        const ex = (await d.db.query("SELECT * FROM purchase_requests WHERE merchant_id=$1 AND idem_key=$2", [merchantId, key])).rows[0];
        if (ex.request_hash !== hash || ex.member_id !== member.id) return reply.code(409).send({ error: "idempotency_key_reused" });
        if (ex.state === "done") return { ...(ex.result as object), replayed: true };
        if (Date.now() - new Date(ex.created_at).getTime() < 120_000) return reply.code(409).send({ error: "purchase_in_progress", orderId: ex.order_id });
        // An attempt that never finished. If its order exists, hand that back; if not, undo any debit and start over with a new order id.
        if ((await d.store.eventsForOrder(ex.order_id)).length > 0) {
          const o = reduceOrder(ex.order_id, await d.store.eventsForOrder(ex.order_id))!;
          const result = { orderId: o.orderId, queueNumber: o.queueNumber, totalCents: orderTotals(o, d.config).total, recovered: true };
          await d.db.query("UPDATE purchase_requests SET state='done', result=$3 WHERE merchant_id=$1 AND idem_key=$2", [merchantId, key, JSON.stringify(result)]);
          return result;
        }
        await reverseUnfinishedDebit(ex.order_id);
        await d.db.query("UPDATE purchase_requests SET order_id=$3, created_at=now() WHERE merchant_id=$1 AND idem_key=$2", [merchantId, key, orderId]);
      }
      idemKey = key;
    }

    const dropAttempt = () => (idemKey ? d.db.query("DELETE FROM purchase_requests WHERE merchant_id=$1 AND idem_key=$2 AND state='pending'", [merchantId, idemKey]) : Promise.resolve());
    let out: unknown;
    try {
    out = await serially(async () => {
    const taken = await activeQueueNumbers(d.db, merchantId);
    const queueNumber = collectionNumber(phone, taken) ?? (await nextOnlineNumber(d.db, merchantId));
    const ts = Date.now();
    // Credit first: if it is short, nothing else has been touched. Taken in one step that cannot go below zero.
    const creditCents = b.payWithCredit && member ? quote.priced.total : 0;
    if (creditCents > 0) {
      const paid = await spendCredit(d.db, { merchantId, customerId: member!.id, amountCents: creditCents, idempotencyKey: `credit-order:${orderId}`, orderId, deviceId: SHOP_DEVICE, outletId: d.config.outletName, note: "Order paid with credit" });
      if (!paid.ok) return reply.code(409).send({ error: "not_enough_credit", balanceCents: paid.balanceCents, neededCents: creditCents });
    }
    const giveCreditBack = () => (creditCents > 0 ? refundCredit(d.db, { merchantId, customerId: member!.id, amountCents: creditCents, idempotencyKey: `credit-back:${orderId}`, orderId, deviceId: SHOP_DEVICE, outletId: d.config.outletName, note: "Order not placed" }) : Promise.resolve());
    const pointsUsed = quote.priced.pointsUsed;
    if (member && pointsUsed > 0) {
      // Spent before the order exists, atomically: two orders cannot spend the same points.
      const spent = await members!.post(member.id, "redeem", -pointsUsed, `redeem:${orderId}`, { orderId });
      if (!spent) { await giveCreditBack(); return reply.code(409).send({ error: "not_enough_points", balance: (await members!.byId(member.id))?.pointsBalance ?? 0 }); }
    }
    const couponUsed = !!coupon && quote.priced.couponDiscount > 0;
    if (member && coupon && couponUsed && !(await members!.useCoupon(member.id, coupon.id, orderId))) {
      if (pointsUsed > 0) await members!.post(member.id, "refund", pointsUsed, `refund:${orderId}`, { orderId });
      await giveCreditBack();
      return reply.code(409).send({ error: "coupon_not_available" });
    }
    if (member) await members!.linkOrder(orderId, member.id, pointsUsed);
    let seq = 0;
    const mk = <T extends object>(extra: T) => ({ id: newId(), orderId, deviceId: SHOP_DEVICE, ts, seq: ++seq, ...extra }) as unknown as OrderEvent;
    const events: OrderEvent[] = [
      mk({
        type: "OrderOpened",
        fulfilment: quote.fulfilment,
        channelId: quote.channel.id,
        channelName: quote.channel.name,
        serviceCharge: quote.channel.serviceCharge,
        source: "online",
        customerName: clean(b.customerName, 40) ?? member?.name ?? undefined,
        customerPhone: phone ?? member?.phone ?? undefined,
        memberId: member?.id,
        spot: quote.channel.kind === "dine_in" ? table ?? clean(b.spot, 30)?.replace(/[^\w #-]/g, "") : undefined,
        queueNumber,
      }),
      ...(couponUsed ? [mk({ type: "CouponApplied", title: coupon!.title, amountCents: coupon!.amountCents, minSpendCents: coupon!.minSpendCents })] : []),
      ...(pointsUsed > 0 ? [mk({ type: "PointsRedeemed", points: pointsUsed })] : []),
      ...quote.lines.map((l) => mk({ type: "ItemAdded", lineId: newId(), productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty, pointsExempt: l.pointsExempt, options: l.options.length ? l.options : undefined })),
      // Paid with the member's credit: the order is paid and accepted at once, so it goes straight to the kitchen.
      ...(creditCents > 0 ? [mk({ type: "OrderAccepted" }), mk({ type: "PaymentRecorded", paymentId: `credit:${orderId}`, method: "credit", amountCents: creditCents, confirmed: true })] : []),
    ];
    try {
      await d.ingest(events);
    } catch (err) {
      await giveCreditBack(); // the order was not recorded, so the customer keeps their credit
      throw err;
    }
    return { orderId, queueNumber, totalCents: quote.priced.total, pointsUsed, couponDiscountCents: quote.priced.couponDiscount, paidWithCreditCents: creditCents, creditBalanceCents: member ? await balanceOf(d.db, merchantId, member.id) : undefined, status: creditCents > 0 ? "queued" : "received" };
    });
    } catch (e) {
      await dropAttempt();
      throw e;
    }
    if (idemKey) {
      if (reply.statusCode >= 400) await dropAttempt();
      else await d.db.query("UPDATE purchase_requests SET state='done', result=$3 WHERE merchant_id=$1 AND idem_key=$2", [merchantId, idemKey, JSON.stringify(out)]);
    }
    return out;
  });

  /** After a timeout the phone asks what became of its attempt, by key. Only the member who made it can ask. */
  if (members) {
    app.get<{ Params: { key: string } }>("/api/shop/purchases/:key", async (req, reply) => {
      const m = await members.fromToken(bearer(req));
      if (!m) return reply.code(401).send({ error: "not_signed_in" });
      const r = (await d.db.query("SELECT state, order_id, result, member_id FROM purchase_requests WHERE merchant_id=$1 AND idem_key=$2", [merchantId, req.params.key])).rows[0];
      if (!r || r.member_id !== m.id) return reply.code(404).send({ error: "not_found" });
      return { state: r.state, orderId: r.order_id, result: r.result ?? null };
    });
  }

  /** Give back a debit whose order never got recorded. Safe to call twice: the credit-back has one fixed key per order. */
  async function reverseUnfinishedDebit(orderId: string) {
    const r = await d.db.query(
      `SELECT w.customer_id, -e.amount_cents AS cents FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id
       WHERE w.merchant_id=$1 AND e.kind='spend' AND e.idempotency_key=$2`,
      [merchantId, `credit-order:${orderId}`],
    );
    for (const row of r.rows) {
      await refundCredit(d.db, { merchantId, customerId: row.customer_id as string, amountCents: Number(row.cents), idempotencyKey: `credit-back:${orderId}`, orderId, deviceId: SHOP_DEVICE, outletId: d.config.outletName, note: "Order was never recorded: debit reversed" });
    }
  }

  /** A debit with no order behind it (the server stopped between the two steps) is reversed after two minutes. */
  async function sweepOrphanDebits() {
    const r = await d.db.query(
      `SELECT e.order_id FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id
       WHERE w.merchant_id=$1 AND e.kind='spend' AND e.idempotency_key LIKE 'credit-order:%' AND e.created_at < now() - interval '2 minutes'
         AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.wallet_id=e.wallet_id AND r.idempotency_key = 'credit-back:' || e.order_id)
         AND NOT EXISTS (SELECT 1 FROM events ev WHERE ev.merchant_id=$1 AND ev.order_id = e.order_id)`,
      [merchantId],
    );
    for (const row of r.rows) {
      await reverseUnfinishedDebit(row.order_id as string);
      console.log(`[credit] reversed a debit with no order: ${row.order_id}`);
    }
    return r.rowCount ?? 0;
  }
  void sweepOrphanDebits().catch(() => undefined);
  const sweeper = setInterval(() => void sweepOrphanDebits().catch(() => undefined), 5 * 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));

  /** Status for the customer. The order id is a long random value, so only whoever placed it has it. */
  app.get<{ Params: { id: string } }>("/api/shop/orders/:id", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const order = reduceOrder(req.params.id, await d.store.eventsForOrder(req.params.id));
    if (!order || order.source !== "online") return reply.code(404).send({ error: "order_not_found" });
    const total = orderTotals(order, d.config).total;
    const paid = order.payments.filter((p) => p.confirmed).reduce((n, p) => n + p.amountCents, 0);
    return {
      orderId: order.orderId,
      queueNumber: order.queueNumber,
      status: shopStatus(order, d.config),
      channelName: order.channelName,
      items: order.lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, qty: l.qty, unitCents: l.unitCents, options: optionLines(l.options) })),
      totalCents: total,
      paidCents: paid,
      pointsRedeemed: order.pointsRedeemed ?? 0,
      canCancel: cancellable(order),
      canPayOnline: !!integ.stripe && order.stage !== "cancelled" && order.stage !== "completed" && total - paid > 0,
    };
  });

  /** A customer may call off an order that nothing has been paid on and the kitchen has not started. */
  const cancellable = (o: ReturnType<typeof reduceOrder>) => !!o && o.source === "online" && o.stage === "open" && confirmedPaid(o) === 0;

  app.post<{ Params: { id: string } }>("/api/shop/orders/:id/cancel", async (req, reply) => {
    if (limited(orderLimit, req, reply)) return;
    const order = reduceOrder(req.params.id, await d.store.eventsForOrder(req.params.id));
    if (!order || order.source !== "online") return reply.code(404).send({ error: "order_not_found" });
    if (order.stage === "cancelled") return { status: "cancelled" };
    if (!cancellable(order)) return reply.code(409).send({ error: "cannot_cancel" });
    // A fixed id: pressing twice, or a retry, cancels once.
    await d.ingest([{ id: `shop-cancel-${order.orderId}`, orderId: order.orderId, deviceId: SHOP_DEVICE, ts: Date.now(), seq: Date.now(), type: "StageSet", stage: "cancelled" } as unknown as OrderEvent]);
    return { status: "cancelled" };
  });

  // ---- online payment (Stripe: card and PayNow) -----------------------------------------------------

  /** Start a payment for what is still owed on an order. The customer is sent to the hosted payment page. */
  app.post<{ Params: { id: string }; Body: { method?: string } }>("/api/shop/orders/:id/pay", async (req, reply) => {
    if (limited(orderLimit, req, reply)) return;
    if (!integ.stripe) return reply.code(404).send({ error: "online_payment_not_available" });
    const method = req.body?.method;
    if (method !== "card" && method !== "paynow") return reply.code(400).send({ error: "method must be card or paynow" });
    const order = reduceOrder(req.params.id, await d.store.eventsForOrder(req.params.id));
    if (!order || order.source !== "online") return reply.code(404).send({ error: "order_not_found" });
    if (order.stage === "cancelled" || order.stage === "completed") return reply.code(409).send({ error: "order_closed" });
    const due = orderTotals(order, d.config).total - confirmedPaid(order);
    if (due <= 0) return reply.code(409).send({ error: "already_paid" });
    const s = await createStripeCheckout(integ, { orderId: order.orderId, queueNumber: order.queueNumber ?? "", amountCents: due, method, returnUrl: `${integ.publicUrl}/#/shop/order/${order.orderId}`, description: `${d.config.name} order ${order.queueNumber ?? ""}`.trim() });
    if (!s) return reply.code(502).send({ error: "payment_provider_unavailable" });
    return { url: s.url };
  });

  /** Stripe tells us a payment went through. Only a correctly signed message for the right amount is believed. */
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_r, body, done) => done(null, body));
    scope.post("/api/shop/stripe/webhook", async (req, reply) => {
      if (!integ.stripe) return reply.code(404).send({ error: "online_payment_not_available" });
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, integ.stripe.webhookSecret)) return reply.code(400).send({ error: "bad_signature" });
      let ev: { type?: string; data?: { object?: { id?: string; payment_intent?: string; payment_status?: string; amount_total?: number; currency?: string; client_reference_id?: string; metadata?: { method?: string } } } };
      try { ev = JSON.parse(raw.toString("utf8")); } catch { return reply.code(400).send({ error: "bad_body" }); }
      const obj = ev.data?.object;
      if ((ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") && obj?.id && obj.payment_status === "paid" && obj.client_reference_id) {
        const order = reduceOrder(obj.client_reference_id, await d.store.eventsForOrder(obj.client_reference_id));
        const due = order ? orderTotals(order, d.config).total - confirmedPaid(order) : 0;
        const method = obj.metadata?.method === "paynow" ? "paynow" : "card";
        if (order?.payments.some((p) => p.paymentId === `stripe:${obj.id}`)) return { received: true }; // already recorded; Stripe repeats itself
        if (!order || order.source !== "online" || order.stage === "cancelled" || obj.currency !== "sgd" || obj.amount_total !== due) {
          // Money moved but it does not fit the order (cancelled, already paid, or the amount changed): nothing is
          // recorded and the payment is given back in full. If that fails, a person has to look.
          const back = obj.payment_intent ? await createStripeRefund(integ, { paymentIntent: obj.payment_intent, key: `refund-${obj.id}` }) : false;
          console.error(`[stripe] payment ${obj.id} for order ${obj.client_reference_id} not applied (amount ${obj.amount_total} ${obj.currency}, due ${due}); ${back ? "refunded" : "REFUND FAILED - refund it by hand in Stripe"}`);
        } else {
          // A fixed id per payment: Stripe may send the same message more than once.
          await d.ingest([{ id: `stripe-${obj.id}`, orderId: order.orderId, deviceId: SHOP_DEVICE, ts: Date.now(), seq: Date.now(), type: "PaymentRecorded", paymentId: `stripe:${obj.id}`, method, amountCents: obj.amount_total!, confirmed: true } as unknown as OrderEvent]);
        }
      }
      return { received: true };
    });
  });
}
