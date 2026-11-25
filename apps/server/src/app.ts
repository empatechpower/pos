import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withTaxPack, isTaxCountry, TAX_PACKS, DEFAULT_COUNTRY, type BuilderSpec, guestCheck, plainText, receipt, type OrderState, type PrintContext, commissionOf, tabPaymentReceipt, type ProductStock, validateProductStock, isTimeZone, validCoordinates, validateOutletOverride, validateWindows, type MenuWindows, confirmedPaid, hourly, isFullyPaid, productMix, summarize, menuFor, newId, orderTotals, reduceAll, reduceOrder, shopStatus, type BusinessConfig, type ChannelKind, type OptionGroup, type OrderEvent } from "@pos/core";
import { PERMISSION_OPTIONS, loadRolePermissions, rolePermissions, saveRolePermissions, setRolePermissions, CASHIER_TOPUP_LIMIT_CENTS, audit, checkStaffPin, authenticate, authenticateAgent, can, createAgent, createConnectCode, redeemConnectCode, createStaff, listAgents, login, loginByPhone, logout, normalisePhone, setStaffPhone, recentAudit, revokeAgent, type Permission, type Role, type Staff } from "./auth.js";
import type { CatalogStore, ChangeResult, PgCatalogStore } from "./catalog.js";
import type { Db } from "./db/pool.js";
import { adjustTo, balanceOf, creditBlockedFor, creditExemptIds, creditFrozen, refund, setCreditExempt, setCreditFrozen, spend, topUp } from "./ledger.js";
import { authenticateDevice, createEnrollmentCode, enroll, markPrintPoll, setSmsNumber, issueStreamTicket, listDevices, redeemStreamTicket, revokeDevice, type Device } from "./devices.js";
import { BrandStore } from "./brand.js";
import { PrintStore, validatePrinter, type Printer } from "./print.js";
import { registerShop } from "./shop.js";
import { registerTimeclock } from "./timeclock.js";
import { registerDisplay } from "./display.js";
import { registerPromoAdmin, releasePromo } from "./promo.js";
import { reconcileOrderStock, registerStock } from "./stock.js";
import { TabError, TabService } from "./tabs.js";
import { registerTabRoutes } from "./tabRoutes.js";
import { AmountNotAllowed, issueQr, loadPaynow, loadPaynowOverrides, savePaynow, savePaynowOverride } from "./paynow.js";
import { applyOption, loadKiosk, OPTION_KEYS, optionsOf, saveKiosk, saveSetting } from "./settings.js";
import { openShiftOf, registerShifts } from "./shifts.js";
import { registerFloor } from "./floor.js";
import { cleanLayout, registerTill } from "./tillSettings.js";
import { registerMailboxes } from "./mailboxes.js";
import type { ImapFactory } from "./imapMailbox.js";
import { registerDiscountPolicy } from "./discountPolicy.js";
import { registerOrderTrail } from "./orderTrail.js";
import { refundYeahpay, sendMail, type Integrations } from "./integrations.js";
import { registerTelegram } from "./telegram.js";
import { MemberStore } from "./members.js";
import { FailureLimiter } from "./rateLimit.js";
import type { EventStore, StoredEvent } from "./store.js";
import { loadOutletMenu, loadOutletScheduling, loadOutletWindows, saveOutletOverride, saveOutletScheduling, saveOutletWindows } from "./outletMenu.js";
import { ensureDefaultOutlet, listFranchises, listOutlets, outletAllowed, upsertFranchise, upsertOutlet, validId, visibleOutletIds } from "./tenant.js";

declare module "fastify" {
  interface FastifyRequest {
    staff?: Staff;
    device?: Device;
    /** Set when an agent made the request: the person it says it is acting for (for example "Sam, via Telegram"). */
    agentActor?: string;
  }
}

interface Deps {
  config: BusinessConfig;
  store: EventStore;
  catalog: CatalogStore;
  /** Present with a database: lets managers change prices, channels and items. */
  catalogAdmin?: PgCatalogStore;
  /** Present with a database: queues tickets, receipts and labels for printers. */
  print?: PrintStore;
  /** Wallet, login and audit routes exist only when a database is configured. */
  db: Db | null;
  logger?: boolean;
  /** Set when behind a reverse proxy, so per-address limits see the customer and not the proxy. */
  trustProxy?: boolean;
  /** Google / Microsoft / SMS / Stripe settings; see integrations.ts. Optional: each one only switches a feature on. */
  integrations?: Integrations;
  /** The clock (epoch ms). Tests set it to prove what happens at a window's edge; production leaves it. */
  now?: () => number;
  /** Where the bank's PayNow alerts are read from (tests use a memory mailbox; production reads Gmail). */
  alertMailbox?: import("./paynowMatcher.js").AlertMailbox;
  /** How IMAP mailboxes are reached (tests hand in a stand-in). */
  imapFactory?: ImapFactory;
  /** How often the mailbox is looked at while a QR is live (ms). Tests make it short. */
  alertWatchMs?: number;
}

const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer\s+/i, "");
const deviceToken = (req: FastifyRequest) => {
  const h = req.headers["x-device-token"];
  return Array.isArray(h) ? h[0] : h;
};

export async function buildApp({ config, store, db, catalog, catalogAdmin, print, logger = true, trustProxy = false, integrations, now, alertMailbox, alertWatchMs, imapFactory }: Deps) {
  const app = Fastify({ logger, trustProxy });
  // Logo uploads arrive as raw image bytes.
  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: 300 * 1024 + 1 }, (_req, body, done) => done(null, body));
  // The merchant's own "number is ready" sound: a short clip, same size limit as the logo.
  app.addContentTypeParser(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4"], { parseAs: "buffer", bodyLimit: 300 * 1024 + 1 }, (_req, body, done) => done(null, body));
  // Android's HttpURLConnection labels every POST as a form ("application/x-www-form-urlencoded"), even with no body, which Fastify would
  // refuse (415). The print app's "done" reports are exactly that, so they never arrived and every printed ticket stayed "unconfirmed".
  // Forms are read as plain fields. Every route takes its credentials from headers, never cookies, so this opens nothing new.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body ? Object.fromEntries(new URLSearchParams(String(body))) : {}));
  await app.register(cors, { origin: true });
  const merchantId = config.businessId;

  if (db) await ensureDefaultOutlet(db, merchantId, config.outletName, config.outletName);

  /** Tax follows the country of the outlet (standing rule 1): the country's pack is written into the pricing rules at start and whenever the outlet is saved. */
  const outletTax = new Map<string, { country: string; gstOn: boolean | null; serviceMode: "qsr" | "tsr" | "retail" | null }>();
  async function applyOutletTax(): Promise<void> {
    const all = db ? await listOutlets(db, merchantId) : [];
    outletTax.clear();
    for (const o of all) outletTax.set(o.id, { country: o.country, gstOn: o.gstOn, serviceMode: o.serviceMode });
    const p = withTaxPack(config.pricing, outletTax.get(config.outletName)?.country);
    delete config.pricing.rounding;
    Object.assign(config.pricing, p);
  }
  await applyOutletTax();
  /**
   * The shop's rules as one outlet trades by them: its country's tax pack, and whether it charges tax at all (its own answer, or the brand's
   * switch when it has none). Everything else is the brand's. An order keeps the answer it was opened with (`taxOn`), so it never reprices.
   */
  function configFor(outletId: string | null | undefined): BusinessConfig {
    const o = outletId ? outletTax.get(outletId) : undefined;
    if (!o) return config;
    const pricing = withTaxPack(config.pricing, o.country);
    return { ...config, ...(o.serviceMode ? { serviceMode: o.serviceMode } : {}), pricing: { ...pricing, gstOn: o.gstOn ?? config.pricing.gstOn } };
  }

  const streams = new Set<(s: StoredEvent[]) => void>();

  /**
   * With a database, every device must be enrolled: sync, sign-in and money all require its token.
   * Without one (plain local development) there is nothing to enrol against, so sync stays open.
   */
  const needsDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!db) return;
    const device = await authenticateDevice(db, deviceToken(req));
    if (!device || device.merchantId !== merchantId) return reply.code(401).send({ error: "device_not_enrolled" });
    req.device = device;
  };

  app.get("/api/auth/mode", async () => ({ deviceRequired: !!db }));

  /** A till asks with its device token and gets its own outlet's rules (tax differs by outlet); anyone else gets the brand's. */
  app.get("/api/config", async (req) => {
    const token = deviceToken(req);
    const device = db && token ? await authenticateDevice(db, token).catch(() => null) : null;
    return device && device.merchantId === merchantId ? configFor(device.outletId) : config;
  });
  /**
   * The whole catalog, so a device can price any channel with no network. Public on purpose (the
   * customer ordering app needs it); it holds menu and prices only. The version doubles as an ETag.
   */
  app.get("/api/catalog", async (req, reply) => {
    const c = await catalog.load();
    const etag = `"v${c.version}"`;
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.header("etag", etag).header("cache-control", "no-cache").send(c);
  });

  /** A few bytes: the menu's version. A phone compares it with its own and downloads the menu only when it differs. */
  app.get("/api/catalog/version", async (_req, reply) => reply.header("cache-control", "no-store").send({ version: await catalog.version() }));

  /** Kept for older clients: the default channel's menu at this outlet. */
  app.get("/api/menu", async () => {
    const c = await catalog.load();
    const ch = c.channels.find((x) => x.active)?.id ?? "";
    return menuFor(c, { outletId: config.outletName, channelId: ch });
  });
  app.get("/api/health", async () => ({ ok: true, latestSeq: await store.latestSeq() }));

  /**
   * Work out what each touched order needs printed and queue it. A failure here is logged, never
   * allowed to fail the push: the events are already safely stored, and the next change to the order
   * (or a manual reprint) will pick up anything missed.
   */
  /**
   * What a receipt says about the shop and the sale: the outlet's address, the GST and business numbers (set GST_REG_NO and BUSINESS_UEN on the
   * server; without a GST number the receipt is not a tax invoice), a customer service line, who took the payment, and the member's last digits.
   */
  async function printCtxFor(order: OrderState, outletId?: string): Promise<PrintContext> {
    const ctx: PrintContext = { merchantName: config.name, outletName: config.outletName, now: Date.now() };
    // The outlet's own registration numbers come first (set in the back office); GST_REG_NO and BUSINESS_UEN on the server are the fallback.
    const profile = db && outletId ? (await listOutlets(db, merchantId).catch(() => [])).find((o) => o.id === outletId) : undefined;
    const gst = profile?.gstRegNo ?? process.env.GST_REG_NO?.trim();
    if (gst) ctx.gstRegNo = gst;
    const uen = profile?.uen ?? process.env.BUSINESS_UEN?.trim();
    if (uen) ctx.uen = uen;
    if (process.env.CUSTOMER_SERVICE?.trim()) ctx.customerService = process.env.CUSTOMER_SERVICE.trim();
    if (!db) return ctx;
    try {
      const outlet = outletId ? (await listOutlets(db, merchantId)).find((o) => o.id === outletId) : undefined;
      const address = outlet?.address ?? process.env.OUTLET_ADDRESS?.trim();
      if (address) ctx.address = address;
      const sid = [...order.payments].reverse().find((p) => p.shiftId)?.shiftId;
      if (sid) { const r = await db.query("SELECT staff_name FROM shifts WHERE id=$1", [sid]); if (r.rows[0]?.staff_name) ctx.cashier = String(r.rows[0].staff_name).split(" ")[0]!; }
      if (order.memberId) { const m = await db.query("SELECT phone FROM members WHERE id=$1 AND merchant_id=$2", [order.memberId, merchantId]); const d = String(m.rows[0]?.phone ?? "").replace(/\D/g, ""); if (d.length >= 4) ctx.memberLast4 = d.slice(-4); }
    } catch { /* a receipt prints without these rather than not at all */ }
    return ctx;
  }

  async function queuePrints(orderIds: string[]) {
    try {
      const cat = await catalog.load();
      for (const id of orderIds) {
        const order = reduceOrder(id, await store.eventsForOrder(id));
        const outletId = (await store.outletOfOrder?.(id)) ?? undefined;
        if (order) await print!.enqueueForOrder(order, { catalog: cat, config, print: await printCtxFor(order, outletId), outletId });
      }
    } catch (err) {
      app.log.error({ err }, "could not queue prints");
    }
  }

  const members = db ? new MemberStore(db, merchantId, config.rewards.pointsEnabled ? config.rewards.welcomePoints : 0, config.rewards.welcomeVoucherCents) : undefined;

  /** Email a member once when their order is ready, if they have an email and want order updates. */
  async function tellReady(o: NonNullable<ReturnType<typeof reduceOrder>>) {
    if (!integrations?.mail || o.source !== "online") return;
    const m = await members!.byId(o.memberId!);
    if (!m?.email || !m.prefs.orderUpdates) return;
    if (!(await members!.claimNotice(o.orderId, "ready"))) return;
    const ok = await sendMail(integrations, { to: m.email, subject: `Your order ${o.queueNumber ?? ""} is ready`.replace("  ", " "), text: `Hi${m.name ? ` ${m.name}` : ""},\n\nYour order ${o.queueNumber ?? ""} at ${config.name} is ready to collect.\n\nYou can turn these emails off in Account > Preferences.` });
    if (!ok) console.error(`[mail] could not send the ready notice for order ${o.orderId}`);
  }

  /** Points follow the order: earned once when it is paid, spent points returned if it is cancelled. */
  async function settleMemberOrders(orderIds: string[]) {
    for (const id of orderIds) {
      const o = reduceOrder(id, await store.eventsForOrder(id));
      if (!o?.memberId) continue;
      if (shopStatus(o, config) === "ready") await tellReady(o);
      if (o.stage === "cancelled") {
        // Credit the customer paid with comes back when the order is called off. One refund per order, whatever happens twice.
        const credit = o.payments.filter((p) => p.confirmed && p.method === "credit" && p.paymentId === `credit:${id}`).reduce((n, p) => n + p.amountCents, 0);
        if (credit > 0 && db) await refund(db, { merchantId, customerId: o.memberId, amountCents: credit, idempotencyKey: `cancel-refund:${id}`, orderId: id, deviceId: "shop", outletId: config.outletName, note: "Order cancelled" });
        await members!.reverseForOrder(id);
      }
      else if (isFullyPaid(o, config)) {
        if (config.rewards.pointsEnabled) await members!.earnForOrder(id, confirmedPaid(o), config.rewards.earnPointsPerDollar);
        await members!.stampForOrder(id, confirmedPaid(o), config.rewards.stampCard);
      }
    }
  }

  /** Stock follows the orders: after any change to an order, its stock movements are made to match its lines (once each; a cancel puts it back). */
  async function reconcileStock(orderIds: string[]) {
    try {
      const cat = await catalog.load();
      for (const id of orderIds) {
        const order = reduceOrder(id, await store.eventsForOrder(id));
        const outletId = (await store.outletOfOrder?.(id)) ?? config.outletName;
        if (order && db) await reconcileOrderStock(db, merchantId, outletId, order, cat);
      }
    } catch (err) {
      app.log.error({ err }, "could not update stock");
    }
  }

  /** Store events, tell live screens, queue whatever now needs printing. Used for tills and for customers' orders alike. */
  async function ingest(events: OrderEvent[], outletId?: string): Promise<StoredEvent[]> {
    // Tax can only be taken off an order where the country's tax pack allows it; anything else is dropped here, whatever the till sent.
    events = events.filter((e) => !(e.type === "TaxRemovalSet" && e.removed && !(config.pricing.taxRemovable && config.pricing.gstOn)));
    // A member attached at the till must be a real member of this shop; otherwise the event is dropped. The order is then theirs: it shows
    // in their history, earns points when paid, and gives points back if it is cancelled.
    if (events.some((e) => e.type === "MemberAttached")) {
      const kept: OrderEvent[] = [];
      for (const e of events) {
        if (e.type !== "MemberAttached" || !e.memberId) { kept.push(e); continue; }
        const m = members && /^[0-9a-f-]{36}$/i.test(e.memberId) ? await members.byId(e.memberId).catch(() => null) : null;
        if (!m) continue;
        await members!.linkOrder(e.orderId, m.id, 0);
        kept.push(e);
      }
      events = kept;
    }
    const added = await store.append(events, outletId);
    if (added.length) for (const push of streams) push(added);
    // Points spent at the till are remembered against the order, so cancelling it gives them back.
    if (db) for (const a of added) if (a.event.type === "PointsRedeemed" && a.event.points > 0) await db.query("UPDATE member_orders SET points_redeemed = GREATEST(points_redeemed, $3) WHERE order_id=$1 AND merchant_id=$2", [a.event.orderId, merchantId, Math.round(a.event.points)]).catch(() => undefined);
    const touched = [...new Set(added.map((a) => a.event.orderId))];
    // A cancelled order gives its promo code use back.
    for (const a of added) if (db && a.event.type === "StageSet" && a.event.stage === "cancelled") await releasePromo(db, merchantId, a.event.orderId).catch(() => undefined);
    // Every discount and hand-changed price is written to the audit log: who gave it, who approved it, why.
    if (db) for (const a of added) {
      const e = a.event as unknown as Record<string, unknown>;
      if (e.type === "DiscountApplied" || e.type === "DiscountRemoved" || e.type === "LinePriceOverridden") await audit(db, merchantId, null, `order.${e.type === "DiscountApplied" ? "discount" : e.type === "DiscountRemoved" ? "discount_removed" : "price_override"}`, { orderId: e.orderId, scope: e.scope, kind: e.kind, value: e.value, unitCents: e.unitCents, reason: e.reason, by: e.byName, approvedBy: e.approvedByName, deviceId: e.deviceId }).catch(() => undefined);
    }
    if (db) for (const a of added) if (a.event.type === "TaxRemovalSet") await audit(db, merchantId, null, a.event.removed ? "order.tax_removed" : "order.tax_restored", { orderId: a.event.orderId, reason: a.event.reason, by: a.event.byName, approvedBy: a.event.approvedByName }).catch(() => undefined);
    if (added.length && print) await queuePrints(touched);
    if (added.length && db) await reconcileStock(touched);
    if (added.length && members) await settleMemberOrders(touched);
    return added;
  }

  /** Devices push events they created (possibly hours ago, while offline). */
  app.post<{ Body: { events: OrderEvent[] } }>("/api/sync/push", { preHandler: needsDevice }, async (req, reply) => {
    const events = req.body?.events;
    if (!Array.isArray(events)) return reply.code(400).send({ error: "events[] required" });
    for (const e of events) {
      if (!e?.id || !e.orderId || !e.deviceId || !e.type) return reply.code(400).send({ error: "malformed event" });
      // A device may only speak for itself: it cannot plant events that claim to come from another.
      if (req.device && e.deviceId !== req.device.id) return reply.code(403).send({ error: "device_mismatch" });
    }
    const added = await ingest(events, req.device?.outletId);
    return { accepted: events.length, stored: added.length, latestSeq: await store.latestSeq(req.device?.outletId) };
  });

  /** Devices pull everything newer than the last server sequence they have seen. */
  app.get<{ Querystring: { after?: string } }>("/api/sync/pull", { preHandler: needsDevice }, async (req) => {
    const after = Number(req.query.after ?? 0) || 0;
    return { events: await store.after(after, req.device?.outletId), latestSeq: await store.latestSeq(req.device?.outletId) };
  });

  /** Server-sent events: nudges connected screens (kitchen, queue) the instant something changes. */
  app.post("/api/stream/ticket", { preHandler: needsDevice }, async (req) => ({ ticket: req.device ? issueStreamTicket(req.device) : "open" }));

  app.get<{ Querystring: { ticket?: string } }>("/api/stream", async (req, reply) => {
    if (db && !redeemStreamTicket(req.query.ticket)) return reply.code(401).send({ error: "ticket_invalid" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    void store.latestSeq().then((latestSeq) => res.write(`event: hello\ndata: ${JSON.stringify({ latestSeq, id: newId() })}\n\n`));
    const send = (items: StoredEvent[]) =>
      res.write(`event: events\ndata: ${JSON.stringify({ latestSeq: Math.max(...items.map((i) => i.serverSeq)), count: items.length })}\n\n`);
    streams.add(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.raw.on("close", () => {
      clearInterval(ping);
      streams.delete(send);
    });
  });

  if (!db) return app;

  // ---- staff login ------------------------------------------------------------------------

  /** Pre-handler: an enrolled device, a valid staff session, and the permission this route needs. */
  const agentFailures = new FailureLimiter(20, 15 * 60_000);
  const needs = (permission: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
    // An agent (an AI helper or script) signs in with one API key instead of a device and a PIN.
    const agentKey = req.headers["x-agent-key"];
    if (typeof agentKey === "string") {
      if (agentFailures.blocked(req.ip)) return reply.code(429).send({ error: "too_many_attempts" });
      const agent = await authenticateAgent(db, agentKey);
      if (!agent || agent.merchantId !== merchantId) {
        agentFailures.fail(req.ip);
        return reply.code(401).send({ error: "invalid_agent_key" });
      }
      if (!can(agent.role, permission)) return reply.code(403).send({ error: "not_allowed", needs: permission });
      req.staff = agent;
      req.agentActor = String(req.headers["x-agent-actor"] ?? "").trim().slice(0, 60) || "unknown";
      return;
    }
    const denied = await needsDevice(req, reply);
    if (denied) return denied;
    const staff = await authenticate(db, bearer(req));
    if (!staff || staff.merchantId !== merchantId) return reply.code(401).send({ error: "sign_in_required" });
    if (!can(staff.role, permission)) return reply.code(403).send({ error: "not_allowed", needs: permission });
    req.staff = staff;
  };

  // Guessing PINs across many staff codes from one place is what per-account lockout cannot see.
  const loginFailures = new FailureLimiter(20, 15 * 60_000);
  const enrollFailures = new FailureLimiter(10, 15 * 60_000);

  app.post<{ Body: { code?: string; phone?: string; pin?: string } }>("/api/auth/login", { preHandler: needsDevice }, async (req, reply) => {
    const { code, phone, pin } = req.body ?? {};
    if ((!code && !phone) || !pin) return reply.code(400).send({ error: "a staff code or phone number, and a pin, are required" });
    const who = req.device!.id;
    if (loginFailures.blocked(who)) return reply.code(429).send({ error: "locked" });
    const r = code ? await login(db, merchantId, code, pin) : await loginByPhone(db, merchantId, String(phone), pin);
    if (!r.ok) {
      if (r.reason === "invalid") loginFailures.fail(who);
      return reply.code(r.reason === "locked" ? 429 : 401).send({ error: r.reason });
    }
    return { token: r.token, expiresAt: r.expiresAt, staff: { name: r.staff.name, code: r.staff.code, role: r.staff.role, franchiseId: r.staff.franchiseId ?? null, outletId: r.staff.outletId ?? null, phoneHint: r.staff.phoneHint ?? null, permissions: rolePermissions(r.staff.role) } };
  });

  // ---- a person's own colour for the staff screens (Q&A F-2); anyone who has not chosen follows the merchant's theme ------------------
  const luminance = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  /** Readable as text or a button on white (WCAG 3:1): a colour pale enough to hurt legibility under service pressure is refused. */
  const readableOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05) >= 3;
  app.get("/api/auth/theme", { preHandler: needs("wallet.read") }, async (req) => {
    const own = db ? (await db.query("SELECT theme_primary FROM staff WHERE id=$1", [req.staff!.id])).rows[0]?.theme_primary ?? null : null;
    return { primary: own };
  });
  app.put<{ Body: { primary?: string | null } }>("/api/auth/theme", { preHandler: needs("wallet.read") }, async (req, reply) => {
    if (!db) return reply.code(503).send({ error: "no_database" });
    const v = req.body?.primary;
    if (v === null) { await db.query("UPDATE staff SET theme_primary=NULL WHERE id=$1", [req.staff!.id]); return { primary: null }; }
    if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) return reply.code(400).send({ error: "send a colour like #EA7016, or null to follow the shop's colours" });
    if (!readableOnWhite(v)) return reply.code(400).send({ error: "too_pale", message: "That colour is too pale to read on a screen under service. Choose a darker one." });
    await db.query("UPDATE staff SET theme_primary=$2 WHERE id=$1", [req.staff!.id, v.toUpperCase()]);
    return { primary: v.toUpperCase() };
  });

  // Screen choices that belong to the person, not the till: which side the menu sits on, and how big the text is.
  const PREF_VALUES: Record<string, string[]> = { menuSide: ["left", "right"], textSize: ["compact", "standard", "large", "xl"] };
  // A person's own menu layout rides along with their other choices (null clears it, so they see the shop's again).
  const cleanPrefs = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(o).filter(([k, x]) => PREF_VALUES[k]?.includes(String(x))));
    if (o.layout) { const l = cleanLayout(o.layout); if (l) out.layout = l; }
    return out;
  };
  app.get("/api/auth/prefs", { preHandler: needs("wallet.read") }, async (req) => ({ prefs: db ? cleanPrefs((await db.query("SELECT prefs FROM staff WHERE id=$1", [req.staff!.id])).rows[0]?.prefs) : {} }));
  app.put<{ Body: Record<string, unknown> }>("/api/auth/prefs", { preHandler: needs("wallet.read") }, async (req, reply) => {
    if (!db) return reply.code(503).send({ error: "no_database" });
    if ((req.body as { layout?: unknown } | undefined)?.layout === null) {
      const row = (await db.query("UPDATE staff SET prefs = COALESCE(prefs, '{}'::jsonb) - 'layout' WHERE id=$1 RETURNING prefs", [req.staff!.id])).rows[0];
      return { prefs: cleanPrefs(row?.prefs) };
    }
    const mine = cleanPrefs(req.body);
    if (!Object.keys(mine).length) return reply.code(400).send({ error: "nothing_to_save" });
    const row = (await db.query("UPDATE staff SET prefs = COALESCE(prefs, '{}'::jsonb) || $2::jsonb WHERE id=$1 RETURNING prefs", [req.staff!.id, JSON.stringify(mine)])).rows[0];
    return { prefs: cleanPrefs(row?.prefs) };
  });

  app.get("/api/auth/me", { preHandler: needs("wallet.read") }, async (req) => ({ name: req.staff!.name, code: req.staff!.code, role: req.staff!.role, franchiseId: req.staff!.franchiseId ?? null, outletId: req.staff!.outletId ?? null, permissions: rolePermissions(req.staff!.role) }));

  // ---- what cashiers and managers may do: the owner's choice ----
  if (db) await loadRolePermissions(db, merchantId);
  const permissionView = () => ({ roles: { cashier: rolePermissions("cashier"), manager: rolePermissions("manager") }, options: PERMISSION_OPTIONS });
  app.get("/api/settings/permissions", { preHandler: needs("wallet.read") }, async () => permissionView());
  app.put<{ Body: { cashier?: unknown; manager?: unknown } }>("/api/settings/permissions", { preHandler: needs("staff.manage") }, async (req, reply) => {
    const b = req.body ?? {};
    const list = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 40 && v.every((x) => typeof x === "string"));
    if (!list(b.cashier) || !list(b.manager)) return reply.code(400).send({ error: "cashier and manager are lists of permission names" });
    if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
    if (b.cashier !== undefined) setRolePermissions("cashier", b.cashier as string[]);
    if (b.manager !== undefined) setRolePermissions("manager", b.manager as string[]);
    await saveRolePermissions(db, merchantId);
    await audit(db, merchantId, req.staff!.id, "settings.permissions", permissionView().roles);
    return permissionView();
  });

  /** Your own sign-in phone number. Needs your PIN, because it opens the account. Send phone: null to remove it. */
  app.put<{ Body: { phone?: string | null; pin?: string } }>("/api/auth/phone", { preHandler: needs("wallet.read") }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.pin || b.phone === undefined) return reply.code(400).send({ error: "send your pin and a phone number (or null)" });
    const me = req.staff!;
    const ok = await checkStaffPin(db, merchantId, me.code, b.pin);
    if (!ok.ok) return reply.code(ok.reason === "locked" ? 429 : 401).send({ error: ok.reason });
    const r = await setStaffPhone(db, merchantId, me.code, b.phone);
    if (r === "invalid") return reply.code(400).send({ error: "not_a_phone_number", message: "Use the country code and number, like +65 8111 1111." });
    if (r === "taken") return reply.code(409).send({ error: "phone_in_use" });
    if (r !== "ok") return reply.code(404).send({ error: "unknown_staff" });
    await audit(db, merchantId, me.id, "staff.phone", { set: b.phone !== null });
    return { phone: b.phone === null ? null : normalisePhone(b.phone) };
  });

  app.post("/api/auth/logout", async (req) => {
    const t = bearer(req);
    if (t) await logout(db, t);
    return { ok: true };
  });

  app.post<{ Body: { code?: string; name?: string; role?: Role; pin?: string; phone?: string; franchiseId?: string | null; outletId?: string | null } }>("/api/staff", { preHandler: needs("staff.manage") }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.code || !b.name || !b.pin || !b.role || !["cashier", "manager", "owner"].includes(b.role)) {
      return reply.code(400).send({ error: "code, name, pin and a valid role are required" });
    }
    // Scope: an outlet or a franchise, never both. A scoped creator can only hand out access inside their own scope.
    const franchiseId = b.franchiseId || null;
    const outletId = b.outletId || null;
    if (franchiseId && outletId) return reply.code(400).send({ error: "choose a franchise or an outlet, not both" });
    const outlets = await listOutlets(db, merchantId);
    if (outletId && !outlets.some((o) => o.id === outletId)) return reply.code(400).send({ error: "unknown_outlet" });
    if (franchiseId && !(await listFranchises(db, merchantId)).some((f) => f.id === franchiseId)) return reply.code(400).send({ error: "unknown_franchise" });
    const mine = await visibleOutletIds(db, merchantId, req.staff!);
    if (mine !== null) {
      const granted = outletId ? [outletId] : franchiseId ? outlets.filter((o) => o.franchiseId === franchiseId).map((o) => o.id) : null;
      if (granted === null || !granted.every((id) => mine.includes(id)) || (franchiseId && req.staff!.franchiseId !== franchiseId)) return reply.code(403).send({ error: "outside_your_scope" });
    }
    try {
      if (b.phone !== undefined && !normalisePhone(b.phone)) return reply.code(400).send({ error: "not_a_phone_number" });
      const s = await createStaff(db, { merchantId, code: b.code, name: b.name, role: b.role, pin: b.pin, franchiseId, outletId });
      if (b.phone !== undefined && (await setStaffPhone(db, merchantId, s.code, b.phone)) === "taken") return reply.code(409).send({ error: "phone_in_use", message: "The account was made, but that phone number belongs to someone else." });
      await audit(db, merchantId, req.staff!.id, "staff.create", { code: s.code, role: s.role, franchiseId, outletId });
      return { code: s.code, name: s.name, role: s.role, franchiseId, outletId };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "could not create staff" });
    }
  });

  // Every change an agent makes is logged with who it says it was acting for, so the shop can see "Sam, via Telegram: renamed Teh".
  app.addHook("onResponse", async (req, reply) => {
    if (!req.agentActor || !req.staff || req.method === "GET" || req.method === "HEAD") return;
    await audit(db, merchantId, req.staff.id, "agent.call", { actor: req.agentActor, agent: req.staff.name, method: req.method, path: req.url.split("?")[0], status: reply.statusCode }).catch(() => {});
  });

  /** The agent API described for an AI assistant. Public: it holds no secrets. */
  app.get("/api/agent/openapi.yaml", async (_req, reply) => {
    try {
      return reply.header("content-type", "text/yaml; charset=utf-8").send(readFileSync(fileURLToPath(new URL("../../../docs/agent-openapi.yaml", import.meta.url)), "utf8"));
    } catch {
      return reply.code(404).send({ error: "not_available" });
    }
  });

  const connectFails = new FailureLimiter(10, 15 * 60_000);
  /** The merchant makes a code under Manager > Agents and gives it to the agent; the agent trades it for its key. */
  app.post("/api/agents/connect-code", { preHandler: needs("staff.manage") }, async (req) => createConnectCode(db, merchantId, req.staff!.id));
  app.post<{ Body: { code?: string; name?: string } }>("/api/agents/connect", async (req, reply) => {
    if (connectFails.blocked(req.ip)) return reply.code(429).send({ error: "too_many_attempts" });
    const name = String(req.body?.name ?? "Muse").trim().slice(0, 40) || "Muse";
    const made = await redeemConnectCode(db, merchantId, String(req.body?.code ?? ""), name);
    if (!made) {
      connectFails.fail(req.ip);
      return reply.code(401).send({ error: "invalid_or_expired_code" });
    }
    return { key: made.key, agentId: made.id, shop: { name: config.name, outlet: config.outletName }, note: "Keep this key secret. Send it as the x-agent-key header. Add x-agent-actor with the person you are acting for." };
  });

  // ---- data for analysis (read only) --------------------------------------------------------

  const SGT = "Asia/Singapore";
  const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: SGT });
  const hourOf = (ms: number) => Number(new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: SGT }).slice(0, 2));
  /** Orders opened between two dates (Singapore days, inclusive; default today), with lines, totals and payments. Cancelled orders are left out unless asked for. */
  const ordersBetween = async (from?: string, to?: string, includeCancelled = false, outlets: string[] | null = null) => {
    const today = dayOf(Date.now());
    const a = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? from! : today;
    const b = /^\d{4}-\d{2}-\d{2}$/.test(to ?? "") ? to! : a;
    // `outlets` null = every outlet of the brand. Events carry their outlet; the single-outlet JSON store carries none and passes through.
    const stored = (await store.afterAll(0)).filter((x) => outlets === null || !x.outletId || outlets.includes(x.outletId));
    const outletOf = new Map<string, string>();
    for (const x of stored) if (x.outletId && !outletOf.has(x.event.orderId)) outletOf.set(x.event.orderId, x.outletId);
    const all = reduceAll(stored.map((x) => x.event));
    return {
      outletOf,
      from: a,
      to: b,
      orders: all
        .filter((o) => o.lines.some((l) => l.qty > 0) && (includeCancelled || o.stage !== "cancelled") && dayOf(o.openedAt) >= a && dayOf(o.openedAt) <= b)
        .sort((x, y) => x.openedAt - y.openedAt),
    };
  };

  const ordersReport = async (fromDate?: string, toDate?: string, includeCancelled = false, outlets: string[] | null = null) => {
    const { from, to, orders, outletOf } = await ordersBetween(fromDate, toDate, includeCancelled, outlets);
    return {
      from, to, count: orders.length,
      orders: orders.map((o) => {
        const t = orderTotals(o, config);
        return {
          orderId: o.orderId, outletId: outletOf.get(o.orderId) ?? null, queueNumber: o.queueNumber ?? null, openedAt: new Date(o.openedAt).toISOString(), day: dayOf(o.openedAt), hour: hourOf(o.openedAt),
          channel: o.channelName ?? o.fulfilment, source: o.source, table: o.spot ?? null, stage: o.stage,
          customerName: o.customerName ?? null, customerPhone: o.customerPhone ?? null, memberId: o.memberId ?? null,
          lines: o.lines.filter((l) => l.qty > 0).map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, unitCents: l.unitCents, options: (l.options ?? []).map((x) => x.name) })),
          subtotalCents: t.subtotal, serviceCents: t.service, gstCents: t.gst, bcrsCents: t.bcrs, couponCents: t.couponDiscount, discountCents: t.discountCents, pointsCents: t.pointsDiscount, totalCents: t.total, paidCents: confirmedPaid(o),
          closedAt: o.closedAt ? new Date(o.closedAt).toISOString() : null,
          payments: o.payments.filter((p) => p.confirmed).map((p) => ({ method: p.method, amountCents: p.amountCents })),
        };
      }),
    };
  };
  /**
   * Which outlets a report may cover for this login: its own scope, narrowed to ?outlet= when one is asked for.
   * `null` = every outlet of the brand; "denied" = an outlet outside the login's scope was asked for.
   */
  const reportScope = async (staff: NonNullable<FastifyRequest["staff"]>, asked?: string): Promise<string[] | null | "denied"> => {
    const visible = await visibleOutletIds(db, merchantId, staff);
    if (!asked) return visible;
    return outletAllowed(visible, asked) ? [asked] : "denied";
  };

  app.get<{ Querystring: { from?: string; to?: string; cancelled?: string; outlet?: string } }>("/api/reports/orders", { preHandler: needs("audit.read") }, async (req, reply) => {
    const scope = await reportScope(req.staff!, req.query.outlet);
    if (scope === "denied") return reply.code(403).send({ error: "outside_your_scope" });
    return ordersReport(req.query.from, req.query.to, req.query.cancelled === "1", scope);
  });

  /**
   * Record what a channel's platform actually took on one order (Q&A A-5). Only for a channel this merchant has opted in to recording
   * commission for; the figure replaces the contract-rate estimate for that order. Managers and owners; audited.
   */
  app.post<{ Params: { id: string }; Body: { cents?: number; note?: string } }>("/api/orders/:id/commission", { preHandler: needs("wallet.refund") }, async (req, reply) => {
    const order = reduceOrder(req.params.id, await store.eventsForOrder(req.params.id));
    if (!order) return reply.code(404).send({ error: "order_not_found" });
    const outlet = (await store.outletOfOrder?.(order.orderId)) ?? undefined;
    if (outlet && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), outlet)) return reply.code(403).send({ error: "outside_your_scope" });
    const channel = (await catalog.load()).channels.find((x) => x.id === order.channelId);
    if (!channel?.commission) return reply.code(409).send({ error: "commission_not_recorded_for_this_channel" });
    const cents = Number(req.body?.cents);
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > orderTotals(order, config).total) return reply.code(400).send({ error: "cents must be between 0 and the order total" });
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 120) : undefined;
    await ingest([{ id: `commission-${order.orderId}-${Date.now().toString(36)}`, orderId: order.orderId, deviceId: "server", ts: Date.now(), seq: Date.now(), type: "CommissionRecorded", cents, ...(note ? { note } : {}) } as unknown as OrderEvent], outlet);
    await audit(db, merchantId, req.staff!.id, "order.commission", { orderId: order.orderId, cents, note: note ?? null });
    return { ok: true, cents };
  });

  // ---- giving money back: refund one payment, or void the whole order -------------------------------------------------------
  // Every one needs a manager: a signed-in manager or owner, or the manager's staff code and PIN typed on the cashier's till. A reason is required.

  type Approval = { ok: true; id: string; name: string } | { ok: false; status: number; error: string };
  const approvalFor = async (staff: Staff, body: { approverCode?: string; approverPin?: string }): Promise<Approval> => {
    if (can(staff.role, "order.refund")) return { ok: true, id: staff.id, name: staff.name };
    if (!body.approverCode || !body.approverPin) return { ok: false, status: 428, error: "manager_approval_needed" };
    if (!db) return { ok: false, status: 503, error: "needs_a_database" };
    const v = await checkStaffPin(db, merchantId, String(body.approverCode).trim(), String(body.approverPin));
    if (!v.ok) return { ok: false, status: v.reason === "locked" ? 423 : 422, error: v.reason === "locked" ? "approver_locked" : "approval_refused" };
    if (!can(v.row.role, "order.refund")) return { ok: false, status: 422, error: "approver_cannot_approve" };
    return { ok: true, id: v.row.id, name: v.row.name };
  };
  const reasonOf = (b: { reason?: unknown }) => (typeof b.reason === "string" ? b.reason.trim().slice(0, 200) : "");
  const remainingOn = (o: NonNullable<ReturnType<typeof reduceOrder>>, paymentId: string, amount: number) => amount - (o.refunds ?? []).filter((r) => r.paymentId === paymentId).reduce((n, r) => n + r.amountCents, 0);

  /**
   * Gives one payment's money back where the system can: member credit goes back to the wallet, a YeahPay payment is reversed with YeahPay.
   * Cash, a card machine, a direct PayNow transfer and Stripe cannot be pushed from here, so `manual` tells staff to hand it back themselves.
   */
  async function giveBack(o: NonNullable<ReturnType<typeof reduceOrder>>, p: { paymentId: string; method: string; amountCents: number }, cents: number, refundId: string, viaCancel: boolean): Promise<{ ok: true; manual: boolean } | { ok: false; error: string }> {
    if (p.method === "credit") {
      // The shop's own credit payment is returned by the cancel handling when the whole order is voided; anything else, or a part-refund, is returned here.
      if (viaCancel && p.paymentId === `credit:${o.orderId}`) return { ok: true, manual: false };
      if (!o.memberId || !db) return { ok: false, error: "no_member_to_return_credit_to" };
      const r = await refund(db, { merchantId, customerId: o.memberId, amountCents: cents, idempotencyKey: `order-refund:${refundId}`, orderId: o.orderId, deviceId: "server", outletId: config.outletName, note: "Order refund" });
      return r.ok ? { ok: true, manual: false } : { ok: false, error: "credit_could_not_be_returned" };
    }
    if (p.paymentId.startsWith("yeahpay:")) {
      if (cents !== p.amountCents) return { ok: false, error: "card_payments_are_refunded_in_full_only" };
      if (!integrations?.yeahpay || !(await refundYeahpay(integrations, { leshuaOrderId: p.paymentId.slice("yeahpay:".length), key: `refund${refundId}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 48) }))) return { ok: false, error: "payment_provider_refused_the_refund" };
      return { ok: true, manual: false };
    }
    return { ok: true, manual: true };
  }

  async function orderForMoney(req: FastifyRequest, reply: FastifyReply, id: string) {
    const order = reduceOrder(id, await store.eventsForOrder(id));
    if (!order) { await reply.code(404).send({ error: "order_not_found" }); return null; }
    const outlet = (await store.outletOfOrder?.(id)) ?? undefined;
    if (outlet && db && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), outlet)) { await reply.code(403).send({ error: "outside_your_scope" }); return null; }
    return { order, outlet };
  }

  app.post<{ Params: { id: string }; Body: { paymentId?: string; amountCents?: number; reason?: string; refundId?: string; approverCode?: string; approverPin?: string } }>("/api/orders/:id/refund", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const b = req.body ?? {};
    const found = await orderForMoney(req, reply, req.params.id);
    if (!found) return;
    const { order, outlet } = found;
    const reason = reasonOf(b);
    if (reason.length < 3) return reply.code(400).send({ error: "reason_required" });
    const pay = order.payments.find((p) => p.paymentId === b.paymentId && p.confirmed && p.amountCents > 0);
    if (!pay) return reply.code(404).send({ error: "payment_not_found" });
    const refundId = typeof b.refundId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.refundId) ? b.refundId : newId();
    if (order.refunds?.some((r) => r.refundId === refundId)) return { ok: true, replayed: true, refundId };
    const cents = Number(b.amountCents);
    const left = remainingOn(order, pay.paymentId, pay.amountCents);
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > left) return reply.code(400).send({ error: "amount_not_allowed", remainingCents: left });
    const ap = await approvalFor(req.staff!, b);
    if (!ap.ok) return reply.code(ap.status).send({ error: ap.error });
    const back = await giveBack(order, pay, cents, refundId, false);
    if (!back.ok) return reply.code(409).send({ error: back.error });
    // Cash handed back comes out of the drawer of whoever is serving: their open shift, else the shift the payment was taken in.
    const shiftId = (db ? (await openShiftOf(db, merchantId, req.staff!.id))?.id : undefined) ?? pay.shiftId;
    await ingest([{ id: `refund-${refundId}`, orderId: order.orderId, deviceId: "server", ts: Date.now(), seq: Date.now(), type: "RefundRecorded", refundId, paymentId: pay.paymentId, method: pay.method, amountCents: cents, reason, approvedBy: ap.id, approvedByName: ap.name, ...(shiftId ? { shiftId } : {}) } as unknown as OrderEvent], outlet);
    await audit(db, merchantId, req.staff!.id, "order.refund", { orderId: order.orderId, paymentId: pay.paymentId, method: pay.method, amountCents: cents, reason, approvedBy: ap.id });
    return { ok: true, refundId, method: pay.method, amountCents: cents, manual: back.manual };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string; voidId?: string; approverCode?: string; approverPin?: string } }>("/api/orders/:id/void", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const b = req.body ?? {};
    const found = await orderForMoney(req, reply, req.params.id);
    if (!found) return;
    const { order, outlet } = found;
    if (order.voided) return reply.code(409).send({ error: "already_voided" });
    const reason = reasonOf(b);
    if (reason.length < 3) return reply.code(400).send({ error: "reason_required" });
    const ap = await approvalFor(req.staff!, b);
    if (!ap.ok) return reply.code(ap.status).send({ error: ap.error });
    const key = typeof b.voidId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.voidId) ? b.voidId : newId();
    const events: OrderEvent[] = [];
    const manual: Array<{ method: string; amountCents: number }> = [];
    const servingShift = db ? (await openShiftOf(db, merchantId, req.staff!.id))?.id : undefined;
    for (const p of order.payments.filter((x) => x.confirmed && x.amountCents > 0)) {
      const left = remainingOn(order, p.paymentId, p.amountCents);
      if (left <= 0) continue;
      const refundId = `${key}-${p.paymentId}`.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
      const back = await giveBack(order, p, left, refundId, true);
      if (!back.ok) return reply.code(409).send({ error: back.error, paymentId: p.paymentId });
      if (back.manual) manual.push({ method: p.method, amountCents: left });
      events.push({ id: `refund-${refundId}`, orderId: order.orderId, deviceId: "server", ts: Date.now(), seq: Date.now() + events.length, type: "RefundRecorded", refundId, paymentId: p.paymentId, method: p.method, amountCents: left, reason, approvedBy: ap.id, approvedByName: ap.name, voided: true, ...((servingShift ?? p.shiftId) ? { shiftId: (servingShift ?? p.shiftId) as string } : {}) } as unknown as OrderEvent);
    }
    events.push({ id: `void-${key}`, orderId: order.orderId, deviceId: "server", ts: Date.now(), seq: Date.now() + events.length, type: "OrderVoided", reason, approvedBy: ap.id, approvedByName: ap.name } as unknown as OrderEvent);
    await ingest(events, outlet);
    await audit(db, merchantId, req.staff!.id, "order.void", { orderId: order.orderId, reason, approvedBy: ap.id, refundedCents: events.length - 1 > 0 ? order.payments.filter((x) => x.confirmed && x.amountCents > 0).reduce((n, x) => n + x.amountCents, 0) : 0, manual });
    return { ok: true, manual };
  });

  /** Sales summary for a date range: totals, by day, by hour, by channel, and products ranked. */
  const salesReport = async (fromDate?: string, toDate?: string, outlets: string[] | null = null) => {
    const { from, to, orders } = await ordersBetween(fromDate, toDate, false, outlets);
    const everyOne = (await ordersBetween(fromDate, toDate, true, outlets)).orders;
    const cat = new Map((await catalog.load()).products.map((x) => [x.id, x.category]));
    const days = new Map<string, { orders: number; cents: number }>();
    const hours = new Map<number, { orders: number; cents: number }>();
    const channels = new Map<string, { orders: number; cents: number }>();
    const commissions = new Map<string, number>();
    const chans = (await catalog.load()).channels;
    const products = new Map<string, { qty: number; cents: number }>();
    let subtotal = 0, service = 0, gross = 0, items = 0;
    const bump = <K>(m: Map<K, { orders: number; cents: number }>, k: K, cents: number) => { const x = m.get(k) ?? { orders: 0, cents: 0 }; x.orders++; x.cents += cents; m.set(k, x); };
    for (const o of orders) {
      const t = orderTotals(o, config);
      subtotal += t.subtotal; service += t.service; gross += t.total;
      bump(days, dayOf(o.openedAt), t.total); bump(hours, hourOf(o.openedAt), t.total); bump(channels, o.channelName ?? o.fulfilment, t.total);
      const comm = commissionOf(o, t.total, chans.find((x) => x.id === o.channelId));
      if (comm) commissions.set(o.channelName ?? o.fulfilment, (commissions.get(o.channelName ?? o.fulfilment) ?? 0) + comm.cents);
      for (const l of o.lines) {
        if (l.qty <= 0) continue;
        items += l.qty;
        const p = products.get(l.name) ?? { qty: 0, cents: 0 };
        p.qty += l.qty; p.cents += l.unitCents * l.qty; products.set(l.name, p);
      }
    }
    const list = <K>(m: Map<K, { orders: number; cents: number }>, key: string) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => ({ [key]: k, orders: v.orders, cents: v.cents }));
    return {
      summary: summarize(everyOne, config), hourly: hourly(orders, config), mix: productMix(orders, (id) => cat.get(id) ?? ""),
      from, to, orders: orders.length, items, subtotalCents: subtotal, serviceCents: service, grossCents: gross, averageOrderCents: orders.length ? Math.round(gross / orders.length) : 0,
      byDay: list(days, "day"), byHour: list(hours, "hour"), byChannel: [...channels].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([channel, v]) => ({ channel, orders: v.orders, cents: v.cents, ...(commissions.has(channel) ? { commissionCents: commissions.get(channel)! } : {}) })),
      products: [...products].map(([name, v]) => ({ name, qty: v.qty, cents: v.cents })).sort((a, b) => b.qty - a.qty || b.cents - a.cents),
    };
  };
  app.get<{ Querystring: { from?: string; to?: string; outlet?: string } }>("/api/reports/sales", { preHandler: needs("audit.read") }, async (req, reply) => {
    const scope = await reportScope(req.staff!, req.query.outlet);
    if (scope === "denied") return reply.code(403).send({ error: "outside_your_scope" });
    return salesReport(req.query.from, req.query.to, scope);
  });

  /** One row per outlet this login may see, with the sales summary of each and a total: the brand owner's roll-up. */
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/reports/outlets", { preHandler: needs("audit.read") }, async (req) => {
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    const all = await listOutlets(db, merchantId);
    const mine = all.filter((o) => outletAllowed(visible, o.id));
    const { from, to } = await ordersBetween(req.query.from, req.query.to);
    const rows = [];
    for (const o of mine) rows.push({ outletId: o.id, name: o.name, franchiseId: o.franchiseId, summary: summarize((await ordersBetween(req.query.from, req.query.to, true, [o.id])).orders, config) });
    return { from, to, outlets: rows, total: summarize((await ordersBetween(req.query.from, req.query.to, true, mine.map((o) => o.id))).orders, config) };
  });

  // ---- brands, franchises and outlets --------------------------------------------------------

  /** The franchises and outlets this login may see. The brand owner sees all; a franchise login its franchise; an outlet login its outlet. */
  app.get("/api/outlets", { preHandler: needs("wallet.read") }, async (req) => {
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    const outlets = (await listOutlets(db, merchantId)).filter((o) => outletAllowed(visible, o.id));
    const franchises = (await listFranchises(db, merchantId)).filter((f) => visible === null || outlets.some((o) => o.franchiseId === f.id));
    return { brand: { id: merchantId, name: config.name }, scope: { franchiseId: req.staff!.franchiseId ?? null, outletId: req.staff!.outletId ?? null, brandWide: visible === null }, franchises, outlets };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; active?: boolean } }>("/api/franchises/:id", { preHandler: needs("staff.manage") }, async (req, reply) => {
    if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
    const name = String(req.body?.name ?? "").trim().slice(0, 60);
    if (!validId(req.params.id) || !name) return reply.code(400).send({ error: "a valid id and a name are required" });
    await upsertFranchise(db, merchantId, { id: req.params.id, name, active: req.body?.active !== false });
    await audit(db, merchantId, req.staff!.id, "franchise.save", { id: req.params.id, name });
    return { ok: true };
  });

  /**
   * Create or change an outlet. Adding an outlet, moving it between franchises and switching it off are for the brand owner;
   * a manager of an outlet (or of its franchise) can update its name, address, phone and opening hours.
   */
  app.put<{ Params: { id: string }; Body: { name?: string; franchiseId?: string | null; address?: string | null; phone?: string | null; hours?: string | null; active?: boolean; serviceMode?: string | null; prepMinutes?: number | null; latitude?: number | null; longitude?: number | null; country?: string; gstRegNo?: string | null; uen?: string | null; gstOn?: boolean | null } }>("/api/outlets/:id", { preHandler: needs("device.manage") }, async (req, reply) => {
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    const id = req.params.id;
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!validId(id) || !name) return reply.code(400).send({ error: "a valid id and a name are required" });
    const existing = (await listOutlets(db, merchantId)).find((o) => o.id === id);
    if (!outletAllowed(visible, id)) return reply.code(403).send({ error: "outside_your_scope" });
    const text = (v: unknown, max: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
    let franchiseId = existing?.franchiseId ?? null;
    let active = existing?.active ?? true;
    if (!existing || b.franchiseId !== undefined || b.active !== undefined) {
      if (visible !== null) return reply.code(403).send({ error: "brand_only" });
      if (b.franchiseId !== undefined) franchiseId = b.franchiseId || null;
      if (b.active !== undefined) active = b.active !== false;
      if (franchiseId && !(await listFranchises(db, merchantId)).some((f) => f.id === franchiseId)) return reply.code(400).send({ error: "unknown_franchise" });
    }
    if (b.serviceMode != null && b.serviceMode !== "qsr" && b.serviceMode !== "tsr" && b.serviceMode !== "retail") return reply.code(400).send({ error: "service mode is qsr (quick service, no table), tsr (table service) or retail (a shop that sells by scanning)" });
    const serviceMode = b.serviceMode === "qsr" || b.serviceMode === "tsr" || b.serviceMode === "retail" ? b.serviceMode : null;
    if (b.prepMinutes != null && (!Number.isInteger(b.prepMinutes) || b.prepMinutes < 0 || b.prepMinutes > 600)) return reply.code(400).send({ error: "prepMinutes is a whole number of minutes, 0 to 600" });
    const prepMinutes = b.prepMinutes === undefined ? existing?.prepMinutes ?? null : b.prepMinutes;
    // Coordinates come as a pair (or both cleared with null); left out, the saved ones stay.
    const sentCoords = b.latitude !== undefined || b.longitude !== undefined;
    if (sentCoords && !((b.latitude === null && b.longitude === null) || validCoordinates(b.latitude, b.longitude))) return reply.code(400).send({ error: "latitude is -90 to 90 and longitude -180 to 180; send both, or both null to clear" });
    const latitude = sentCoords ? b.latitude ?? null : existing?.latitude ?? null;
    const longitude = sentCoords ? b.longitude ?? null : existing?.longitude ?? null;
    // Where the outlet is and its tax registration are the brand owner's to set: they decide the tax charged and whether a receipt is a tax invoice.
    if (b.country !== undefined && !isTaxCountry(b.country)) return reply.code(400).send({ error: "unknown_country", message: `Tax is set up for: ${Object.values(TAX_PACKS).map((p) => p.countryName).join(", ")}.` });
    if (b.gstOn !== undefined && b.gstOn !== null && typeof b.gstOn !== "boolean") return reply.code(400).send({ error: "gstOn is true, false, or null to follow the brand" });
    const gstOn = b.gstOn === undefined ? existing?.gstOn ?? null : b.gstOn;
    const reg = (v: unknown) => { const t = text(v, 24); return t && /^[A-Za-z0-9-]+$/.test(t) ? t.toUpperCase() : t === null ? null : undefined; };
    const country = b.country ?? existing?.country ?? DEFAULT_COUNTRY;
    const gstRegNo = b.gstRegNo === undefined ? existing?.gstRegNo ?? null : reg(b.gstRegNo);
    const uen = b.uen === undefined ? existing?.uen ?? null : reg(b.uen);
    if (gstRegNo === undefined || uen === undefined) return reply.code(400).send({ error: "bad_registration", message: "A registration number is letters, digits and dashes only." });
    if (visible !== null && existing && (country !== existing.country || gstRegNo !== existing.gstRegNo || uen !== existing.uen || gstOn !== existing.gstOn)) return reply.code(403).send({ error: "brand_only", message: "Only the brand owner can change an outlet's country, its tax, or its registration numbers." });
    await upsertOutlet(db, merchantId, { id, name, franchiseId, address: text(b.address, 200), phone: text(b.phone, 40), hours: text(b.hours, 120), active, serviceMode, prepMinutes, latitude, longitude, country, gstRegNo, uen, gstOn });
    await audit(db, merchantId, req.staff!.id, "outlet.save", { id, name, franchiseId, serviceMode, prepMinutes, country, gstRegNo, uen, gstOn, created: !existing });
    await applyOutletTax();
    return { ok: true };
  });

  // ---- one outlet's menu: what it overrides of the brand's menu (items off or sold out, its own build rules, sold-out options) ----

  app.get<{ Params: { id: string } }>("/api/outlets/:id/menu", { preHandler: needs("device.manage") }, async (req, reply) => {
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), req.params.id)) return reply.code(403).send({ error: "outside_your_scope" });
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === req.params.id)) return reply.code(404).send({ error: "outlet_not_found" });
    return loadOutletMenu(db, merchantId, req.params.id);
  });

  /** The menu's time windows at one outlet, and the clock they are read on. */
  app.get<{ Params: { id: string } }>("/api/outlets/:id/windows", { preHandler: needs("device.manage") }, async (req, reply) => {
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), req.params.id)) return reply.code(403).send({ error: "outside_your_scope" });
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === req.params.id)) return reply.code(404).send({ error: "outlet_not_found" });
    return loadOutletWindows(db, merchantId, req.params.id);
  });
  /** Replace the windows (null removes them) and/or set the time zone. Orderable hours are independent of the outlet's opening hours. */
  app.put<{ Params: { id: string }; Body: { windows?: MenuWindows | null; timeZone?: string } }>("/api/outlets/:id/windows", { preHandler: needs("device.manage") }, async (req, reply) => {
    const { id } = req.params;
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), id)) return reply.code(403).send({ error: "outside_your_scope" });
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === id)) return reply.code(404).send({ error: "outlet_not_found" });
    const b = req.body ?? {};
    if (typeof b !== "object" || Array.isArray(b)) return reply.code(400).send({ error: "send an object" });
    if (b.windows !== undefined && b.windows !== null && (typeof b.windows !== "object" || Array.isArray(b.windows))) return reply.code(400).send({ error: "windows must be an object with menu, categories and/or products, or null to remove them" });
    if (b.timeZone !== undefined && (typeof b.timeZone !== "string" || !isTimeZone(b.timeZone))) return reply.code(400).send({ error: "timeZone must be a time zone name such as Asia/Singapore" });
    if (b.windows) {
      const problems = validateWindows(b.windows);
      if (problems.length) return reply.code(400).send({ error: "invalid_change", problems });
    }
    await saveOutletWindows(db, merchantId, id, { windows: b.windows, timeZone: b.timeZone });
    await audit(db, merchantId, req.staff!.id, "outlet.windows", { outlet: id, windows: b.windows, timeZone: b.timeZone });
    return loadOutletWindows(db, merchantId, id);
  });

  /** Whether an outlet takes orders for a chosen pickup time, how far apart the times are and how many days ahead. */
  app.get<{ Params: { id: string } }>("/api/outlets/:id/scheduling", { preHandler: needs("device.manage") }, async (req, reply) => {
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), req.params.id)) return reply.code(403).send({ error: "outside_your_scope" });
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === req.params.id)) return reply.code(404).send({ error: "outlet_not_found" });
    return loadOutletScheduling(db, merchantId, req.params.id);
  });
  app.put<{ Params: { id: string }; Body: { on?: boolean; intervalMinutes?: number; daysAhead?: number } }>("/api/outlets/:id/scheduling", { preHandler: needs("device.manage") }, async (req, reply) => {
    const { id } = req.params;
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), id)) return reply.code(403).send({ error: "outside_your_scope" });
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === id)) return reply.code(404).send({ error: "outlet_not_found" });
    const b = req.body ?? {};
    if (b.on !== undefined && typeof b.on !== "boolean") return reply.code(400).send({ error: "on is true or false" });
    if (b.intervalMinutes !== undefined && ![5, 10, 15, 20, 30, 60].includes(b.intervalMinutes)) return reply.code(400).send({ error: "intervalMinutes is 5, 10, 15, 20, 30 or 60" });
    if (b.daysAhead !== undefined && (!Number.isInteger(b.daysAhead) || b.daysAhead < 0 || b.daysAhead > 30)) return reply.code(400).send({ error: "daysAhead is a whole number of days, 0 to 30" });
    await saveOutletScheduling(db, merchantId, id, b);
    await audit(db, merchantId, req.staff!.id, "outlet.scheduling", { outlet: id, ...b });
    return loadOutletScheduling(db, merchantId, id);
  });

  /** Change one item at one outlet. Only what is sent changes; null removes an override; an item left with none is back to following the brand. */
  app.put<{ Params: { id: string; productId: string }; Body: { off?: boolean; soldOut?: boolean | null; builder?: BuilderSpec | null; soldOutOptions?: string[] } }>("/api/outlets/:id/menu/:productId", { preHandler: needs("device.manage") }, async (req, reply) => {
    const { id, productId } = req.params;
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), id)) return reply.code(403).send({ error: "outside_your_scope" });
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === id)) return reply.code(404).send({ error: "outlet_not_found" });
    const b = req.body ?? {};
    if (typeof b !== "object" || Array.isArray(b)) return reply.code(400).send({ error: "send an object" });
    if (b.off !== undefined && typeof b.off !== "boolean") return reply.code(400).send({ error: "off must be true or false" });
    if (b.soldOut !== undefined && b.soldOut !== null && typeof b.soldOut !== "boolean") return reply.code(400).send({ error: "soldOut must be true, false or null" });
    if (b.builder !== undefined && b.builder !== null && (typeof b.builder !== "object" || Array.isArray(b.builder))) return reply.code(400).send({ error: "builder must be an object, or null to go back to the brand's rules" });
    if (b.soldOutOptions !== undefined && (!Array.isArray(b.soldOutOptions) || b.soldOutOptions.some((x) => typeof x !== "string"))) return reply.code(400).send({ error: "soldOutOptions must be a list of option ids" });
    const current = (await loadOutletMenu(db, merchantId, id)).menu[productId] ?? {};
    const next = { ...current };
    if (b.off !== undefined) { if (b.off) next.off = true; else delete next.off; }
    if (b.soldOut !== undefined) { if (b.soldOut === null) delete next.soldOut; else next.soldOut = b.soldOut; }
    if (b.builder !== undefined) { if (b.builder === null) delete next.builder; else next.builder = b.builder; }
    if (b.soldOutOptions !== undefined) { if (b.soldOutOptions.length) next.soldOutOptions = [...new Set(b.soldOutOptions)]; else delete next.soldOutOptions; }
    const problems = validateOutletOverride(await catalog.load(), productId, next);
    if (problems.length) return reply.code(400).send({ error: "invalid_change", problems });
    await saveOutletOverride(db, merchantId, id, productId, next);
    await audit(db, merchantId, req.staff!.id, "outlet.menu", { outlet: id, productId, override: next });
    return loadOutletMenu(db, merchantId, id);
  });

  // ---- options the owner can switch: service charge and tax ------------------------------------

  app.get("/api/settings", { preHandler: needs("wallet.read") }, async () => ({ ...optionsOf(config), serviceRate: config.pricing.serviceRate, gstRate: config.pricing.gstRate, taxName: config.pricing.taxName ?? "GST", country: config.pricing.country ?? DEFAULT_COUNTRY }));
  app.put<{ Body: Partial<Record<(typeof OPTION_KEYS)[number], boolean>> }>("/api/settings", { preHandler: needs("staff.manage") }, async (req, reply) => {
    if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const k of OPTION_KEYS) if (b[k] !== undefined && typeof b[k] !== "boolean") return reply.code(400).send({ error: `${k} must be true or false` });
    const changed: Record<string, boolean> = {};
    for (const k of OPTION_KEYS) {
      if (typeof b[k] !== "boolean") continue;
      await saveSetting(db, merchantId, k, b[k]);
      applyOption(config, k, b[k] as boolean);
      changed[k] = b[k] as boolean;
    }
    await audit(db, merchantId, req.staff!.id, "settings.save", changed);
    return { ...optionsOf(config), serviceRate: config.pricing.serviceRate, gstRate: config.pricing.gstRate, taxName: config.pricing.taxName ?? "GST", country: config.pricing.country ?? DEFAULT_COUNTRY };
  });

  app.get("/api/settings/kiosk", { preHandler: needs("wallet.read") }, async () => loadKiosk(db, merchantId));
  app.put<{ Body: unknown }>("/api/settings/kiosk", { preHandler: needs("staff.manage") }, async (req, reply) => {
    if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
    const next = await saveKiosk(db, merchantId, req.body);
    await audit(db, merchantId, req.staff!.id, "settings.kiosk", next);
    return next;
  });

  // `?outlet=ID` is one outlet's setup: the shop's with that outlet's own changes on top. `overrides` lists what each outlet changes.
  app.get<{ Querystring: { outlet?: string } }>("/api/settings/paynow", { preHandler: needs("wallet.read") }, async (req) => {
    const overrides = await loadPaynowOverrides(db, merchantId);
    return { config: await loadPaynow(db, merchantId, process.env, req.query.outlet), overrides: req.query.outlet ? { [req.query.outlet]: overrides[req.query.outlet] ?? null } : overrides };
  });
  app.put<{ Body: unknown; Querystring: { outlet?: string } }>("/api/settings/paynow", { preHandler: needs("staff.manage") }, async (req, reply) => {
    if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
    if (req.query.outlet) {
      if (!(await listOutlets(db, merchantId)).some((o) => o.id === req.query.outlet)) return reply.code(404).send({ error: "outlet_not_found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const o = await savePaynowOverride(db, merchantId, req.query.outlet, body.reset === true ? null : body);
      if (!o.ok) return reply.code(400).send({ error: o.error });
      await audit(db, merchantId, req.staff!.id, "settings.paynow_outlet", { outlet: req.query.outlet, reset: body.reset === true, outletCode: o.config?.outletCode, receivingAccountEnding: o.config?.receivingAccountEnding });
      return { config: o.config };
    }
    const r = await savePaynow(db, merchantId, req.body);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    await audit(db, merchantId, req.staff!.id, "settings.paynow", { proxyType: r.config.proxyType, displayName: r.config.displayName, outletCode: r.config.outletCode, ttlMinutes: r.config.ttlMinutes });
    return { config: r.config };
  });

  // The till asks for a PayNow QR for an order it has already sent to the server. The amount is what the server says is still owed.
  app.post<{ Body: { orderId?: string } }>("/api/payments/paynow/qr", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const orderId = String(req.body?.orderId ?? "");
    // The outlet that took the order decides whose PayNow it is paid into (its own account and outlet code, or the shop's).
    const cfg = await loadPaynow(db, merchantId, process.env, orderId ? (await store.outletOfOrder?.(orderId)) ?? null : null);
    if (!cfg) return reply.code(409).send({ error: "paynow_not_set_up" });
    const events = orderId ? await store.eventsForOrder(orderId) : [];
    const order = events.length ? reduceOrder(orderId, events) : null;
    if (!order) return reply.code(404).send({ error: "order_not_found" });
    const due = orderTotals(order, config).total - confirmedPaid(order);
    if (order.stage === "cancelled" || due <= 0) return reply.code(409).send({ error: "nothing_to_pay" });
    const q = await issueQr(db, cfg, { merchantId, orderId, amountCents: due, channel: "P", now: (now ?? Date.now)() }).catch((e) => (e instanceof AmountNotAllowed ? e : Promise.reject(e)));
    if (q instanceof AmountNotAllowed) return reply.code(409).send({ error: "amount_not_allowed", minCents: q.minCents, maxCents: q.maxCents });
    return { paymentId: q.paymentId, reference: q.reference, payload: q.payload, expiresAt: q.expiresAt, amountCents: due, displayName: cfg.displayName };
  });

  // Open orders (today and yesterday) that are owed exactly this much: the choices when staff put an unassigned bank payment on an order.
  app.get<{ Querystring: { amount?: string } }>("/api/payments/paynow/candidates", { preHandler: needs("wallet.refund") }, async (req) => {
    const cents = Number(req.query.amount);
    const scope = await visibleOutletIds(db, merchantId, req.staff!);
    const t = (now ?? Date.now)();
    const r = await ordersReport(dayOf(t - 86_400_000), dayOf(t), false, scope);
    return { orders: r.orders.filter((o) => o.stage !== "cancelled" && o.totalCents - o.paidCents === cents && cents > 0).slice(0, 20).map((o) => ({ orderId: o.orderId, queueNumber: o.queueNumber, channel: o.channel, table: o.table, customerName: o.customerName, openedAt: o.openedAt, items: o.lines.reduce((n, l) => n + l.qty, 0) })) };
  });

  // A S$0.01 QR from the saved settings, so the owner can scan it with their own banking app and see the ID and name are right.
  // It is stored like any QR; if paid, the money lands in the unassigned pool (there is no order for it).
  app.post<{ Querystring: { outlet?: string } }>("/api/settings/paynow/test", { preHandler: needs("staff.manage") }, async (req, reply) => {
    const cfg = await loadPaynow(db, merchantId, process.env, req.query.outlet);
    if (!cfg) return reply.code(409).send({ error: "paynow_not_set_up" });
    const q = await issueQr(db, cfg, { merchantId, orderId: "paynow-test", amountCents: 1, channel: "P", now: (now ?? Date.now)(), skipLimits: true });
    return { payload: q.payload, reference: q.reference, expiresAt: q.expiresAt, displayName: cfg.displayName };
  });

  // ---- agents: limited API access for an AI helper or script (owner only) ---------------------

  app.get("/api/agents", { preHandler: needs("staff.manage") }, async () => ({ agents: await listAgents(db, merchantId) }));
  app.post<{ Body: { name?: string } }>("/api/agents", { preHandler: needs("staff.manage") }, async (req, reply) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: "name is required" });
    return createAgent(db, merchantId, name, req.staff!.id); // the key is in this answer and nowhere else
  });
  app.delete<{ Params: { id: string } }>("/api/agents/:id", { preHandler: needs("staff.manage") }, async (req, reply) =>
    (await revokeAgent(db, merchantId, req.params.id, req.staff!.id)) ? { ok: true } : reply.code(404).send({ error: "agent_not_found" }));

  app.get("/api/audit", { preHandler: needs("audit.read") }, async () => ({ entries: await recentAudit(db, merchantId) }));

  // ---- customer ordering and shop look ------------------------------------------------------

  registerDisplay(app, { db, merchantId, needsDevice });
  registerPromoAdmin(app, { db, merchantId, needs });
  const tabs = new TabService({ db, merchantId, config, configFor, eventsForOrder: (id) => store.eventsForOrder(id), members, ingest, now, loadCatalog: () => catalog.load(), alert: (text) => { void (app as unknown as { notifyManagers?: (t: string, all?: boolean) => Promise<void> }).notifyManagers?.(text, true)?.catch(() => undefined); } });
  // Every completed tab payment prints its own receipt: the lines and components as quoted, who paid, who recorded it, and what is left on the tab.
  if (print) {
    tabs.onPaymentCompleted = async (paymentId) => {
      const d = await tabs.receiptData(paymentId);
      if (!d) return;
      const outletName = (await listOutlets(db, merchantId)).find((o) => o.id === d.outletId)?.name ?? config.outletName;
      await print.enqueueDoc(d.outletId, tabPaymentReceipt(d.input, { merchantName: config.name, outletName, now: Date.now() }), `tabreceipt:${paymentId}`, `Tab ${d.input.spot ?? d.input.code}`);
    };
  }
  registerTabRoutes(app, { db, merchantId, tabs, members, needs, outletIds: async () => (await listOutlets(db, merchantId)).map((o) => o.id) });
  registerStock(app, { db, merchantId, needs, outletIds: async () => (await listOutlets(db, merchantId)).map((o) => o.id), defaultOutlet: config.outletName });
  registerShifts(app, { db, merchantId, store, config, needs });
  registerTimeclock(app, { db, merchantId, defaultOutletId: config.outletName, needs, needsDevice });
  registerFloor(app, { db, merchantId, needs });
  registerTill(app, { db, merchantId, needs });
  registerMailboxes(app, { db, merchantId, needs, imapFactory, now });
  registerDiscountPolicy(app, { db, merchantId, needs });
  registerOrderTrail(app, { db, merchantId, store, needs });
  registerShop(app, { db, config, configFor, store, catalog, catalogAdmin, brand: new BrandStore(db, merchantId), ingest, members, needs, integrations, now, tabs, alertMailbox, alertWatchMs, imapFactory });

  // ---- the Telegram bot for managing prices ---------------------------------------------------

  (app as unknown as { escalateTabPages?: (m: number) => Promise<number> }).escalateTabPages = (m) => tabs.escalateUnacknowledged(m);
  // A page for the waiter that nobody answers is sent again after TAB_PAGE_ESCALATE_MIN minutes (default 2).
  if (db && process.env.NODE_ENV !== "test") {
    const mins = Number(process.env.TAB_PAGE_ESCALATE_MIN) > 0 ? Number(process.env.TAB_PAGE_ESCALATE_MIN) : 2;
    const timer = setInterval(() => { void tabs.escalateUnacknowledged(mins).catch(() => undefined); }, 30_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  if (catalogAdmin) registerTelegram(app, { db, merchantId, outletId: config.outletName, needsDevice, integ: integrations ?? { publicUrl: "" }, cat: catalogAdmin as PgCatalogStore, needs, reports: { sales: salesReport, orders: ordersReport, today: () => dayOf(Date.now()), hour: () => hourOf(Date.now()) }, tabs: {
      open: () => tabs.openSummary(),
      view: async (id) => { try { return (await tabs.view(id, "")) as never; } catch { return null; } },
      release: async (id, staffId) => { await tabs.release_(id); await audit(db, merchantId, staffId, "tab.release", { tab: id, via: "telegram" }); },
      ack: (id) => tabs.acknowledgePage(id),
      confirmCash: async (pid, staffId) => { const r = await tabs.confirmCash(pid, staffId); if (r === "ok") await audit(db, merchantId, staffId, "tab.payment_confirmed", { payment: pid, via: "telegram" }); return r; },
      close: async (id, reason, staffId) => { const ok = await tabs.closeTab(id, reason); if (ok) await audit(db, merchantId, staffId, "tab.close", { tab: id, reason, via: "telegram" }); return ok; },
      move: async (id, spot, staffId) => { const r = await tabs.moveTable(id, spot); await audit(db, merchantId, staffId, "tab.move", { tab: id, from: r.from, to: r.to, via: "telegram" }); return r.to; },
      findBySpot: async (spot) => (await db!.query("SELECT id FROM tabs WHERE merchant_id=$1 AND status='open' AND lower(spot)=lower($2) LIMIT 1", [merchantId, spot])).rows[0]?.id ?? null,
    },
    settings: {
      brand: () => {
        const o = optionsOf(config);
        return [
          { key: "serviceChargeOn", label: "Service charge", on: o.serviceChargeOn },
          { key: "gstOn", label: "Tax (GST)", on: o.gstOn },
          { key: "stackable", label: "Coupon and points together", on: o.stackable },
          { key: "pointsItemsEligibleOnly", label: "Points pay only eligible items", on: o.pointsItemsEligibleOnly },
          { key: "pointsDeductService", label: "Points can pay service charge", on: o.pointsDeductService },
          { key: "pointsDeductTax", label: "Points can pay tax", on: o.pointsDeductTax },
          { key: "pointsDeductDeposit", label: "Points can pay container deposit", on: o.pointsDeductDeposit },
        ];
      },
      setBrand: async (key, on, staffId) => {
        if (!(OPTION_KEYS as readonly string[]).includes(key) || !applyOption(config, key, on)) return false;
        await saveSetting(db!, merchantId, key, on);
        await audit(db, merchantId, staffId, "settings.save", { [key]: on, via: "telegram" });
        return true;
      },
      outlets: async () => {
        const out = [];
        for (const o of await listOutlets(db, merchantId)) { const t = await tabs.outletSettings(o.id); out.push({ id: o.id, name: o.name, tableService: t.tableService, tabService: t.tabService, allocation: t.allocation }); }
        return out;
      },
      setOutlet: async (id, change, staffId) => {
        try { await tabs.saveOutletSettings(id, change); } catch (e) { return e instanceof TabError ? String(e.body.message ?? e.body.error) : "That did not save."; }
        await audit(db, merchantId, staffId, "outlet.tab_settings", { outlet: id, ...change, via: "telegram" });
        return null;
      },
    } });

  // ---- devices ----------------------------------------------------------------------------

  /** A new device trades a one-time code for its token. Open route, so attempts are limited per IP. */
  app.post<{ Body: { code?: string; name?: string } }>("/api/devices/enroll", async (req, reply) => {
    const { code, name } = req.body ?? {};
    if (!code || !name) return reply.code(400).send({ error: "code and name required" });
    if (enrollFailures.blocked(req.ip)) return reply.code(429).send({ error: "too_many_attempts" });
    const r = await enroll(db, merchantId, code, name.slice(0, 60));
    if (!r) {
      enrollFailures.fail(req.ip);
      return reply.code(401).send({ error: "invalid_or_expired_code" });
    }
    await audit(db, merchantId, r.enrolledBy, "device.enroll", { deviceId: r.device.id, name: r.device.name });
    return { token: r.token, deviceId: r.device.id, outletId: r.device.outletId };
  });

  app.post<{ Body: { deviceId?: string; testing?: boolean; outletId?: string } }>("/api/devices/enrollment", { preHandler: needs("device.manage") }, async (req, reply) => {
    // A new device is enrolled at an outlet: the one asked for, or the login's own outlet, or the default one.
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    const outletId = req.body?.outletId || (visible && visible.length === 1 ? visible[0]! : config.outletName);
    if (!(await listOutlets(db, merchantId)).some((o) => o.id === outletId)) return reply.code(400).send({ error: "unknown_outlet" });
    if (!outletAllowed(visible, outletId)) return reply.code(403).send({ error: "outside_your_scope" });
    const c = await createEnrollmentCode(db, { merchantId, outletId, createdBy: req.staff!.id, deviceId: req.body?.deviceId, testing: !!req.body?.testing });
    await audit(db, merchantId, req.staff!.id, "device.code", { reissue: req.body?.deviceId ?? null, testing: !!req.body?.testing });
    return c;
  });

  app.get("/api/devices", { preHandler: needs("device.manage") }, async (req) => {
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    return { devices: (await listDevices(db, merchantId)).filter((d) => outletAllowed(visible, d.outlet_id as string)) };
  });

  app.post<{ Params: { id: string } }>("/api/devices/:id/revoke", { preHandler: needs("device.manage") }, async (req, reply) => {
    if (req.params.id === req.device!.id) return reply.code(400).send({ error: "cannot_revoke_this_device" });
    const target = (await listDevices(db, merchantId)).find((d) => d.id === req.params.id);
    if (target && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), target.outlet_id as string)) return reply.code(403).send({ error: "outside_your_scope" });
    const ok = await revokeDevice(db, merchantId, req.params.id);
    if (!ok) return reply.code(404).send({ error: "not_found_or_already_revoked" });
    await audit(db, merchantId, req.staff!.id, "device.revoke", { deviceId: req.params.id });
    return { ok: true };
  });


  // ---- catalog changes (managers and owners) -----------------------------------------------

  if (catalogAdmin) {
    const cat = catalogAdmin;
    /** Run a change, audit it with who/what/old→new, and answer with the new catalog version. */
    const changed = async (req: FastifyRequest, reply: FastifyReply, action: string, run: () => Promise<ChangeResult>) => {
      // The menu and prices belong to the brand: a franchise or outlet login can read them but not change them.
      if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
      const r = await run();
      if (!r.ok) return reply.code(400).send({ error: "invalid_change", problems: r.problems });
      await audit(db, merchantId, req.staff!.id, `catalog.${action}`, r.detail);
      return { version: r.version, ...r.detail };
    };
    const manage = { preHandler: needs("catalog.manage") };
    const isCents = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
    const KINDS = ["dine_in", "takeaway", "delivery", "other"];
    const bad = (reply: FastifyReply, msg: string) => reply.code(400).send({ error: msg });

    app.put<{ Params: { id: string; productId: string }; Body: { priceCents?: number | null } }>(
      "/api/catalog/pricebooks/:id/prices/:productId",
      manage,
      async (req, reply) => {
        const p = req.body?.priceCents;
        if (p !== null && !isCents(p)) return bad(reply, "priceCents must be a whole number of cents, 0 or more, or null to remove");
        return changed(req, reply, "price", () => cat.setPrice(req.params.id, req.params.productId, p as number | null));
      },
    );

    app.put<{ Params: { id: string }; Body: { barcode?: string | null } }>("/api/catalog/products/:id/barcode", manage, async (req, reply) => {
      const b = req.body?.barcode;
      if (b !== null && typeof b !== "string") return bad(reply, "barcode is text, or null to remove it");
      return changed(req, reply, "product.barcode", () => cat.setBarcode(req.params.id, b === null || b.trim() === "" ? null : b));
    });

    app.put<{ Params: { id: string } }>("/api/catalog/products/:id/image", manage, async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "send the photo as image/png, image/jpeg or image/webp" });
      return changed(req, reply, "product.image", () => cat.setImage(req.params.id, req.body as Buffer));
    });

    app.post<{ Body: { name?: string; missing?: "show" | "hide" } }>("/api/catalog/pricebooks", manage, async (req, reply) => {
      const { name, missing = "show" } = req.body ?? {};
      if (!name?.trim() || !["show", "hide"].includes(missing)) return bad(reply, "name and a valid missing rule are required");
      return changed(req, reply, "pricebook.create", () => cat.createPricebook(name.trim(), missing));
    });

    app.patch<{ Params: { id: string }; Body: { name?: string; missing?: "show" | "hide" } }>("/api/catalog/pricebooks/:id", manage, async (req, reply) => {
      const { name, missing } = req.body ?? {};
      if ((missing && !["show", "hide"].includes(missing)) || (name !== undefined && !name.trim())) return bad(reply, "invalid name or missing rule");
      return changed(req, reply, "pricebook.update", () => cat.updatePricebook(req.params.id, { name: name?.trim(), missing }));
    });

    /** Switch an item off (or back on) in one pricebook: hidden from online ordering, greyed out on a till. It keeps its price. */
    app.put<{ Params: { id: string; productId: string }; Body: { off?: boolean } }>("/api/catalog/pricebooks/:id/off/:productId", manage, async (req, reply) => {
      if (typeof req.body?.off !== "boolean") return bad(reply, "off must be true or false");
      return changed(req, reply, "pricebook.off", () => cat.setOff(req.params.id, req.params.productId, req.body!.off!));
    });

    /** Edit many items in one pricebook at once: { prices: { itemId: cents | null }, off: { itemId: true | false } }. All or nothing. */
    app.post<{ Params: { id: string }; Body: { prices?: Record<string, number | null>; off?: Record<string, boolean>; memberPrices?: Record<string, number | null> } }>("/api/catalog/pricebooks/:id/bulk", manage, async (req, reply) => {
      const { prices, off, memberPrices } = req.body ?? {};
      if ((!prices && !off && !memberPrices) || Object.keys(prices ?? {}).length + Object.keys(off ?? {}).length + Object.keys(memberPrices ?? {}).length > 2000) return bad(reply, "send prices, memberPrices and/or off, up to 2000 changes");
      for (const v of Object.values(memberPrices ?? {})) if (v !== null && !isCents(v)) return bad(reply, "every member price must be a whole number of cents, 0 or more, or null to remove");
      for (const v of Object.values(prices ?? {})) if (v !== null && !isCents(v)) return bad(reply, "every price must be a whole number of cents, 0 or more, or null to remove");
      for (const v of Object.values(off ?? {})) if (typeof v !== "boolean") return bad(reply, "off values must be true or false");
      return changed(req, reply, "pricebook.bulk", () => cat.bulkUpdate(req.params.id, { prices, off, memberPrices }));
    });

    /** A new pricebook that copies this one (every price and switch), with a new channel of the same name pointed at it. */
    app.post<{ Params: { id: string }; Body: { name?: string; kind?: ChannelKind } }>("/api/catalog/pricebooks/:id/clone", manage, async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name || name.length > 40) return bad(reply, "a name of up to 40 characters is required");
      if (req.body?.kind && !KINDS.includes(req.body.kind)) return bad(reply, "unknown channel kind");
      return changed(req, reply, "pricebook.clone", () => cat.clonePricebook(name, { fromPricebookId: req.params.id, kind: req.body?.kind }));
    });

    app.post<{ Body: { id?: string; name?: string; kind?: ChannelKind; serviceCharge?: boolean; active?: boolean; commission?: { ratePct?: number } | null } }>("/api/catalog/channels", manage, async (req, reply) => {
      const b = req.body ?? {};
      if (!b.name?.trim() || !b.kind || !KINDS.includes(b.kind)) return bad(reply, "name and a valid kind are required");
      return changed(req, reply, "channel", () =>
        cat.upsertChannel({ id: b.id, name: b.name!.trim(), kind: b.kind!, serviceCharge: !!b.serviceCharge, active: b.active !== false, ...(b.commission === null ? { commission: null } : b.commission && typeof b.commission.ratePct === "number" ? { commission: { ratePct: b.commission.ratePct } } : {}) }),
      );
    });

    app.put<{ Body: { pricebookId?: string; outletId?: string; channelId?: string } }>("/api/catalog/assignments", manage, async (req, reply) => {
      const { pricebookId, outletId, channelId } = req.body ?? {};
      if (!pricebookId || (!outletId && !channelId)) return bad(reply, "pricebookId and an outletId and/or channelId are required");
      return changed(req, reply, "assign", () => cat.assign(pricebookId, outletId, channelId));
    });

    app.post<{ Body: { outletId?: string; channelId?: string } }>("/api/catalog/assignments/remove", manage, async (req, reply) => {
      const { outletId, channelId } = req.body ?? {};
      if (!outletId && !channelId) return bad(reply, "an outletId and/or channelId is required");
      return changed(req, reply, "unassign", () => cat.unassign(outletId, channelId));
    });

    // Price Zones: HQ (brand-wide logins) only; a store login can never change who uses which pricebook.
    app.put<{ Body: { id?: string; name?: string; outletIds?: string[]; books?: Array<{ channelId?: string; pricebookId?: string }> } }>("/api/catalog/zones", manage, async (req, reply) => {
      if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
      const b = req.body ?? {};
      if (!b.name?.trim()) return bad(reply, "a zone needs a name");
      if (!Array.isArray(b.outletIds) || b.outletIds.some((x) => typeof x !== "string")) return bad(reply, "outletIds must be a list of outlet ids");
      const known = new Set((await listOutlets(db, merchantId)).map((o) => o.id));
      const unknown = b.outletIds.filter((x) => !known.has(x));
      if (unknown.length) return bad(reply, `unknown outlets: ${unknown.join(", ")}`);
      const books = (Array.isArray(b.books) ? b.books : []).map((x) => ({ ...(x.channelId ? { channelId: String(x.channelId) } : {}), pricebookId: String(x.pricebookId ?? "") }));
      return changed(req, reply, "zone", () => cat.saveZone({ id: b.id, name: b.name!, outletIds: b.outletIds!, books }));
    });

    app.delete<{ Params: { id: string } }>("/api/catalog/zones/:id", manage, async (req, reply) => {
      if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
      return changed(req, reply, "zone.delete", () => cat.deleteZone(req.params.id));
    });

    // Promotional prices: a price for one item for a stretch of time. HQ (brand-wide logins) only.
    app.put<{ Body: { id?: string; title?: string; productId?: string; pricebookId?: string | null; priceCents?: number; startsAt?: number | string; endsAt?: number | string } }>("/api/catalog/overrides", manage, async (req, reply) => {
      if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
      const b = req.body ?? {};
      const at = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);
      const startsAt = at(b.startsAt), endsAt = at(b.endsAt);
      if (!b.title?.trim() || !b.productId || !Number.isSafeInteger(b.priceCents) || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return bad(reply, "title, productId, priceCents, startsAt and endsAt are required");
      return changed(req, reply, "override", () => cat.saveOverride({ id: b.id, title: b.title!, productId: b.productId!, ...(b.pricebookId ? { pricebookId: b.pricebookId } : {}), priceCents: b.priceCents!, startsAt, endsAt }));
    });

    app.delete<{ Params: { id: string } }>("/api/catalog/overrides/:id", manage, async (req, reply) => {
      if ((await visibleOutletIds(db, merchantId, req.staff!)) !== null) return reply.code(403).send({ error: "brand_only" });
      return changed(req, reply, "override.delete", () => cat.deleteOverride(req.params.id));
    });

    app.put<{ Body: { pricebookId?: string } }>("/api/catalog/default-pricebook", manage, async (req, reply) => {
      if (!req.body?.pricebookId) return bad(reply, "pricebookId required");
      return changed(req, reply, "default", () => cat.setDefaultPricebook(req.body!.pricebookId!));
    });

    app.post<{ Body: { from?: string; to?: string; names?: Record<string, string> } }>("/api/catalog/categories/rename", manage, async (req, reply) => {
      const from = req.body?.from?.trim(), to = req.body?.to?.trim();
      if (!from || !to) return bad(reply, "from and to are required");
      const names = req.body?.names;
      if (names !== undefined && (!names || typeof names !== "object" || Array.isArray(names))) return bad(reply, "names must be an object of language code to name");
      return changed(req, reply, "category", () => cat.renameCategory(from, to, names));
    });

    app.post<{ Body: { id?: string; name?: string; category?: string; soldOut?: boolean; pointsExempt?: boolean; bcrs?: boolean; priceCents?: number; description?: string; altName?: string; names?: Record<string, string>; builder?: BuilderSpec | null; taxInclusive?: boolean | null; taxGroup?: string | null; stock?: ProductStock | null; options?: OptionGroup[] } }>(
      "/api/catalog/products",
      manage,
      async (req, reply) => {
        const b = req.body ?? {};
        if (!b.name?.trim() || !b.category?.trim()) return bad(reply, "name and category are required");
        if (b.priceCents !== undefined && !isCents(b.priceCents)) return bad(reply, "priceCents must be a whole number of cents, 0 or more");
        if (b.names !== undefined && (!b.names || typeof b.names !== "object" || Array.isArray(b.names))) return bad(reply, "names must be an object of language code to name");
        if (b.taxInclusive !== undefined && b.taxInclusive !== null && typeof b.taxInclusive !== "boolean") return bad(reply, "taxInclusive must be true, false or null");
        if (b.stock) {
          const known = new Set((await db.query("SELECT id FROM inventory_items WHERE merchant_id=$1", [merchantId])).rows.map((x) => x.id as string));
          const problems = validateProductStock(b.stock, b.name ?? "this product", (id) => known.has(id));
          if (problems.length) return reply.code(400).send({ error: "invalid_stock", problems });
        }
        if (b.taxGroup !== undefined && b.taxGroup !== null && (typeof b.taxGroup !== "string" || b.taxGroup.length > 40)) return bad(reply, "taxGroup must be a short name or null");
        if (b.builder !== undefined && b.builder !== null && (typeof b.builder !== "object" || Array.isArray(b.builder))) return bad(reply, "builder must be an object with groups or variants, or null to remove it");
        return changed(req, reply, "product", () =>
          cat.upsertProduct({ id: b.id, name: b.name!.trim(), category: b.category!.trim(), soldOut: b.soldOut, pointsExempt: b.pointsExempt, bcrs: b.bcrs, priceCents: b.priceCents, description: b.description, altName: b.altName, names: b.names, builder: b.builder, taxInclusive: b.taxInclusive, taxGroup: b.taxGroup, stock: b.stock, options: b.options }),
        );
      },
    );
  }


  /**
   * The Rezein app on a tablet with a SIM forwards each text it receives. A customer proves their phone by texting the
   * code the page showed them; when the sender's number and the code match an open challenge, they are signed in.
   */
  app.post<{ Body: { from?: string; body?: string; partial?: boolean } }>("/api/print/sms", { preHandler: needsDevice }, async (req) => {
    const from = String(req.body?.from ?? "").replace(/\D/g, "");
    if (!members || from.length < 8 || from.length > 15) return { matched: false };
    const partial = req.body?.partial === true && from.length >= 7 && from.length <= 12;
    const matched = await members.matchSms(from, String(req.body?.body ?? "").slice(0, 200), partial);
    if (matched) console.log(`[sms sign-in] verified ${from.slice(0, 4)}… via ${req.device!.id}`);
    return { matched };
  });


  /** The Rezein app tells us the number of the SIM it receives texts on, so customers are shown the right number to text. */
  app.put<{ Body: { number?: string } }>("/api/print/sms/number", { preHandler: needsDevice }, async (req, reply) => {
    const raw = String(req.body?.number ?? "").trim();
    if (raw === "") {
      if (db) await setSmsNumber(db, req.device!.id, null);
      return { ok: true, number: null };
    }
    const digits = raw.replace(/\D/g, "");
    if (!/^\+?[\d\s-]{8,20}$/.test(raw) || digits.length < 8 || digits.length > 15) return reply.code(400).send({ error: "that does not look like a phone number" });
    const number = `${raw.startsWith("+") ? "+" : ""}${digits}`;
    if (db) await setSmsNumber(db, req.device!.id, number);
    return { ok: true, number };
  });

  // ---- printers and the print queue -------------------------------------------------------

  if (print) {
    const queue = print;
    // Printer problems that need a person (a ticket moved to a backup, a printer with none, one that keeps failing) also go to linked managers and owners on Telegram.
    const alertedBefore = queue.onAlert;
    queue.onAlert = async (text, a) => {
      await alertedBefore?.(text, a);
      await (app as unknown as { notifyManagers?: (t: string) => Promise<void> }).notifyManagers?.(`Printer alert: ${text}`);
    };
    const manage = { preHandler: needs("print.manage") };

    app.get("/api/printers", manage, async (req) => {
      const visible = await visibleOutletIds(db, merchantId, req.staff!);
      return { printers: (await queue.listPrinters()).filter((p) => outletAllowed(visible, p.outletId)) };
    });

    app.put<{ Params: { id: string }; Body: Partial<Printer> }>("/api/printers/:id", manage, async (req, reply) => {
      const b = req.body ?? {};
      const p: Printer = {
        id: req.params.id,
        name: (b.name ?? "").trim(),
        outletId: b.outletId ?? config.outletName,
        language: b.language as Printer["language"],
        roles: b.roles as Printer["roles"],
        categories: b.categories ?? [],
        widthChars: b.widthChars ?? 42,
        drawer: !!b.drawer,
        raster: !!b.raster,
        labelWidthMm: b.labelWidthMm ?? null,
        labelHeightMm: b.labelHeightMm ?? null,
        dpi: b.dpi === 300 ? 300 : 203,
        connection: b.connection as Printer["connection"],
        agentDeviceId: b.agentDeviceId ?? null,
        active: b.active !== false,
        cutMode: (b.cutMode ?? "grouped") as Printer["cutMode"],
        showQueue: b.showQueue === true,
        backupPrinterId: typeof b.backupPrinterId === "string" && b.backupPrinterId ? b.backupPrinterId : null,
      };
      const problems = validatePrinter(p);
      // The backup takes the same bytes, so it has to be a real, different kitchen printer at this outlet with the same width and mode.
      if (p.backupPrinterId) {
        const bk = (await queue.listPrinters()).find((x) => x.id === p.backupPrinterId);
        if (p.backupPrinterId === p.id) problems.push("a printer cannot be its own backup");
        else if (!bk) problems.push("the backup printer does not exist");
        else if (bk.outletId !== p.outletId) problems.push("the backup printer must be at the same outlet");
        else if (!bk.roles.includes("kitchen") || !p.roles.includes("kitchen")) problems.push("only a kitchen printer can have a kitchen backup");
        else if (bk.widthChars !== p.widthChars || bk.raster !== p.raster || bk.language !== p.language) problems.push("the backup must have the same paper width and print mode, so the same ticket prints correctly on it");
      }
      if (problems.length) return reply.code(400).send({ error: "invalid_printer", problems });
      const visible = await visibleOutletIds(db, merchantId, req.staff!);
      const existing = (await queue.listPrinters()).find((x) => x.id === p.id);
      if (!outletAllowed(visible, p.outletId) || (existing && !outletAllowed(visible, existing.outletId))) return reply.code(403).send({ error: "outside_your_scope" });
      await queue.savePrinter(p);
      await audit(db, merchantId, req.staff!.id, "printer.save", { id: p.id, name: p.name, roles: p.roles });
      return { ok: true };
    });

    /** What staff need to act on: tickets that were moved to a backup, printers with no backup, and printers that keep failing. */
    app.get("/api/print/alerts", manage, async (req) => {
      const visible = await visibleOutletIds(db, merchantId, req.staff!);
      return { alerts: (await queue.listAlerts()).filter((a) => outletAllowed(visible, a.outletId)) };
    });
    app.post<{ Params: { id: string } }>("/api/print/alerts/:id/resolve", manage, async (req, reply) => ((await queue.resolveAlert(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "alert_not_found" })));

    app.post<{ Params: { id: string } }>("/api/printers/:id/test", manage, async (req, reply) => {
      const mineOnly = await visibleOutletIds(db, merchantId, req.staff!);
      const target = (await queue.listPrinters()).find((x) => x.id === req.params.id);
      if (target && !outletAllowed(mineOnly, target.outletId)) return reply.code(403).send({ error: "outside_your_scope" });
      const ok = await queue.testPage(req.params.id, Date.now());
      return ok ? { ok: true } : reply.code(404).send({ error: "printer_not_found" });
    });

    app.get<{ Querystring: { status?: string; limit?: string; offset?: string; title?: string; orderId?: string } }>("/api/print/jobs", manage, async (req) => {
      const visible = await visibleOutletIds(db, merchantId, req.staff!);
      const jobs = await queue.listJobs(req.query.status, Number(req.query.limit) || 100, { offset: Number(req.query.offset) || 0, title: req.query.title || undefined, orderId: req.query.orderId || undefined });
      return { jobs: jobs.filter((j) => outletAllowed(visible, j.outlet_id as string)) };
    });

    app.post<{ Params: { id: string } }>("/api/print/jobs/:id/retry", manage, async (req, reply) => {
      const jobOutlet = await queue.jobOutlet(req.params.id);
      if (jobOutlet && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), jobOutlet)) return reply.code(403).send({ error: "outside_your_scope" });
      const ok = await queue.retryFailed(req.params.id);
      if (ok) await audit(db, merchantId, req.staff!.id, "print.retry", { jobId: req.params.id });
      return ok ? { ok: true } : reply.code(404).send({ error: "not_a_failed_job" });
    });

    /** The print state of some orders, for the badge on each order card. Any staff member may look. */
    app.get<{ Querystring: { ids?: string } }>("/api/print/order-status", { preHandler: needs("print.reprint") }, async (req) => {
      const ids = String(req.query.ids ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 100);
      return { statuses: await queue.statusForOrders(ids) };
    });

    /** Any staff member can ask for a receipt (or a kitchen ticket) again. */
    app.post<{ Body: { orderId?: string; docType?: "receipt" | "kitchen"; printerId?: string; modifiers?: boolean } }>("/api/print/reprint", { preHandler: needs("print.reprint") }, async (req, reply) => {
      const { orderId, docType, printerId } = req.body ?? {};
      if (!orderId || (docType !== "receipt" && docType !== "kitchen")) return reply.code(400).send({ error: "orderId and docType (receipt or kitchen) required" });
      const order = reduceOrder(orderId, await store.eventsForOrder(orderId));
      if (!order) return reply.code(404).send({ error: "order_not_found" });
      const orderOutlet = (await store.outletOfOrder?.(orderId)) ?? undefined;
      if (orderOutlet && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), orderOutlet)) return reply.code(403).send({ error: "outside_your_scope" });
      const queued = await queue.reprint(order, docType, { catalog: await catalog.load(), config, print: await printCtxFor(order, orderOutlet), outletId: orderOutlet, printModifiers: req.body?.modifiers === true }, printerId);
      await audit(db, merchantId, req.staff!.id, "print.reprint", { orderId, docType, queued });
      return queued ? { queued } : reply.code(409).send({ error: "no_printer_for_this" });
    });

    /** Print the guest check (the whole bill, or one check of a split bill) on the outlet's receipt printers. Nothing is recorded as paid. */
    app.post<{ Params: { id: string }; Body: { checkId?: string } }>("/api/orders/:id/guest-check", { preHandler: needs("print.reprint") }, async (req, reply) => {
      const order = reduceOrder(req.params.id, await store.eventsForOrder(req.params.id));
      if (!order) return reply.code(404).send({ error: "order_not_found" });
      const outletId = (await store.outletOfOrder?.(req.params.id)) ?? undefined;
      if (outletId && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), outletId)) return reply.code(403).send({ error: "outside_your_scope" });
      const checkId = req.body?.checkId;
      if (checkId && !order.split?.checks.some((c) => c.id === checkId)) return reply.code(404).send({ error: "check_not_found" });
      const doc = guestCheck(order, config, await printCtxFor(order, outletId), { checkId });
      const made = await print.enqueueDoc(outletId ?? config.outletName, doc, `guestcheck:${order.orderId}:${checkId ?? "all"}:${Date.now()}:${Math.random()}`, `Guest check ${order.spot ?? order.queueNumber ?? ""}`.trim());
      await audit(db, merchantId, req.staff!.id, "print.guest_check", { orderId: order.orderId, checkId: checkId ?? null, queued: made });
      return made ? { queued: made } : reply.code(409).send({ error: "no_printer_for_this" });
    });

    /** The receipt as text, for a screen preview: modifiers only when asked for (?modifiers=1). Nothing is printed. */
    app.get<{ Params: { id: string }; Querystring: { modifiers?: string } }>("/api/orders/:id/receipt", { preHandler: needs("print.reprint") }, async (req, reply) => {
      const order = reduceOrder(req.params.id, await store.eventsForOrder(req.params.id));
      if (!order) return reply.code(404).send({ error: "order_not_found" });
      const outletId = (await store.outletOfOrder?.(req.params.id)) ?? undefined;
      if (outletId && !outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), outletId)) return reply.code(403).send({ error: "outside_your_scope" });
      const doc = receipt(order, config, await printCtxFor(order, outletId), { printModifiers: req.query.modifiers === "1" });
      return { text: plainText(doc, 42).join("\n") };
    });

    /** No-sale / change: opens the till without printing anything. Cashiers and up; every use is audited. */
    app.post<{ Body: { reason?: string } }>("/api/print/drawer", { preHandler: needs("print.reprint") }, async (req, reply) => {
      const queued = await queue.openDrawer();
      await audit(db, merchantId, req.staff!.id, "drawer.open", { reason: String(req.body?.reason ?? "").slice(0, 80) || null, queued });
      return queued ? { queued } : reply.code(409).send({ error: "no_drawer_printer" });
    });

    // The delivery agent (a hub app or small service) is a device, not a person: device token only.
    const agent = { preHandler: needsDevice };

    app.post<{ Body: { limit?: number } }>("/api/print/claim", agent, async (req) => {
      if (db) await markPrintPoll(db, req.device!.id);
      const jobs = await queue.claim(req.device!.id, Math.min(Math.max(1, Number(req.body?.limit) || 10), 25));
      return {
        jobs: jobs.map((j) => ({
          id: j.id,
          docType: j.docType,
          attempt: j.attempts,
          printer: { id: j.printer.id, name: j.printer.name, host: j.printer.connection.host, port: j.printer.connection.port },
          payloadBase64: j.payload.toString("base64"),
        })),
      };
    });

    /**
     * Quick service: once the kitchen has really received every ticket of a paid online order, the order is ready to serve, and the
     * customer's page says so. A printer that failed or is unconfirmed keeps the order in the queue until someone sorts it out.
     */
    async function readyWhenPrinted(orderId: string) {
      if (config.paymentTiming !== "prepay" || !(await queue.kitchenFullyPrinted(orderId))) return;
      const events = await store.eventsForOrder(orderId);
      const order = reduceOrder(orderId, events);
      if (!order || order.source !== "online" || !order.acceptedAt || ["preparing", "ready", "completed", "cancelled"].includes(order.stage)) return;
      const seq = events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
      await ingest([{ id: newId(), orderId, deviceId: "shop", ts: Date.now(), seq, type: "StageSet", stage: "ready" } as OrderEvent]);
    }

    app.post<{ Params: { id: string } }>("/api/print/jobs/:id/done", agent, async (req, reply) => {
      if (!(await queue.markDone(req.params.id))) return reply.code(404).send({ error: "not_leased" });
      const info = await queue.jobInfo(req.params.id);
      if (info?.docType === "kitchen" && info.orderId) await readyWhenPrinted(info.orderId).catch((e) => console.error("[print] could not mark the order ready:", e instanceof Error ? e.message : e));
      return { ok: true };
    });

    app.post<{ Params: { id: string }; Body: { error?: string; ambiguous?: boolean } }>("/api/print/jobs/:id/failed", agent, async (req, reply) => {
      const r = await queue.markFailed(req.params.id, req.body?.error ?? "unknown error", req.body?.ambiguous === true);
      return r === "unknown" ? reply.code(404).send({ error: "not_leased" }) : { result: r };
    });
  }

  // ---- prepaid credit ---------------------------------------------------------------------

  type MoneyBody = { customerId?: string; amountCents?: number; idempotencyKey?: string; orderId?: string; deviceId?: string; note?: string };
  const valid = (b: MoneyBody | undefined) =>
    !!b?.customerId && !!b.idempotencyKey && Number.isSafeInteger(b.amountCents) && (b.amountCents as number) > 0;

  /** Credit by member for reports: what they started with, what was added later, what they spent, and what is left. */
  app.get("/api/reports/credit", { preHandler: needs("wallet.read") }, async () => {
    const r = await db.query(
      `SELECT w.customer_id, m.name, m.phone, w.balance_cents,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='topup' AND e.idempotency_key LIKE 'open:%'),0) AS opening,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='topup' AND e.idempotency_key NOT LIKE 'open:%'),0) AS topups,
              COALESCE(-SUM(e.amount_cents) FILTER (WHERE e.kind='spend'),0) AS spent,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='refund'),0) AS refunds,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='adjust'),0) AS adjustments
         FROM wallets w
         LEFT JOIN members m ON m.merchant_id = w.merchant_id AND m.id::text = w.customer_id
         LEFT JOIN ledger_entries e ON e.wallet_id = w.id
        WHERE w.merchant_id=$1
        GROUP BY w.id, m.name, m.phone`,
      [merchantId],
    );
    return {
      members: r.rows.map((x) => ({
        id: x.customer_id as string, name: (x.name as string | null) ?? null, phone: (x.phone as string | null) ?? null,
        openingCents: Number(x.opening), topupsCents: Number(x.topups), spentCents: Number(x.spent), refundsCents: Number(x.refunds), adjustmentsCents: Number(x.adjustments), balanceCents: Number(x.balance_cents),
      })),
    };
  });

  /** One member's credit history, newest first: every top-up, purchase, refund and adjustment, and who made it. */
  app.get<{ Params: { id: string } }>("/api/members/:id/credit-history", { preHandler: needs("wallet.read") }, async (req) => {
    const r = await db.query(
      `SELECT e.kind, e.amount_cents, e.balance_after, e.idempotency_key, e.order_id, e.note, e.device_id, e.created_at, s.name AS staff_name, s.code AS staff_code
         FROM ledger_entries e
         JOIN wallets w ON w.id = e.wallet_id
         LEFT JOIN staff s ON s.id = e.staff_id
        WHERE w.merchant_id=$1 AND w.customer_id=$2
        ORDER BY e.created_at DESC, e.id DESC LIMIT 200`,
      [merchantId, req.params.id],
    );
    return {
      entries: r.rows.map((x) => ({
        kind: x.kind as string,
        amountCents: Number(x.amount_cents),
        balanceAfterCents: Number(x.balance_after),
        opening: String(x.idempotency_key).startsWith("open:"),
        orderId: (x.order_id as string | null) ?? null,
        note: (x.note as string | null) ?? null,
        by: (x.staff_name as string | null) ? `${x.staff_name} (${x.staff_code})` : x.device_id === "shop" || x.device_id === "SHOP" ? "Customer (online order)" : null,
        at: x.created_at as Date,
      })),
    };
  });

  app.get<{ Params: { customerId: string } }>("/api/wallet/:customerId", { preHandler: needs("wallet.read") }, async (req) => ({
    balanceCents: await balanceOf(db, merchantId, req.params.customerId),
  }));

  // Refunds are checked against what the order took, one at a time, so two at once cannot both pass the check.
  let refundChain: Promise<void> = Promise.resolve();
  const refundLock = () => {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = refundChain;
    refundChain = refundChain.then(() => mine);
    return prev.then(() => release);
  };

  /**
   * The books, for the event's close: opening balances + other credits - debits + reversals must equal what the wallets hold now,
   * and every wallet must equal its own entries.
   */
  app.get("/api/wallet/reconciliation", { preHandler: needs("audit.read") }, async () => {
    const t = await db.query(
      `SELECT COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='topup' AND e.idempotency_key LIKE 'open:%'),0) AS opening,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='topup' AND e.idempotency_key NOT LIKE 'open:%'),0) AS credits,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='spend'),0) AS debits,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='refund'),0) AS reversals,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='adjust'),0) AS adjustments,
              COUNT(*) AS entries
       FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.merchant_id=$1`,
      [merchantId],
    );
    const c = await db.query("SELECT COALESCE(SUM(balance_cents),0) AS closing, COUNT(*) AS wallets FROM wallets WHERE merchant_id=$1", [merchantId]);
    const bad = await db.query(
      `SELECT w.customer_id, w.balance_cents AS stored, COALESCE(SUM(e.amount_cents),0) AS rebuilt
       FROM wallets w LEFT JOIN ledger_entries e ON e.wallet_id=w.id WHERE w.merchant_id=$1 GROUP BY w.id HAVING w.balance_cents <> COALESCE(SUM(e.amount_cents),0)`,
      [merchantId],
    );
    const r = t.rows[0];
    const opening = Number(r.opening), credits = Number(r.credits), debits = Number(r.debits), reversals = Number(r.reversals), adjustments = Number(r.adjustments), closing = Number(c.rows[0].closing);
    return {
      openingCents: opening, creditsCents: credits, debitsCents: debits, reversalsCents: reversals, adjustmentsCents: adjustments, closingCents: closing,
      wallets: Number(c.rows[0].wallets), entries: Number(r.entries),
      // debits are stored negative, so the sum of the parts is the closing balance
      balanced: opening + credits + debits + reversals + adjustments === closing && bad.rowCount === 0,
      mismatchedWallets: bad.rows.map((x) => ({ customerId: x.customer_id as string, storedCents: Number(x.stored), rebuiltCents: Number(x.rebuilt) })),
    };
  });

  /** Freeze or unfreeze all member credit. Frozen: it cannot be spent (online orders and staff credit payments are refused). Balances stay. */
  app.get("/api/credit/freeze", { preHandler: needs("wallet.read") }, async () => ({ frozen: await creditFrozen(db, merchantId), allowed: await creditExemptIds(db, merchantId) }));
  /** Let one member keep spending their credit while the freeze is on (or take that away again). */
  app.put<{ Params: { id: string }; Body: { allowed?: boolean } }>("/api/credit/freeze/members/:id", { preHandler: needs("wallet.refund") }, async (req, reply) => {
    if (typeof req.body?.allowed !== "boolean") return reply.code(400).send({ error: "allowed (true or false) is required" });
    await setCreditExempt(db, merchantId, req.params.id, req.body.allowed);
    await audit(db, merchantId, req.staff!.id, req.body.allowed ? "credit.freeze_allow" : "credit.freeze_disallow", { memberId: req.params.id });
    return { memberId: req.params.id, allowed: req.body.allowed };
  });
  app.put<{ Body: { frozen?: boolean } }>("/api/credit/freeze", { preHandler: needs("wallet.refund") }, async (req, reply) => {
    if (typeof req.body?.frozen !== "boolean") return reply.code(400).send({ error: "frozen (true or false) is required" });
    await setCreditFrozen(db, merchantId, req.body.frozen);
    await audit(db, merchantId, req.staff!.id, req.body.frozen ? "credit.freeze" : "credit.unfreeze", {});
    return { frozen: req.body.frozen };
  });

  const routes = [
    ["topup", topUp, "wallet.topup"],
    ["spend", spend, "wallet.spend"],
    ["refund", refund, "wallet.refund"],
  ] as const;
  for (const [path, fn, permission] of routes) {
    app.post<{ Body: MoneyBody }>(`/api/wallet/${path}`, { preHandler: needs(permission) }, async (req, reply) => {
      const b = req.body;
      if (!valid(b)) return reply.code(400).send({ error: "customerId, idempotencyKey and a positive integer amountCents are required" });
      if (path === "spend" && (await creditBlockedFor(db, merchantId, b!.customerId!))) return reply.code(403).send({ ok: false, error: "credit_frozen", message: "Member credit is frozen. It cannot be spent until it is switched back on." });
      const staff = req.staff!;
      if (path === "topup" && staff.role === "cashier" && b!.amountCents! > CASHIER_TOPUP_LIMIT_CENTS) {
        return reply.code(403).send({ error: "over_limit", limitCents: CASHIER_TOPUP_LIMIT_CENTS });
      }
      // A refund is a linked reversal: it must name the order it reverses, and cannot exceed what that order took from this wallet.
      if (path === "refund") {
        if (!b!.orderId) return reply.code(400).send({ error: "orderId_required", message: "A refund must name the order it reverses." });
        const release = await refundLock();
        try {
          const t = await db.query(
            `SELECT COALESCE(-SUM(e.amount_cents) FILTER (WHERE e.kind='spend'),0) AS spent, COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind='refund'),0) AS refunded
             FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.merchant_id=$1 AND w.customer_id=$2 AND e.order_id=$3 AND NOT (e.kind='refund' AND e.idempotency_key=$4)`,
            [merchantId, b!.customerId, b!.orderId, b!.idempotencyKey],
          );
          const remaining = Number(t.rows[0].spent) - Number(t.rows[0].refunded);
          const already = await db.query("SELECT 1 FROM ledger_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.merchant_id=$1 AND w.customer_id=$2 AND e.idempotency_key=$3", [merchantId, b!.customerId, b!.idempotencyKey]);
          if (!already.rowCount && b!.amountCents! > remaining) return reply.code(409).send({ ok: false, error: "over_refund", remainingCents: Math.max(0, remaining) });
          const r = await refund(db, { merchantId, customerId: b!.customerId!, amountCents: b!.amountCents!, idempotencyKey: b!.idempotencyKey!, orderId: b!.orderId, deviceId: req.device!.id, outletId: config.outletName, staffId: staff.id, note: b!.note });
          if (r.ok && !r.replayed) await audit(db, merchantId, staff.id, "wallet.refund", { customerId: b!.customerId, amountCents: b!.amountCents, orderId: b!.orderId });
          return r.ok ? r : reply.code(409).send(r);
        } finally {
          release();
        }
      }
      const r = await fn(db, {
        merchantId,
        customerId: b!.customerId!,
        amountCents: b!.amountCents!,
        idempotencyKey: b!.idempotencyKey!,
        orderId: b!.orderId,
        deviceId: req.device!.id, // from the enrolled device, never from the request body
        outletId: config.outletName,
        staffId: staff.id,
        note: b!.note,
      });
      if (r.ok && !r.replayed && path !== "spend") {
        await audit(db, merchantId, staff.id, `wallet.${path}`, { customerId: b!.customerId, amountCents: b!.amountCents, orderId: b!.orderId });
      }
      return r.ok ? r : reply.code(409).send(r);
    });
  }

  // ---- members, for the shop's own staff -----------------------------------------------------
  // A member's prepaid credit is the wallet whose customer id is the member's id, so the existing top-up, spend and
  // refund routes above manage it. These two routes list members with both balances and adjust reward points.
  if (members) {
    app.get<{ Querystring: { q?: string } }>("/api/members", { preHandler: needs("wallet.read") }, async (req) => {
      const q = String(req.query.q ?? "").trim().slice(0, 60);
      const r = await db.query(
        `SELECT m.id, m.name, m.email, m.phone, m.points_balance, m.created_at, COALESCE(w.balance_cents, 0) AS credit_cents
           FROM members m LEFT JOIN wallets w ON w.merchant_id = m.merchant_id AND w.customer_id = m.id::text
          WHERE m.merchant_id = $1 AND ($2 = '' OR m.name ILIKE $3 OR m.email ILIKE $3 OR m.phone ILIKE $3)
          ORDER BY m.created_at DESC LIMIT 50`,
        [merchantId, q, `%${q.replace(/[%_\\]/g, "")}%`],
      );
      const total = await db.query("SELECT count(*)::int AS n FROM members WHERE merchant_id = $1", [merchantId]);
      return {
        total: total.rows[0].n as number,
        members: r.rows.map((m) => ({ id: m.id as string, name: m.name as string | null, email: m.email as string | null, phone: m.phone as string | null, points: Number(m.points_balance), creditCents: Number(m.credit_cents), joinedAt: m.created_at as Date })),
      };
    });

    /** Add one member by hand, optionally with opening credit. An email or a phone number is needed so they can sign in. */
    app.post<{ Body: { name?: string; email?: string; phone?: string; creditCents?: number } }>("/api/members", { preHandler: needs("wallet.topup") }, async (req, reply) => {
      const b = req.body ?? {};
      const credit = b.creditCents === undefined || b.creditCents === null ? 0 : b.creditCents;
      if (!Number.isSafeInteger(credit) || credit < 0 || credit > 1_000_000) return reply.code(400).send({ error: "creditCents must be a whole number of cents, zero or more" });
      if (credit > 0 && req.staff!.role === "cashier" && credit > CASHIER_TOPUP_LIMIT_CENTS) return reply.code(403).send({ error: "over_limit", limitCents: CASHIER_TOPUP_LIMIT_CENTS });
      const r = await members.createByStaff({ name: b.name, email: b.email, phone: b.phone });
      if (!r.ok) return reply.code(400).send({ error: r.error });
      if (r.created) {
        await audit(db, merchantId, req.staff!.id, "member.create", { memberId: r.member.id, creditCents: credit });
        if (credit > 0) await topUp(db, { merchantId, customerId: r.member.id, amountCents: credit, idempotencyKey: `open:${r.member.id}`, deviceId: req.device!.id, outletId: config.outletName, staffId: req.staff!.id, note: "Opening credit" });
      }
      return { created: r.created, member: { id: r.member.id, name: r.member.name, email: r.member.email, phone: r.member.phone }, creditCents: await balanceOf(db, merchantId, r.member.id) };
    });

    /** One member as the till shows them: who they are, their credit and points, and their last orders (customer history at the POS). */
    app.get<{ Params: { id: string } }>("/api/members/:id/summary", { preHandler: needs("wallet.read") }, async (req, reply) => {
      const m = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await members.byId(req.params.id) : null;
      if (!m) return reply.code(404).send({ error: "member_not_found" });
      const recent = [];
      for (const r of await members.orderIds(m.id, 8)) {
        const o = reduceOrder(r.orderId, await store.eventsForOrder(r.orderId));
        if (!o || !o.lines.some((l) => l.qty > 0)) continue;
        const live = o.lines.filter((l) => l.qty > 0);
        recent.push({ orderId: o.orderId, at: o.paidAt ?? o.openedAt, totalCents: orderTotals(o, config).total, status: o.voided ? "voided" : o.stage === "cancelled" ? "cancelled" : isFullyPaid(o, config) ? "paid" : "open", items: live.slice(0, 4).map((l) => `${l.qty}× ${l.name}`).join(", ") + (live.length > 4 ? ` +${live.length - 4} more` : ""), where: o.channelName ?? o.fulfilment });
      }
      return {
        member: { id: m.id, name: m.name, phone: m.phone, email: m.email, points: m.pointsBalance, creditCents: await balanceOf(db, merchantId, m.id) },
        rewards: { pointsEnabled: config.rewards.pointsEnabled, minPointsRedeem: config.pricing.minPointsRedeem },
        recent,
      };
    });

    /**
     * Points as payment at the till: taken from the member's balance for one order, once (the order's id is the key, so a retry never takes
     * them twice). The till then writes the redemption onto the order. Refused when the programme is off or the balance is short.
     */
    app.post<{ Params: { id: string }; Body: { points?: number; orderId?: string } }>("/api/members/:id/redeem", { preHandler: needs("wallet.spend") }, async (req, reply) => {
      if (!config.rewards.pointsEnabled) return reply.code(409).send({ error: "points_off", message: "The points programme is switched off." });
      const pts = req.body?.points, orderId = String(req.body?.orderId ?? "");
      if (!Number.isSafeInteger(pts) || (pts as number) <= 0 || !orderId || orderId.length > 64) return reply.code(400).send({ error: "points (a whole number above zero) and orderId are required" });
      const m = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await members.byId(req.params.id) : null;
      if (!m) return reply.code(404).send({ error: "member_not_found" });
      await members.linkOrder(orderId, m.id, 0);
      const r = await members.post(m.id, "redeem", -(pts as number), `redeem:${orderId}`, { orderId });
      if (!r) return reply.code(409).send({ error: "not_enough_points", points: (await members.byId(m.id))?.pointsBalance ?? 0 });
      await db.query("UPDATE member_orders SET points_redeemed = GREATEST(points_redeemed, $3) WHERE order_id=$1 AND merchant_id=$2", [orderId, merchantId, pts]);
      await audit(db, merchantId, req.staff!.id, "member.redeem", { memberId: m.id, orderId, points: pts });
      return { ok: true, points: r.balance, replayed: r.replayed };
    });

    /**
     * Add many members from a file. Each row is {name, email, phone, credit} (credit in dollars). A person who is already
     * a member (same email or phone) is left alone and gets no credit, so sending the same file twice changes nothing.
     */
    app.post<{ Body: { source?: string; rows?: Array<{ name?: unknown; email?: unknown; phone?: unknown; credit?: unknown }> } }>("/api/members/import", { preHandler: needs("wallet.refund") }, async (req, reply) => {
      const rows = req.body?.rows;
      if (!Array.isArray(rows) || rows.length === 0) return reply.code(400).send({ error: "rows[] required" });
      if (rows.length > 1000) return reply.code(400).send({ error: "too_many_rows", max: 1000 });
      const results: Array<{ row: number; status: "created" | "exists" | "invalid"; why?: string; creditCents?: number }> = [];
      let created = 0, existed = 0, invalid = 0, credited = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? {};
        const rawCredit = r.credit === undefined || r.credit === null ? "" : String(r.credit).trim().replace(/^s?\$/i, "").replace(/[,\s]/g, "");
        const dollars = rawCredit === "" ? 0 : Number(rawCredit);
        const cents = Math.round(dollars * 100);
        if (!Number.isFinite(dollars) || cents < 0 || cents > 1_000_000) { invalid++; results.push({ row: i + 1, status: "invalid", why: "credit is not a valid amount" }); continue; }
        const m = await members.createByStaff({ name: typeof r.name === "string" ? r.name : null, email: typeof r.email === "string" ? r.email : null, phone: typeof r.phone === "string" || typeof r.phone === "number" ? String(r.phone) : null });
        if (!m.ok) { invalid++; results.push({ row: i + 1, status: "invalid", why: m.error === "need_phone_or_email" ? "needs an email or a phone number" : m.error === "bad_email" ? "the email looks wrong" : "the phone number looks wrong" }); continue; }
        if (!m.created) { existed++; results.push({ row: i + 1, status: "exists" }); continue; }
        created++;
        if (cents > 0) {
          await topUp(db, { merchantId, customerId: m.member.id, amountCents: cents, idempotencyKey: `open:${m.member.id}`, deviceId: req.device!.id, outletId: config.outletName, staffId: req.staff!.id, note: `Opening credit (import${req.body?.source ? `: ${String(req.body.source).slice(0, 80)}` : ""})` });
          credited += cents;
        }
        results.push({ row: i + 1, status: "created", creditCents: cents });
      }
      await audit(db, merchantId, req.staff!.id, "member.import", { source: req.body?.source ?? null, rows: rows.length, created, existed, invalid, creditedCents: credited });
      return { created, existed, invalid, creditedCents: credited, results };
    });

    /**
     * When the text does not arrive (the hub phone is off, the signal is bad), a staff member can approve a waiting
     * sign-in after checking the person in front of them. Approving lets that person into the member's account and credit.
     */
    app.get("/api/members/pending-signins", { preHandler: needs("wallet.spend") }, async () => ({ pending: await members.pendingSms() }));
    app.post<{ Params: { id: string } }>("/api/members/pending-signins/:id/approve", { preHandler: needs("wallet.spend") }, async (req, reply) => {
      const phone = await members.approveSms(req.params.id);
      if (!phone) return reply.code(404).send({ error: "not_waiting" });
      await audit(db, merchantId, req.staff!.id, "signin.approve", { phone: `+${phone.slice(0, 4)}…${phone.slice(-2)}` });
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>("/api/members/pending-signins/:id/reject", { preHandler: needs("wallet.spend") }, async (req, reply) => ((await members.rejectSms(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "not_waiting" })));

    /** A manager corrects a member's credit to an exact amount. One adjustment entry for the difference, with the reason and who did it. */
    app.post<{ Params: { id: string }; Body: { newBalanceCents?: number; reason?: string; idempotencyKey?: string } }>("/api/members/:id/credit-set", { preHandler: needs("wallet.refund") }, async (req, reply) => {
      const { newBalanceCents, idempotencyKey } = req.body ?? {};
      const reason = String(req.body?.reason ?? "").trim().slice(0, 120);
      if (!Number.isSafeInteger(newBalanceCents) || (newBalanceCents as number) < 0 || (newBalanceCents as number) > 10_000_000 || !idempotencyKey || !reason) {
        return reply.code(400).send({ error: "newBalanceCents (zero or more, in cents), a reason and an idempotencyKey are required" });
      }
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || !(await members.byId(req.params.id))) return reply.code(404).send({ error: "member_not_found" });
      const r = await adjustTo(db, { merchantId, customerId: req.params.id, targetCents: newBalanceCents as number, idempotencyKey, staffId: req.staff!.id, deviceId: req.device!.id, outletId: config.outletName, note: `${req.staff!.name}: ${reason}` });
      if (r.changed && !r.replayed) await audit(db, merchantId, req.staff!.id, "member.credit_set", { memberId: req.params.id, deltaCents: r.deltaCents, balanceCents: r.balanceCents, reason });
      return r;
    });

    /** Add or take away reward points by hand. Managers and owners only; a reason is required and the change is audited. */
    app.post<{ Params: { id: string }; Body: { points?: number; note?: string; idempotencyKey?: string } }>("/api/members/:id/points", { preHandler: needs("wallet.refund") }, async (req, reply) => {
      const { points, idempotencyKey } = req.body ?? {};
      const note = String(req.body?.note ?? "").trim().slice(0, 120);
      if (!Number.isSafeInteger(points) || points === 0 || Math.abs(points!) > 1_000_000 || !idempotencyKey || !note) return reply.code(400).send({ error: "points (a whole number, not zero), a reason and idempotencyKey are required" });
      if (!(await members.byId(req.params.id))) return reply.code(404).send({ error: "member_not_found" });
      const r = await members.post(req.params.id, "adjust", points!, `staff-adjust-${idempotencyKey}`, { note: `${req.staff!.name}: ${note}` });
      if (!r) return reply.code(409).send({ error: "not_enough_points" });
      if (!r.replayed) await audit(db, merchantId, req.staff!.id, "member.points", { memberId: req.params.id, points, note });
      return { balance: r.balance, replayed: r.replayed };
    });
  }

  return app;
}
