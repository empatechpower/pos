import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applyOutletMenu, applyStockToMenu, orderConsumption, shortfalls, availabilityOf, menuFor, priceBuild, hasBuilder, type BuildInput, type StoredBuild, isValidSlot, pickupSlots, localParts, lastBoundaryAt, menuState, cleanNote, collectionNumber, confirmedPaid, newId, optionLines, orderTotals, totalsLines, queueView, quoteOrder, reduceAll, reduceOrder, shopStatus, type BusinessConfig, type OrderEvent, type OrderState } from "@pos/core";
import { audit, type Permission } from "./auth.js";
import type { BrandStore } from "./brand.js";
import type { CatalogStore, PgCatalogStore } from "./catalog.js";
import { liveSmsNumber } from "./devices.js";
import type { Db } from "./db/pool.js";
import { balanceOf, creditBlockedFor, creditFrozen, refund as refundCredit, spend as spendCredit } from "./ledger.js";
import { FailureLimiter } from "./rateLimit.js";
import { itemNames, onHandAt, stockVersion } from "./stock.js";
import { TabError, type TabService } from "./tabs.js";
import { PROMO_BASIS, claimPromo, judgePromo, promoStacksWithCoupons, releasePromo, type PromoVerdict } from "./promo.js";
import { normaliseEmail, type MemberStore } from "./members.js";
import { authorizeUrl, createStripeCheckout, createStripeRefund, fetchProfile, sendMail, newState, newVerifier, sameSecret, verifyStripeSignature, type Integrations, type OAuthProvider } from "./integrations.js";
import type { EventStore } from "./store.js";
import { loadOutletMenu, loadOutletScheduling, loadOutletWindows } from "./outletMenu.js";
import { loadKiosk } from "./settings.js";
import { listOutlets } from "./tenant.js";
import { createHash, randomBytes } from "node:crypto";

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
  ingest: (events: OrderEvent[], outletId?: string) => Promise<unknown>;
  /** Customer accounts and points (needs a database). */
  members?: MemberStore;
  needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** Google / Microsoft / SMS / Stripe settings. Any that are missing simply switch that feature off. */
  integrations?: Integrations;
  /** The clock (epoch ms); tests set it. */
  now?: () => number;
  /** Tabs for table service: a round is an order that joins a table's shared tab. */
  tabs?: TabService;
}

/** Only ids and counts are read from a client's build; names, prices and rules come from the menu. */
function cleanBuild(raw: unknown): BuildInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { variantId?: unknown; picks?: unknown };
  const picks = (Array.isArray(r.picks) ? r.picks.slice(0, 60) : []).map((p: any) => ({ groupId: String(p?.groupId ?? ""), optionId: String(p?.optionId ?? ""), ...(p?.qty === undefined ? {} : { qty: Number(p.qty) }) }));
  return { ...(typeof r.variantId === "string" && r.variantId ? { variantId: r.variantId } : {}), picks };
}

const MAX_QTY_LINE = 20;
const singaporeDay = (now = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(now);

/** 101, 102… restarting each day (the kiosk handover's collection number, K9: a plain number, no prefix). Atomic, so two customers ordering together never share a number. */
async function nextOnlineNumber(db: Db, merchantId: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO counters (merchant_id, name, day, value) VALUES ($1,'online',$2,1)
     ON CONFLICT (merchant_id, name, day) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [merchantId, singaporeDay()],
  );
  return String(100 + Number(r.rows[0].value));
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
  // Ordering is open to anyone, so it is limited. Many customers share one public address (the venue's Wi-Fi), so a signed-in member
  // is counted on their own, and an address only has a high ceiling for guests. All of these can be set on the server (see below).
  const envNum = (name: string, fallback: number) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
  const orderWindowMs = envNum("ORDER_LIMIT_WINDOW_MIN", 10) * 60_000;
  const orderLimitMember = new FailureLimiter(envNum("ORDER_LIMIT_MEMBER", 60), orderWindowMs); // orders per member per window
  const orderLimitIp = new FailureLimiter(envNum("ORDER_LIMIT_IP", 200), orderWindowMs); // orders per address per window, for guests
  const readLimit = new FailureLimiter(envNum("READ_LIMIT_PER_MIN", 1500), 60_000); // order status and menu reads, per address
  const limited = (lim: FailureLimiter, req: FastifyRequest, reply: FastifyReply, key: string = req.ip) => {
    if (lim.blocked(key)) {
      void reply.code(429).send({ error: "too_many_requests" });
      return true;
    }
    lim.fail(key); // counts every attempt
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
  /**
   * Which outlet a customer is ordering from: the one in the link (?outlet=B1, or outletId in the order) when it is a real, open
   * outlet of this brand; otherwise the original outlet. A made-up or closed outlet quietly falls back, so a bad link still works.
   */
  const outletFor = async (asked: unknown): Promise<{ id: string; name: string; hours?: string; phone?: string; address?: string; mode: "qsr" | "tsr"; chosen: boolean; prepMinutes: number | null }> => {
    const all = await listOutlets(d.db, merchantId);
    const want = typeof asked === "string" && asked ? all.find((o) => o.id === asked && o.active) : undefined;
    const o = want ?? all.find((x) => x.id === d.config.outletName);
    // Quick service (no table) or table service (a table is required). Until an outlet is set, a table list on the server means table service.
    return { id: o?.id ?? d.config.outletName, name: o?.name ?? d.config.outletName, hours: o?.hours?.trim() || undefined, phone: o?.phone?.trim() || undefined, address: o?.address?.trim() || undefined, mode: o?.serviceMode ?? (tables.length ? "tsr" : "qsr"), chosen: !!o?.serviceMode, prepMinutes: o?.prepMinutes ?? null };
  };
  /** The outlet an existing order belongs to. */
  const outletOfOrder = async (orderId: string) => (await d.store.outletOfOrder?.(orderId)) ?? d.config.outletName;
  /** The outlets a customer can order from, with what they need before choosing: contact, hours, how long an order takes, a directions link. Public. */
  app.get("/api/shop/stores", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const all = (await listOutlets(d.db, merchantId)).filter((o) => o.active);
    const nowMs = (d.now ?? Date.now)();
    const wins = await Promise.all(all.map((o) => loadOutletWindows(d.db, merchantId, o.id)));
    return {
      stores: all.map((o, i) => ({
        menu: menuState(wins[i]!.windows, nowMs, wins[i]!.timeZone),
        id: o.id,
        name: o.name,
        address: o.address ?? undefined,
        phone: o.phone ?? undefined,
        hours: o.hours ?? undefined,
        prepMinutes: o.prepMinutes,
        latitude: o.latitude,
        longitude: o.longitude,
        directionsUrl: o.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}` : undefined,
      })),
    };
  });

  /** The menu as one outlet sells it (same shape as the brand's catalogue), with that outlet's prep time and a version that rises when anything on it changes. Public. */
  const menuOf = async (asked: unknown) => {
    const outlet = (await listOutlets(d.db, merchantId)).find((o) => o.id === (typeof asked === "string" && asked ? asked : d.config.outletName) && o.active);
    const id = outlet?.id ?? d.config.outletName;
    const now = (d.now ?? Date.now)();
    const [c, o, w] = await Promise.all([d.catalog.load(), loadOutletMenu(d.db, merchantId, id), loadOutletWindows(d.db, merchantId, id)]);
    const applied = applyStockToMenu(applyOutletMenu(c, o.menu), await onHandAt(d.db, merchantId, id));
    // Every item carries its one state (orderable, available later with the next opening, sold out). The version also moves at each window boundary,
    // so a phone that keeps asking "has the menu changed?" sees an item flip with nothing to reload by hand.
    const catalog = { ...applied, products: applied.products.map((p) => ({ ...p, availability: availabilityOf(p, w.windows, now, w.timeZone) })) };
    const menuVersion = c.version + o.version + (await stockVersion(d.db, merchantId, id)) + Math.floor(lastBoundaryAt(w.windows, now, w.timeZone) / 60_000);
    return { outletId: id, prepMinutes: outlet?.prepMinutes ?? null, menuVersion, menuState: menuState(w.windows, now, w.timeZone), timeZone: w.timeZone, serverTime: now, catalog };
  };
  app.get<{ Querystring: { outlet?: string } }>("/api/shop/menu", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const m = await menuOf(req.query.outlet);
    const etag = `"m${m.outletId}-${m.menuVersion}"`;
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.header("etag", etag).header("cache-control", "no-cache").send({ ...m.catalog, outletId: m.outletId, prepMinutes: m.prepMinutes, menuVersion: m.menuVersion, menuState: m.menuState, timeZone: m.timeZone, serverTime: m.serverTime });
  });
  /** A few bytes: has this outlet's menu changed? */
  app.get<{ Querystring: { outlet?: string } }>("/api/shop/menu/version", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const m = await menuOf(req.query.outlet);
    return reply.header("cache-control", "no-store").send({ version: m.menuVersion });
  });

  /** Everything the ordering page needs to dress itself. Public. */
  app.get<{ Querystring: { outlet?: string } }>("/api/shop/info", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const cat = await d.catalog.load();
    const smsTo = await smsNumber();
    // Hours, phone and address come from the outlet's own setup; the old server settings are only a fallback until it is filled in.
    const outlet = await outletFor(req.query.outlet);
    const hours = outlet.hours || process.env.OUTLET_HOURS?.trim() || undefined;
    const phone = outlet.phone || process.env.OUTLET_PHONE?.trim() || undefined;
    const addr = outlet.address || process.env.OUTLET_ADDRESS?.trim() || undefined;
    return {
      name: d.config.name,
      outletId: outlet.id,
      outletName: outlet.name,
      // Set OUTLET_HOURS (e.g. "Daily 8am-9pm") and OUTLET_PHONE on the server to show them under Help & support.
      // Shown at the top of the order details on the staff Online page. Set OUTLET_ADDRESS and GST_REG_NO on the server.
      address: addr,
      gstRegNo: process.env.GST_REG_NO?.trim() || undefined,
      contact: hours || phone || addr ? { hours, phone, address: addr } : undefined,
      paymentTiming: d.config.paymentTiming,
      // Quick service: no table, every channel. Table service: dine-in only, and a table is required (from the shop's list when it has one).
      // Until an outlet has chosen, a shop with no table list behaves as before (an optional table name), so no mode is announced.
      serviceMode: outlet.chosen ? outlet.mode : tables.length ? "tsr" : undefined,
      tables: outlet.mode === "tsr" ? tables : [],
      membersOnly,
      creditFrozen: await creditFrozen(d.db, merchantId),
      channels: cat.channels.filter((c) => c.active && (outlet.mode === "qsr" || c.kind === "dine_in")).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      brand: await brandPayload(),
      // What this deployment can do beyond email sign-in and paying at the counter. The page enables only these.
      // Email sign-in is off: phone SMS is the identity channel (kiosk handover 4.3 and open decision 3). EMAIL_SIGNIN=on brings the email option back, for a demo.
      auth: { email: /^(1|true|yes|on)$/i.test(process.env.EMAIL_SIGNIN ?? ""), google: !!integ.google && !!d.members, microsoft: !!integ.microsoft && !!d.members, phone: !!d.members && (openSignin ? { number: "", open: true } : smsTo ? { number: smsTo } : membersOnly ? { number: "", manual: true } : showCodes ? { number: "+65 8000 0000", simulated: true } : null) },
      payments: { online: !!integ.stripe, methods: integ.stripe ? ["card", "paynow"] : [] },
      // The kiosk's operator settings, as the owner set them in Manager.
      kiosk: await loadKiosk(d.db, merchantId),
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
  const authLimit = new FailureLimiter(envNum("AUTH_LIMIT", 30), 10 * 60_000);
  const members = d.members;
  /** The order limit: counted on the signed-in member when there is one, otherwise on the address. Returns the member for the caller to reuse. */
  const orderGate = async (req: FastifyRequest, reply: FastifyReply) => {
    const member = members ? await members.fromToken(bearer(req)) : null;
    const blocked = member ? limited(orderLimitMember, req, reply, member.id) : limited(orderLimitIp, req, reply);
    return { blocked, member };
  };

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
      return { member: m, creditCents: await balanceOf(d.db, merchantId, m.id), creditBlocked: await creditBlockedFor(d.db, merchantId, m.id), history: await members.history(m.id, 20), coupons: await members.coupons(m.id), stamps: d.config.rewards.stampCard.enabled ? { ...(await members.stamps(m.id)), target: d.config.rewards.stampCard.target, rewardTitle: d.config.rewards.stampCard.rewardTitle, minPaidCents: d.config.rewards.stampCard.minPaidCents } : null, pointsEnabled: d.config.rewards.pointsEnabled };
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
    const back = (q: string) => `${integ.publicUrl}/shop?${q}`;

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

    // ---- the kiosk QR bridge ---------------------------------------------------------------------------
    // The kiosk shows a QR code and a 6-character code. Neither proves who anyone is: the customer opens the link on their own phone,
    // signs in THERE (the phone's own proof), and confirms. Only then does the kiosk session receive that member's session.
    // A pairing lives 5 minutes, is single use, and is kept in memory (it is a short handshake, not a record).
    const PAIR_SECONDS = 300;
    const PAIR_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 characters, no 0/O/1/I, so a byte maps evenly
    const pairs = new Map<string, { code: string; expires: number; memberId?: string }>();
    const prunePairs = () => { const now = Date.now(); for (const [k, v] of pairs) if (v.expires <= now) pairs.delete(k); };
    const pairStartLimit = new FailureLimiter(envNum("PAIR_START_LIMIT", 200), 10 * 60_000);
    const pairPollLimit = new FailureLimiter(envNum("PAIR_POLL_LIMIT", 3000), 10 * 60_000);

    app.post("/api/shop/auth/kiosk/start", async (req, reply) => {
      if (limited(pairStartLimit, req, reply)) return;
      prunePairs();
      if (pairs.size >= 2000) return reply.code(503).send({ error: "busy" });
      const id = randomBytes(16).toString("base64url");
      let code = "";
      do code = Array.from(randomBytes(6), (b) => PAIR_CHARS[b % PAIR_CHARS.length]).join(""); while ([...pairs.values()].some((v) => v.code === code));
      pairs.set(id, { code, expires: Date.now() + PAIR_SECONDS * 1000 });
      return { id, code, url: `${integ.publicUrl}/pair?code=${code}`, expiresInSeconds: PAIR_SECONDS };
    });

    /** The kiosk asks whether the phone has confirmed. The member's session is handed over once, then the pairing is gone. */
    app.get<{ Params: { id: string } }>("/api/shop/auth/kiosk/:id", async (req, reply) => {
      if (limited(pairPollLimit, req, reply)) return;
      const p = pairs.get(req.params.id);
      if (!p || p.expires <= Date.now()) { pairs.delete(req.params.id); return { state: "expired" }; }
      if (!p.memberId) return { state: "waiting", secondsLeft: Math.max(0, Math.ceil((p.expires - Date.now()) / 1000)) };
      pairs.delete(req.params.id);
      const member = await members.byId(p.memberId);
      if (!member) return { state: "expired" };
      return { state: "attached", token: await members.openSession(member.id), member };
    });

    /** The customer's phone, already signed in, confirms "this is me". */
    app.post<{ Body: { code?: string } }>("/api/shop/auth/kiosk/attach", async (req, reply) => {
      if (limited(authLimit, req, reply)) return;
      const m = await members.fromToken(bearer(req));
      if (!m) return reply.code(401).send({ error: "not_signed_in" });
      const code = String(req.body?.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      prunePairs();
      const p = code.length === 6 ? [...pairs.values()].find((v) => v.code === code) : undefined;
      if (!p) return reply.code(404).send({ error: "code_not_found" });
      if (p.memberId) return reply.code(409).send({ error: "already_used" });
      p.memberId = m.id;
      return { ok: true };
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
    const statusLimit = new FailureLimiter(envNum("SMS_STATUS_LIMIT", 3000), 10 * 60_000);
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
      // (The SMS provider posts a form; forms are read for every route, in app.ts.)
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
        out.push({ orderId, at, queueNumber: o.queueNumber, status: shopStatus(o, d.config), channelName: o.channelName, spot: o.spot, itemCount: o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0), totalCents: orderTotals(o, d.config).total });
      }
      return { orders: out };
    });
  }

  interface OrderBody {
    channelId?: string;
    items?: Array<{ productId?: string; qty?: number; note?: string; build?: BuildInput; options?: Array<{ groupId?: string; choiceId?: string; qty?: number }> }>;
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
    /** Pickup at a chosen time (epoch ms, one of the outlet's slots). Missing = as soon as possible. */
    pickupAt?: number;
    /** A typed promo code. Judged on the items subtotal, before service charge, tax and deposits. */
    promoCode?: string;
    /** Table service: the order is a round on this tab (the credential from joining it). */
    tab?: { participantId?: string; token?: string };
  }

  /** A customer places an order. Held for staff to accept; nothing reaches the kitchen yet. */
  app.post<{ Body: OrderBody }>("/api/shop/orders", async (req, reply) => {
    const gate = await orderGate(req, reply);
    if (gate.blocked) return;
    const b = req.body ?? {};
    if (typeof b.channelId !== "string" || !Array.isArray(b.items)) return reply.code(400).send({ error: "channelId and items are required" });
    const items = b.items.map((i) => ({
      productId: String(i?.productId ?? ""),
      qty: Number(i?.qty),
      note: cleanNote(i?.note),
      build: cleanBuild(i?.build),
      // Only ids and counts are read; any name or price a client sends here is ignored.
      options: (Array.isArray(i?.options) ? i.options.slice(0, 40) : []).map((o) => ({ groupId: String(o?.groupId ?? ""), choiceId: String(o?.choiceId ?? ""), qty: o?.qty === undefined ? undefined : Number(o.qty) })),
    }));

    // Quick service takes no table. Table service takes dine-in only, at one of the shop's own tables (any table name when it has no list).
    const outlet = await outletFor((b as { outletId?: unknown }).outletId);
    let table: string | undefined;
    // Table service with a shared tab: a dine-in order is a ROUND on the table's tab (no payment now, no collection number). Takeaway there is pay-now as usual.
    const chKind = (await d.catalog.load()).channels.find((c) => c.id === b.channelId)?.kind;
    const tabCfg = d.tabs ? await d.tabs.outletSettings(outlet.id) : null;
    const tabRound = !!tabCfg?.tabService && chKind === "dine_in";
    const takeawayAtTsr = !!tabCfg?.tabService && chKind !== "dine_in";
    let tabCtx: { tabId: string; participantId: string } | null = null;
    if (tabRound) {
      try {
        const who = await d.tabs!.authenticate(b.tab?.participantId, b.tab?.token);
        const t = await d.tabs!.tabOpen(who.tabId);
        if (!t.open) return reply.code(409).send({ error: "tab_closed" });
        if (t.outletId !== outlet.id) return reply.code(400).send({ error: "this_tab_is_at_another_outlet" });
        tabCtx = { tabId: who.tabId, participantId: who.person.id };
        table = t.spot ?? undefined;
      } catch (e) {
        if (e instanceof TabError) return reply.code(e.status).send(e.body);
        throw e;
      }
      if (b.payWithCredit || b.usePoints || b.couponId || b.promoCode) return reply.code(400).send({ error: "pay_on_the_tab", message: "A table's orders are paid on the tab, not when ordering." });
    }
    if (outlet.mode === "tsr" && !tabRound && !takeawayAtTsr) {
      if (tables.length) {
        const wanted = String(b.spot ?? "").trim().replace(/^table\s*/i, "");
        table = tables.find((x) => x === `Table ${Number(wanted)}`);
        if (!/^\d{1,3}$/.test(wanted) || !table) return reply.code(400).send({ error: "choose your table" });
      } else {
        table = clean(b.spot, 30) || undefined;
        if (!table) return reply.code(400).send({ error: "choose your table" });
      }
    }
    const phone = clean(b.customerPhone, 20);
    if (phone && !/^[+\d][\d\s-]{5,19}$/.test(phone)) return reply.code(400).send({ error: "phone number looks wrong" });

    // The menu as THIS outlet sells it: items it has switched off are gone, sold-out items and options follow the outlet.
    const stockNow = await onHandAt(d.db, merchantId, outlet.id);
    const cat = applyStockToMenu(applyOutletMenu(await d.catalog.load(), (await loadOutletMenu(d.db, merchantId, outlet.id)).menu), stockNow);
    // An item outside its menu window can be looked at and built, but not ordered: refused here, whatever the app showed, with when it opens next.
    const wins = await loadOutletWindows(d.db, merchantId, outlet.id);
    const nowMs = (d.now ?? Date.now)();
    // (A scheduled order is judged at its pickup time instead, below.)
    for (const it of b.pickupAt != null ? [] : items) {
      const p = cat.products.find((x) => x.id === it.productId);
      if (!p) continue; // unknown or switched off here: the pricing below refuses it as unavailable
      const a = availabilityOf(p, wins.windows, nowMs, wins.timeZone);
      if (a.state === "AVAILABLE_LATER") return reply.code(400).send({ error: "available_later", productId: p.id, ...(a.nextOpeningAt !== undefined ? { nextOpeningAt: a.nextOpeningAt } : {}), ...(a.window ? { window: a.window } : {}) });
    }
    // A chosen pickup time must be one of the slots the outlet offers for these items; nothing else is accepted.
    let pickupAt: number | undefined;
    const sched = await loadOutletScheduling(d.db, merchantId, outlet.id);
    if (b.pickupAt !== undefined && b.pickupAt !== null) {
      if (!sched.on) return reply.code(400).send({ error: "scheduling_off" });
      pickupAt = Number(b.pickupAt);
      const ok = isValidSlot(pickupAt, { now: nowMs, timeZone: wins.timeZone, windows: wins.windows, items: items.map((i) => cat.products.find((x) => x.id === i.productId)).filter((p): p is NonNullable<typeof p> => !!p), prepMinutes: outlet.prepMinutes ?? 0, intervalMinutes: sched.intervalMinutes, daysAhead: sched.daysAhead });
      if (!ok) return reply.code(400).send({ error: "slot_not_available" });
    }
    const member = gate.member;
    if (membersOnly && !tabRound) {
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
    if (outlet.mode === "tsr" && !takeawayAtTsr && cat.channels.find((c) => c.id === b.channelId)?.kind !== "dine_in") return reply.code(400).send({ error: "this shop takes dine-in orders only" });
    // A typed promo code is judged here, again, whatever the app showed: on the items subtotal, before service charge, tax and deposits.
    let promo: Extract<PromoVerdict, { ok: true }> | null = null;
    if (typeof b.promoCode === "string" && b.promoCode.trim()) {
      const base = quoteOrder(cat, d.config, { outletId: outlet.id, channelId: b.channelId }, items, null, null);
      if (!base.ok) return reply.code(400).send({ error: base.error, productId: base.productId, ...(base.validation ? { validation: base.validation } : {}) });
      const verdict = await judgePromo(d.db, merchantId, b.promoCode, { now: nowMs, subtotalCents: base.priced.subtotal, memberId: member?.id ?? null });
      if (!verdict.ok) return reply.code(400).send({ error: "promo_rejected", reason: verdict.reason, ...(verdict.shortfallCents !== undefined ? { shortfallCents: verdict.shortfallCents, minSpendCents: verdict.minSpendCents } : {}) });
      // One code or coupon per order unless the merchant allows both. Points are independent of both.
      if (coupon && !(await promoStacksWithCoupons(d.db, merchantId))) return reply.code(400).send({ error: "one_code_or_coupon" });
      promo = verdict;
    }
    const discountIn = coupon || promo ? { amountCents: (coupon?.amountCents ?? 0) + (promo?.discountCents ?? 0), minSpendCents: coupon?.minSpendCents ?? 0 } : null;
    const quote = quoteOrder(cat, d.config, { outletId: outlet.id, channelId: b.channelId }, items, pointsAsk, discountIn);
    if (!quote.ok) return reply.code(400).send({ error: quote.error, productId: quote.productId, ...(quote.validation ? { validation: quote.validation } : {}) });
    // Stock: the whole order is covered or none of it is taken (never a partial deduction). The stock of each ingredient and linked part is counted once.
    const short = shortfalls(orderConsumption(cat, quote.lines), stockNow);
    if (short.length) {
      const names = await itemNames(d.db, merchantId);
      return reply.code(409).send({ error: "out_of_stock", items: short.map((x) => ({ itemId: x.itemId, name: names.get(x.itemId) ?? x.itemId, needed: x.needed, onHand: Math.max(0, x.onHand) })) });
    }
    if (b.expectedTotalCents !== undefined && b.expectedTotalCents !== quote.priced.total) {
      return reply.code(409).send({ error: "price_changed", totalCents: quote.priced.total });
    }

    // The minimum spend is on the items subtotal only (before service charge, tax and deposits).
    if (coupon && quote.priced.couponIneligible) return reply.code(400).send({ error: "coupon_not_eligible", shortfallCents: coupon.minSpendCents - quote.priced.subtotal });
    if (b.payWithCredit && !member) return reply.code(401).send({ error: "sign_in_to_use_credit" });
    // The shop has frozen member credit (for example, the event is over): no order can be paid with it.
    if (b.payWithCredit && member && (await creditBlockedFor(d.db, merchantId, member.id))) return reply.code(403).send({ error: "credit_frozen" });
    let orderId = newId();

    // A credit purchase carries an idempotency key made by the customer's phone for this attempt. A retry (double tap,
    // timeout, refresh) with the same key gets the first result back and never a second debit; the same key with
    // different content is refused. Without one, a credit purchase is not accepted.
    let idemKey: string | null = null;
    if (b.payWithCredit && member) {
      const key = String(b.idempotencyKey ?? "");
      if (!/^[\w-]{8,64}$/.test(key)) return reply.code(400).send({ error: "idempotency_key_required" });
      const hash = createHash("sha256").update(JSON.stringify({ m: member.id, c: b.channelId, i: items.map((x) => [x.productId, x.qty, x.options, x.note]), s: table ?? clean(b.spot, 30) ?? null, p: b.usePoints ?? null, k: b.couponId ?? null })).digest("hex");
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
    // A round on a tab carries no collection number (Spec 11.2); everything else gets one.
    const queueNumber = tabCtx ? undefined : (collectionNumber(phone ?? member?.phone ?? undefined, taken) ?? (await nextOnlineNumber(d.db, merchantId)));
    const ts = Date.now();
    // Credit first: if it is short, nothing else has been touched. Taken in one step that cannot go below zero.
    const creditCents = b.payWithCredit && member ? quote.priced.total : 0;
    if (creditCents > 0) {
      const paid = await spendCredit(d.db, { merchantId, customerId: member!.id, amountCents: creditCents, idempotencyKey: `credit-order:${orderId}`, orderId, deviceId: SHOP_DEVICE, outletId: outlet.id, note: "Order paid with credit" });
      if (!paid.ok) return reply.code(409).send({ error: "not_enough_credit", balanceCents: paid.balanceCents, neededCents: creditCents });
    }
    const giveCreditBack = () => (creditCents > 0 ? refundCredit(d.db, { merchantId, customerId: member!.id, amountCents: creditCents, idempotencyKey: `credit-back:${orderId}`, orderId, deviceId: SHOP_DEVICE, outletId: outlet.id, note: "Order not placed" }) : Promise.resolve());
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
    // The code's use is recorded now, with its limits checked once more; if another order took the last use, everything taken so far is given back.
    const promoUsed = !!promo && quote.priced.couponDiscount > 0;
    if (promo && promoUsed && !(await claimPromo(d.db, merchantId, promo.promo.code, orderId, member?.id ?? null, Math.min(promo.discountCents, quote.priced.couponDiscount)))) {
      if (member) await members!.reverseForOrder(orderId);
      await giveCreditBack();
      return reply.code(409).send({ error: "promo_rejected", reason: "usage_exhausted" });
    }
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
        ...(tabCtx ? { onTab: true } : {}),
        ...(pickupAt !== undefined ? { scheduledFor: pickupAt, fireAt: pickupAt - (outlet.prepMinutes ?? 0) * 60_000 } : {}),
        spot: quote.channel.kind === "dine_in" && (outlet.mode === "tsr" || !outlet.chosen) ? table ?? clean(b.spot, 30)?.replace(/[^\w #-]/g, "") : undefined,
        queueNumber,
      }),
      // One discount slot on the order: the member's coupon, the typed code, or both (when the merchant allows) read as one line.
      ...(couponUsed || promoUsed ? [mk({ type: "CouponApplied", title: [couponUsed ? coupon!.title : "", promoUsed ? `Code ${promo!.promo.code}` : ""].filter(Boolean).join(" + "), amountCents: quote.priced.couponDiscount, minSpendCents: couponUsed ? coupon!.minSpendCents : 0 })] : []),
      ...(pointsUsed > 0 ? [mk({ type: "PointsRedeemed", points: pointsUsed })] : []),
      ...quote.lines.map((l) => mk({ type: "ItemAdded", lineId: newId(), productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty, pointsExempt: l.pointsExempt, bcrs: l.bcrs, ...(l.taxInclusive !== undefined ? { taxInclusive: l.taxInclusive } : {}), ...(l.taxGroup ? { taxGroup: l.taxGroup } : {}), ...(l.build ? { build: l.build } : {}), options: l.options.length ? l.options : undefined })),
      // Paid with the member's credit: the order is paid and accepted at once, so it goes straight to the kitchen.
      ...(creditCents > 0 ? [mk({ type: "OrderAccepted" }), mk({ type: "PaymentRecorded", paymentId: `credit:${orderId}`, method: "credit", amountCents: creditCents, confirmed: true })] : []),
    ];
    try {
      await d.ingest(events, outlet.id);
    } catch (err) {
      await giveCreditBack(); // the order was not recorded, so the customer keeps their credit
      await releasePromo(d.db, merchantId, orderId);
      throw err;
    }
    let roundNo: number | undefined;
    if (tabCtx) roundNo = await d.tabs!.addRound(tabCtx.tabId, orderId, tabCtx.participantId);
    if (pickupAt !== undefined) await d.db.query("INSERT INTO scheduled_orders (merchant_id, order_id, outlet_id, fire_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [merchantId, orderId, outlet.id, pickupAt - (outlet.prepMinutes ?? 0) * 60_000]);
    return { orderId, queueNumber, totalCents: quote.priced.total, pointsUsed, couponDiscountCents: quote.priced.couponDiscount, ...(promoUsed ? { promoCode: promo!.promo.code } : {}), ...(tabCtx ? { tabId: tabCtx.tabId, round: roundNo } : {}), paidWithCreditCents: creditCents, creditBalanceCents: member ? await balanceOf(d.db, merchantId, member.id) : undefined, status: creditCents > 0 ? "queued" : "received" };
    });
    } catch (e) {
      await dropAttempt();
      throw e;
    }
    // A placed order empties this customer's cart at this outlet (their carts elsewhere stay).
    if (reply.statusCode < 400) { const owner = await cartOwner(req); if (owner) await saveCart(owner, outlet.id, []).catch(() => undefined); }
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
  /** Release every scheduled order whose moment has come (its slot less the prep time) to the kitchen. Safe to run twice: the event has one fixed id. */
  async function fireScheduledOrders(): Promise<number> {
    const due = await d.db.query("SELECT order_id, outlet_id FROM scheduled_orders WHERE merchant_id=$1 AND NOT fired AND fire_at <= $2 ORDER BY fire_at", [merchantId, (d.now ?? Date.now)()]);
    for (const row of due.rows) {
      const orderId = row.order_id as string;
      const evs = await d.store.eventsForOrder(orderId);
      const ts = (d.now ?? Date.now)();
      if (evs.length && !evs.some((e) => e.type === "OrderFired")) {
        await d.ingest([{ id: `fire-${orderId}`, orderId, deviceId: SHOP_DEVICE, ts, seq: 1_000_000, type: "OrderFired" } as OrderEvent], row.outlet_id as string);
      }
      await d.db.query("UPDATE scheduled_orders SET fired=true WHERE merchant_id=$1 AND order_id=$2", [merchantId, orderId]);
    }
    return due.rowCount ?? 0;
  }
  (app as unknown as { fireScheduledOrders: () => Promise<number> }).fireScheduledOrders = fireScheduledOrders;
  const scheduler = setInterval(() => void fireScheduledOrders().catch(() => undefined), 15_000);
  scheduler.unref();
  app.addHook("onClose", async () => clearInterval(scheduler));

  // ---- build pricing and the server-side cart (backend handout sections 4, 5, 8, 9) ----------------------------------------------------------

  /** The menu one outlet sells right now: its own prices, rules, sold-out options and windows. */
  const outletView = async (asked: unknown) => {
    const outlet = await outletFor(asked);
    const [base, om, wins] = await Promise.all([d.catalog.load(), loadOutletMenu(d.db, merchantId, outlet.id), loadOutletWindows(d.db, merchantId, outlet.id)]);
    // Stock-tracked items that cannot make one more are sold out here (86), and so is anything that links to them.
    return { outlet, cat: applyStockToMenu(applyOutletMenu(base, om.menu), await onHandAt(d.db, merchantId, outlet.id)), wins, nowMs: (d.now ?? Date.now)() };
  };
  type OutletView = Awaited<ReturnType<typeof outletView>>;

  /** The customer's cart owner: their member id when signed in, else the cart key their phone made. */
  const cartOwner = async (req: FastifyRequest): Promise<string | null> => {
    const m = members ? await members.fromToken(bearer(req)) : null;
    if (m) return `m:${m.id}`;
    const key = String(req.headers["x-cart-key"] ?? "");
    return /^[\w-]{8,64}$/.test(key) ? `a:${key}` : null;
  };

  interface CartLine { lineId: string; productId: string; qty: number; note?: string; build?: BuildInput; options?: Array<{ groupId: string; choiceId: string; qty?: number }>; /** Frozen at add or update: what the customer was shown. */ snapshot?: StoredBuild; unitCents?: number }

  /** One line against the menu as it stands now: still sellable, still valid, with its price split. A problem flags the line; it is never silently dropped or changed. */
  const judgeLine = (v: OutletView, channelId: string, l: CartLine) => {
    const p = v.cat.products.find((x) => x.id === l.productId);
    if (!p) return { state: "unavailable" as const };
    const a = availabilityOf(p, v.wins.windows, v.nowMs, v.wins.timeZone);
    if (a.state === "AVAILABLE_LATER") return { state: "available_later" as const, ...(a.nextOpeningAt !== undefined ? { nextOpeningAt: a.nextOpeningAt } : {}) };
    const q = quoteOrder(v.cat, d.config, { outletId: v.outlet.id, channelId }, [{ productId: l.productId, qty: l.qty, note: l.note, build: l.build, options: l.options }]);
    if (!q.ok) return { state: q.error === "build_invalid" ? ("build_invalid" as const) : ("unavailable" as const), error: q.error, ...(q.validation ? { validation: q.validation } : {}) };
    const line = q.lines[0]!;
    return { state: "ok" as const, unitCents: line.unitCents, lineCents: line.unitCents * line.qty, selections: line.build?.selections, options: line.options };
  };

  const defaultChannel = (cat: { channels: Array<{ id: string; active: boolean; kind: string }> }, asked?: unknown) => (typeof asked === "string" && cat.channels.some((c) => c.id === asked) ? asked : (cat.channels.find((c) => c.active && c.kind !== "dine_in") ?? cat.channels.find((c) => c.active))?.id ?? "");

  const loadCart = async (owner: string, outletId: string): Promise<CartLine[]> => ((await d.db.query("SELECT lines FROM shop_carts WHERE merchant_id=$1 AND owner=$2 AND outlet_id=$3", [merchantId, owner, outletId])).rows[0]?.lines as CartLine[] | undefined) ?? [];
  const saveCart = (owner: string, outletId: string, lines: CartLine[]) => d.db.query("INSERT INTO shop_carts (merchant_id, owner, outlet_id, lines) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (merchant_id, owner, outlet_id) DO UPDATE SET lines=EXCLUDED.lines, updated_at=now()", [merchantId, owner, outletId, JSON.stringify(lines)]);

  /** The cart as the phone shows it: each line judged against the menu now, and the totals of the lines that are fine. */
  const cartView = async (owner: string, v: OutletView, channelId: string) => {
    const lines = await loadCart(owner, v.outlet.id);
    const judged = lines.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty, note: l.note, build: l.build, options: l.options, storedBuild: l.snapshot, ...judgeLine(v, channelId, l) }));
    const good = lines.filter((_, i) => judged[i]!.state === "ok");
    const q = good.length ? quoteOrder(v.cat, d.config, { outletId: v.outlet.id, channelId }, good.map((l) => ({ productId: l.productId, qty: l.qty, note: l.note, build: l.build, options: l.options }))) : null;
    const others = ((await d.db.query("SELECT outlet_id, lines FROM shop_carts WHERE merchant_id=$1 AND owner=$2 AND outlet_id <> $3", [merchantId, owner, v.outlet.id])).rows as Array<{ outlet_id: string; lines: CartLine[] }>).filter((r) => r.lines.length).map((r) => ({ outletId: r.outlet_id, lineCount: r.lines.length }));
    return {
      outletId: v.outlet.id, channelId, lines: judged,
      flagged: judged.filter((l) => l.state !== "ok").length,
      totals: q && q.ok ? { ...q.priced, lines: totalsLines(q.priced) } : null,
      otherCarts: others,
      menuVersion: v.cat.version,
    };
  };

  /** Validate and price a build without touching any cart: per-group states and, per selection, the full price, the part the allowance covered and what is charged. */
  app.post<{ Body: { outletId?: string; productId?: string; build?: BuildInput; qty?: number } }>("/api/shop/build/price", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const v = await outletView(req.body?.outletId);
    const p = v.cat.products.find((x) => x.id === String(req.body?.productId ?? ""));
    if (!p || !hasBuilder(p.builder)) return reply.code(404).send({ error: "not_a_builder_product" });
    const channelId = defaultChannel(v.cat);
    const entry = menuFor(v.cat, { outletId: v.outlet.id, channelId }).find((m) => m.id === p.id);
    if (!entry) return reply.code(404).send({ error: "not_on_this_menu" });
    const built = priceBuild(p.builder, cleanBuild(req.body?.build) ?? { picks: [] }, entry.priceCents, { ruleVersion: v.cat.version });
    const qty = Math.max(1, Math.min(MAX_QTY_LINE, Number(req.body?.qty) || 1));
    if (!built.ok) return { ok: false, validation: built.validation };
    return { ok: true, unitCents: built.unitCents, lineCents: built.unitCents * qty, qty, selections: built.selections, chargedCents: built.chargedCents, variantDeltaCents: built.variantDeltaCents, baseCents: built.baseCents, validation: { ok: true } };
  });

  const cartKeyMissing = { error: "cart_key_required" };

  /** The cart at one outlet, re-checked against the menu as it is now. */
  app.get<{ Querystring: { outlet?: string; channel?: string } }>("/api/shop/cart", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const owner = await cartOwner(req);
    if (!owner) return reply.code(400).send(cartKeyMissing);
    const v = await outletView(req.query.outlet);
    return cartView(owner, v, defaultChannel(v.cat, req.query.channel));
  });

  /** Every outlet the customer has a cart at, so the phone can warn before a switch and restore after. */
  app.get("/api/shop/carts", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const owner = await cartOwner(req);
    if (!owner) return reply.code(400).send(cartKeyMissing);
    const rows = (await d.db.query("SELECT outlet_id, lines, updated_at FROM shop_carts WHERE merchant_id=$1 AND owner=$2 ORDER BY updated_at DESC", [merchantId, owner])).rows as Array<{ outlet_id: string; lines: CartLine[]; updated_at: Date }>;
    return { carts: rows.filter((r) => r.lines.length).map((r) => ({ outletId: r.outlet_id, lineCount: r.lines.length, updatedAt: new Date(r.updated_at).getTime() })) };
  });

  const checkNewLine = (v: OutletView, channelId: string, l: CartLine, reply: FastifyReply) => {
    const j = judgeLine(v, channelId, l);
    if (j.state === "ok") return null;
    return reply.code(400).send({ error: j.state === "build_invalid" ? "build_invalid" : j.state, ...(j as object) });
  };

  /** Add a line. The same product with the same build and note merges into one line. */
  app.post<{ Body: { outletId?: string; channelId?: string; productId?: string; qty?: number; note?: string; build?: BuildInput; options?: CartLine["options"] } }>("/api/shop/cart/lines", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const owner = await cartOwner(req);
    if (!owner) return reply.code(400).send(cartKeyMissing);
    const b = req.body ?? {};
    const v = await outletView(b.outletId);
    const channelId = defaultChannel(v.cat, b.channelId);
    const qty = Number(b.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_LINE) return reply.code(400).send({ error: "bad_quantity" });
    const line: CartLine = { lineId: newId(), productId: String(b.productId ?? ""), qty, note: cleanNote(b.note) || undefined, build: cleanBuild(b.build), options: Array.isArray(b.options) ? b.options.slice(0, 40).map((o) => ({ groupId: String(o?.groupId ?? ""), choiceId: String(o?.choiceId ?? ""), qty: o?.qty === undefined ? undefined : Number(o.qty) })) : undefined };
    const refused = checkNewLine(v, channelId, line, reply);
    if (refused) return refused;
    const lines = await loadCart(owner, v.outlet.id);
    const sig = (l: CartLine) => JSON.stringify([l.productId, l.build, l.options, l.note]);
    const same = lines.find((l) => sig(l) === sig(line));
    if (same) same.qty = Math.min(MAX_QTY_LINE, same.qty + qty);
    else lines.push(line);
    if (lines.length > 30) return reply.code(400).send({ error: "too_many_items" });
    await saveCart(owner, v.outlet.id, lines);
    return cartView(owner, v, channelId);
  });

  /** Change a line in place: a new build is re-validated and re-priced and replaces the line (no duplicate); or set its quantity or note. */
  app.put<{ Params: { lineId: string }; Body: { outletId?: string; channelId?: string; qty?: number; note?: string; build?: BuildInput } }>("/api/shop/cart/lines/:lineId", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const owner = await cartOwner(req);
    if (!owner) return reply.code(400).send(cartKeyMissing);
    const b = req.body ?? {};
    const v = await outletView(b.outletId);
    const channelId = defaultChannel(v.cat, b.channelId);
    const lines = await loadCart(owner, v.outlet.id);
    const i = lines.findIndex((l) => l.lineId === req.params.lineId);
    if (i < 0) return reply.code(404).send({ error: "line_not_found" });
    const next: CartLine = { ...lines[i]! };
    if (b.qty !== undefined) {
      if (!Number.isInteger(b.qty) || b.qty < 0 || b.qty > MAX_QTY_LINE) return reply.code(400).send({ error: "bad_quantity" });
      next.qty = b.qty;
    }
    if (b.note !== undefined) next.note = cleanNote(b.note) || undefined;
    if (b.build !== undefined) next.build = cleanBuild(b.build);
    if (next.qty === 0) lines.splice(i, 1);
    else {
      const refused = checkNewLine(v, channelId, next, reply);
      if (refused) return refused;
      lines[i] = next;
    }
    await saveCart(owner, v.outlet.id, lines);
    return cartView(owner, v, channelId);
  });

  app.delete<{ Params: { lineId: string }; Querystring: { outlet?: string; channel?: string } }>("/api/shop/cart/lines/:lineId", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const owner = await cartOwner(req);
    if (!owner) return reply.code(400).send(cartKeyMissing);
    const v = await outletView(req.query.outlet);
    const lines = await loadCart(owner, v.outlet.id);
    await saveCart(owner, v.outlet.id, lines.filter((l) => l.lineId !== req.params.lineId));
    return cartView(owner, v, defaultChannel(v.cat, req.query.channel));
  });

  /** Empty one outlet's cart (after the order is placed, or when the customer asks). Other outlets' carts are untouched. */
  app.delete<{ Querystring: { outlet?: string } }>("/api/shop/cart", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const owner = await cartOwner(req);
    if (!owner) return reply.code(400).send(cartKeyMissing);
    const v = await outletView(req.query.outlet);
    await saveCart(owner, v.outlet.id, []);
    return cartView(owner, v, defaultChannel(v.cat));
  });

  /** Check a typed code against a cart before ordering: accepted with what it takes off, or rejected with the reason. Never a silent failure. */
  app.post<{ Body: { outletId?: string; channelId?: string; items?: Array<{ productId?: string; qty?: number; note?: string; build?: BuildInput; options?: Array<{ groupId?: string; choiceId?: string; qty?: number }> }>; code?: string } }>("/api/shop/promo/validate", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const b = req.body ?? {};
    if (!Array.isArray(b.items)) return reply.code(400).send({ error: "items are required" });
    const v = await outletView(b.outletId);
    const member = members ? await members.fromToken(bearer(req)) : null;
    const items = b.items.map((i) => ({ productId: String(i?.productId ?? ""), qty: Number(i?.qty), note: cleanNote(i?.note), build: cleanBuild(i?.build), options: (Array.isArray(i?.options) ? i.options.slice(0, 40) : []).map((o) => ({ groupId: String(o?.groupId ?? ""), choiceId: String(o?.choiceId ?? ""), qty: o?.qty === undefined ? undefined : Number(o.qty) })) }));
    const base = quoteOrder(v.cat, d.config, { outletId: v.outlet.id, channelId: defaultChannel(v.cat, b.channelId) }, items, null, null);
    if (!base.ok) return reply.code(400).send({ error: base.error, productId: base.productId });
    const verdict = await judgePromo(d.db, merchantId, b.code, { now: v.nowMs, subtotalCents: base.priced.subtotal, memberId: member?.id ?? null });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, basis: PROMO_BASIS, ...(verdict.shortfallCents !== undefined ? { minSpendCents: verdict.minSpendCents, shortfallCents: verdict.shortfallCents } : {}) };
    return { ok: true, code: verdict.promo.code, title: verdict.promo.title, discountCents: verdict.discountCents, minSpendCents: verdict.promo.minSpendCents, basis: PROMO_BASIS, itemsSubtotalCents: base.priced.subtotal };
  });

  /** The pickup times an outlet offers on one day (YYYY-MM-DD on its own clock), for these items. Public. */
  app.get<{ Querystring: { outlet?: string; date?: string; items?: string } }>("/api/shop/slots", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const outlet = await outletFor(req.query.outlet);
    const sched = await loadOutletScheduling(d.db, merchantId, outlet.id);
    if (!sched.on) return reply.code(400).send({ error: "scheduling_off" });
    const wins = await loadOutletWindows(d.db, merchantId, outlet.id);
    const nowMs = (d.now ?? Date.now)();
    const cat = applyOutletMenu(await d.catalog.load(), (await loadOutletMenu(d.db, merchantId, outlet.id)).menu);
    const ids = String(req.query.items ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 60);
    const items = ids.map((id) => cat.products.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
    const l = localParts(nowMs, wins.timeZone);
    const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
    const slots = pickupSlots(date, { now: nowMs, timeZone: wins.timeZone, windows: wins.windows, items, prepMinutes: outlet.prepMinutes ?? 0, intervalMinutes: sched.intervalMinutes, daysAhead: sched.daysAhead });
    return { outletId: outlet.id, date, timeZone: wins.timeZone, intervalMinutes: sched.intervalMinutes, daysAhead: sched.daysAhead, prepMinutes: outlet.prepMinutes ?? 0, slots };
  });
  void sweepOrphanDebits().catch(() => undefined);
  const sweeper = setInterval(() => void sweepOrphanDebits().catch(() => undefined), 5 * 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));

  // Every order, rebuilt from the log at most once every 5 seconds however many phones are asking, for the queue position.
  // A count a few seconds out of date is fine for "about how long". QUEUE_CACHE_MS changes it (0 = always fresh).
  const queueCacheMs = Number.isFinite(Number(process.env.QUEUE_CACHE_MS)) && process.env.QUEUE_CACHE_MS !== undefined ? Number(process.env.QUEUE_CACHE_MS) : 5000;
  const queueSnaps = new Map<string, { at: number; orders: OrderState[] }>();
  /** The orders of one outlet: a queue never counts another store's orders. */
  const everyOrder = async (outletId: string) => {
    const snap = queueSnaps.get(outletId);
    if (snap && Date.now() - snap.at < queueCacheMs) return snap.orders;
    const orders = reduceAll((await d.store.afterAll(0)).filter((x) => !x.outletId || x.outletId === outletId).map((x) => x.event));
    queueSnaps.set(outletId, { at: Date.now(), orders });
    return orders;
  };

  /** Status for the customer. The order id is a long random value, so only whoever placed it has it. */
  app.get<{ Params: { id: string } }>("/api/shop/orders/:id", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const order = reduceOrder(req.params.id, await d.store.eventsForOrder(req.params.id));
    if (!order || order.source !== "online") return reply.code(404).send({ error: "order_not_found" });
    const priced = orderTotals(order, d.config);
    const total = priced.total;
    const paid = order.payments.filter((p) => p.confirmed).reduce((n, p) => n + p.amountCents, 0);
    return {
      orderId: order.orderId,
      queueNumber: order.queueNumber,
      status: shopStatus(order, d.config),
      scheduledFor: order.scheduledFor,
      // The menu's state at this order's outlet rides on the poll, so a screen that is already polling learns the menu moved.
      ...(await (async () => { const m = await menuOf(await outletOfOrder(order.orderId)); return { menuVersion: m.menuVersion, menuState: m.menuState }; })()),
      channelName: order.channelName,
      spot: order.spot,
      items: order.lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, qty: l.qty, unitCents: l.unitCents, options: optionLines(l.options) })),
      totalCents: total,
      // The bill line by line, with the tax basis said plainly (tax inside the prices is shown, never added) and the deposit as its own line.
      totals: totalsLines(priced),
      taxIncludedCents: priced.taxIncluded,
      paidCents: paid,
      pointsRedeemed: order.pointsRedeemed ?? 0,
      canCancel: cancellable(order),
      // Where this order is in line and about how long: only while it is waiting for or being made by the kitchen.
      queue: ["queued", "preparing"].includes(shopStatus(order, d.config)) ? queueView(await everyOrder(await outletOfOrder(order.orderId)), order, d.config, Date.now(), Number(process.env.QUEUE_FALLBACK_MINUTES) || undefined) : null,
      canPayOnline: !!integ.stripe && order.stage !== "cancelled" && order.stage !== "completed" && total - paid > 0,
    };
  });

  /** A customer may call off an order that nothing has been paid on and the kitchen has not started. */
  const cancellable = (o: ReturnType<typeof reduceOrder>) => !!o && o.source === "online" && o.stage === "open" && confirmedPaid(o) === 0;

  app.post<{ Params: { id: string } }>("/api/shop/orders/:id/cancel", async (req, reply) => {
    if ((await orderGate(req, reply)).blocked) return;
    const order = reduceOrder(req.params.id, await d.store.eventsForOrder(req.params.id));
    if (!order || order.source !== "online") return reply.code(404).send({ error: "order_not_found" });
    if (order.stage === "cancelled") return { status: "cancelled" };
    if (!cancellable(order)) return reply.code(409).send({ error: "cannot_cancel" });
    // A fixed id: pressing twice, or a retry, cancels once.
    await d.ingest([{ id: `shop-cancel-${order.orderId}`, orderId: order.orderId, deviceId: SHOP_DEVICE, ts: Date.now(), seq: Date.now(), type: "StageSet", stage: "cancelled" } as unknown as OrderEvent], await outletOfOrder(order.orderId));
    return { status: "cancelled" };
  });

  // ---- online payment (Stripe: card and PayNow) -----------------------------------------------------

  /** Start a payment for what is still owed on an order. The customer is sent to the hosted payment page. */
  app.post<{ Params: { id: string }; Body: { method?: string } }>("/api/shop/orders/:id/pay", async (req, reply) => {
    if ((await orderGate(req, reply)).blocked) return;
    if (!integ.stripe) return reply.code(404).send({ error: "online_payment_not_available" });
    const method = req.body?.method;
    if (method !== "card" && method !== "paynow") return reply.code(400).send({ error: "method must be card or paynow" });
    const order = reduceOrder(req.params.id, await d.store.eventsForOrder(req.params.id));
    if (!order || order.source !== "online") return reply.code(404).send({ error: "order_not_found" });
    if (order.stage === "cancelled" || order.stage === "completed") return reply.code(409).send({ error: "order_closed" });
    const due = orderTotals(order, d.config).total - confirmedPaid(order);
    if (due <= 0) return reply.code(409).send({ error: "already_paid" });
    const s = await createStripeCheckout(integ, { orderId: order.orderId, queueNumber: order.queueNumber ?? "", amountCents: due, method, returnUrl: `${integ.publicUrl}/shop/order/${order.orderId}`, description: `${d.config.name} order ${order.queueNumber ?? ""}`.trim() });
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
          await d.ingest([{ id: `stripe-${obj.id}`, orderId: order.orderId, deviceId: SHOP_DEVICE, ts: Date.now(), seq: Date.now(), type: "PaymentRecorded", paymentId: `stripe:${obj.id}`, method, amountCents: obj.amount_total!, confirmed: true } as unknown as OrderEvent], await outletOfOrder(order.orderId));
        }
      }
      return { received: true };
    });
  });
}
