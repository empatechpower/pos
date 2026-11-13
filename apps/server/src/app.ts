import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { confirmedPaid, isFullyPaid, menuFor, newId, reduceOrder, shopStatus, type BusinessConfig, type ChannelKind, type OptionGroup, type OrderEvent } from "@pos/core";
import { CASHIER_TOPUP_LIMIT_CENTS, audit, authenticate, can, createStaff, login, logout, recentAudit, type Permission, type Role, type Staff } from "./auth.js";
import type { CatalogStore, ChangeResult, PgCatalogStore } from "./catalog.js";
import type { Db } from "./db/pool.js";
import { adjustTo, balanceOf, refund, spend, topUp } from "./ledger.js";
import { authenticateDevice, createEnrollmentCode, enroll, markPrintPoll, setSmsNumber, issueStreamTicket, listDevices, redeemStreamTicket, revokeDevice, type Device } from "./devices.js";
import { BrandStore } from "./brand.js";
import { PrintStore, validatePrinter, type Printer } from "./print.js";
import { registerShop } from "./shop.js";
import { sendMail, type Integrations } from "./integrations.js";
import { registerTelegram } from "./telegram.js";
import { MemberStore } from "./members.js";
import { FailureLimiter } from "./rateLimit.js";
import type { EventStore, StoredEvent } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    staff?: Staff;
    device?: Device;
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
}

const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer\s+/i, "");
const deviceToken = (req: FastifyRequest) => {
  const h = req.headers["x-device-token"];
  return Array.isArray(h) ? h[0] : h;
};

export async function buildApp({ config, store, db, catalog, catalogAdmin, print, logger = true, trustProxy = false, integrations }: Deps) {
  const app = Fastify({ logger, trustProxy });
  // Logo uploads arrive as raw image bytes.
  app.addContentTypeParser(["image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: 300 * 1024 + 1 }, (_req, body, done) => done(null, body));
  await app.register(cors, { origin: true });
  const merchantId = config.businessId;

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

  app.get("/api/config", async () => config);
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
  async function queuePrints(orderIds: string[]) {
    try {
      const cat = await catalog.load();
      for (const id of orderIds) {
        const order = reduceOrder(id, await store.eventsForOrder(id));
        if (order) await print!.enqueueForOrder(order, { catalog: cat, config, print: { merchantName: config.name, outletName: config.outletName, now: Date.now() } });
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

  /** Store events, tell live screens, queue whatever now needs printing. Used for tills and for customers' orders alike. */
  async function ingest(events: OrderEvent[]): Promise<StoredEvent[]> {
    const added = await store.append(events);
    if (added.length) for (const push of streams) push(added);
    const touched = [...new Set(added.map((a) => a.event.orderId))];
    if (added.length && print) await queuePrints(touched);
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
    const added = await ingest(events);
    return { accepted: events.length, stored: added.length, latestSeq: await store.latestSeq() };
  });

  /** Devices pull everything newer than the last server sequence they have seen. */
  app.get<{ Querystring: { after?: string } }>("/api/sync/pull", { preHandler: needsDevice }, async (req) => {
    const after = Number(req.query.after ?? 0) || 0;
    return { events: await store.after(after), latestSeq: await store.latestSeq() };
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
  const needs = (permission: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.post<{ Body: { code?: string; pin?: string } }>("/api/auth/login", { preHandler: needsDevice }, async (req, reply) => {
    const { code, pin } = req.body ?? {};
    if (!code || !pin) return reply.code(400).send({ error: "code and pin required" });
    const who = req.device!.id;
    if (loginFailures.blocked(who)) return reply.code(429).send({ error: "locked" });
    const r = await login(db, merchantId, code, pin);
    if (!r.ok) {
      if (r.reason === "invalid") loginFailures.fail(who);
      return reply.code(r.reason === "locked" ? 429 : 401).send({ error: r.reason });
    }
    return { token: r.token, expiresAt: r.expiresAt, staff: { name: r.staff.name, code: r.staff.code, role: r.staff.role } };
  });

  app.get("/api/auth/me", { preHandler: needs("wallet.read") }, async (req) => ({ name: req.staff!.name, code: req.staff!.code, role: req.staff!.role }));

  app.post("/api/auth/logout", async (req) => {
    const t = bearer(req);
    if (t) await logout(db, t);
    return { ok: true };
  });

  app.post<{ Body: { code?: string; name?: string; role?: Role; pin?: string } }>("/api/staff", { preHandler: needs("staff.manage") }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.code || !b.name || !b.pin || !b.role || !["cashier", "manager", "owner"].includes(b.role)) {
      return reply.code(400).send({ error: "code, name, pin and a valid role are required" });
    }
    try {
      const s = await createStaff(db, { merchantId, code: b.code, name: b.name, role: b.role, pin: b.pin });
      await audit(db, merchantId, req.staff!.id, "staff.create", { code: s.code, role: s.role });
      return { code: s.code, name: s.name, role: s.role };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "could not create staff" });
    }
  });

  app.get("/api/audit", { preHandler: needs("audit.read") }, async () => ({ entries: await recentAudit(db, merchantId) }));

  // ---- customer ordering and shop look ------------------------------------------------------

  registerShop(app, { db, config, store, catalog, catalogAdmin, brand: new BrandStore(db, merchantId), ingest, members, needs, integrations });

  // ---- the Telegram bot for managing prices ---------------------------------------------------

  if (catalogAdmin) registerTelegram(app, { db, merchantId, outletId: config.outletName, integ: integrations ?? { publicUrl: "" }, cat: catalogAdmin as PgCatalogStore, needs });

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

  app.post<{ Body: { deviceId?: string; testing?: boolean } }>("/api/devices/enrollment", { preHandler: needs("device.manage") }, async (req) => {
    const c = await createEnrollmentCode(db, { merchantId, outletId: config.outletName, createdBy: req.staff!.id, deviceId: req.body?.deviceId, testing: !!req.body?.testing });
    await audit(db, merchantId, req.staff!.id, "device.code", { reissue: req.body?.deviceId ?? null, testing: !!req.body?.testing });
    return c;
  });

  app.get("/api/devices", { preHandler: needs("device.manage") }, async () => ({ devices: await listDevices(db, merchantId) }));

  app.post<{ Params: { id: string } }>("/api/devices/:id/revoke", { preHandler: needs("device.manage") }, async (req, reply) => {
    if (req.params.id === req.device!.id) return reply.code(400).send({ error: "cannot_revoke_this_device" });
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
    app.post<{ Params: { id: string }; Body: { prices?: Record<string, number | null>; off?: Record<string, boolean> } }>("/api/catalog/pricebooks/:id/bulk", manage, async (req, reply) => {
      const { prices, off } = req.body ?? {};
      if ((!prices && !off) || Object.keys(prices ?? {}).length + Object.keys(off ?? {}).length > 2000) return bad(reply, "send prices and/or off, up to 2000 changes");
      for (const v of Object.values(prices ?? {})) if (v !== null && !isCents(v)) return bad(reply, "every price must be a whole number of cents, 0 or more, or null to remove");
      for (const v of Object.values(off ?? {})) if (typeof v !== "boolean") return bad(reply, "off values must be true or false");
      return changed(req, reply, "pricebook.bulk", () => cat.bulkUpdate(req.params.id, { prices, off }));
    });

    /** A new pricebook that copies this one (every price and switch), with a new channel of the same name pointed at it. */
    app.post<{ Params: { id: string }; Body: { name?: string; kind?: ChannelKind } }>("/api/catalog/pricebooks/:id/clone", manage, async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name || name.length > 40) return bad(reply, "a name of up to 40 characters is required");
      if (req.body?.kind && !KINDS.includes(req.body.kind)) return bad(reply, "unknown channel kind");
      return changed(req, reply, "pricebook.clone", () => cat.clonePricebook(name, { fromPricebookId: req.params.id, kind: req.body?.kind }));
    });

    app.post<{ Body: { id?: string; name?: string; kind?: ChannelKind; serviceCharge?: boolean; active?: boolean } }>("/api/catalog/channels", manage, async (req, reply) => {
      const b = req.body ?? {};
      if (!b.name?.trim() || !b.kind || !KINDS.includes(b.kind)) return bad(reply, "name and a valid kind are required");
      return changed(req, reply, "channel", () =>
        cat.upsertChannel({ id: b.id, name: b.name!.trim(), kind: b.kind!, serviceCharge: !!b.serviceCharge, active: b.active !== false }),
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

    app.put<{ Body: { pricebookId?: string } }>("/api/catalog/default-pricebook", manage, async (req, reply) => {
      if (!req.body?.pricebookId) return bad(reply, "pricebookId required");
      return changed(req, reply, "default", () => cat.setDefaultPricebook(req.body!.pricebookId!));
    });

    app.post<{ Body: { id?: string; name?: string; category?: string; soldOut?: boolean; pointsExempt?: boolean; priceCents?: number; description?: string; altName?: string; options?: OptionGroup[] } }>(
      "/api/catalog/products",
      manage,
      async (req, reply) => {
        const b = req.body ?? {};
        if (!b.name?.trim() || !b.category?.trim()) return bad(reply, "name and category are required");
        if (b.priceCents !== undefined && !isCents(b.priceCents)) return bad(reply, "priceCents must be a whole number of cents, 0 or more");
        return changed(req, reply, "product", () =>
          cat.upsertProduct({ id: b.id, name: b.name!.trim(), category: b.category!.trim(), soldOut: b.soldOut, pointsExempt: b.pointsExempt, priceCents: b.priceCents, description: b.description, altName: b.altName, options: b.options }),
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
    const manage = { preHandler: needs("print.manage") };

    app.get("/api/printers", manage, async () => ({ printers: await queue.listPrinters() }));

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
      };
      const problems = validatePrinter(p);
      if (problems.length) return reply.code(400).send({ error: "invalid_printer", problems });
      await queue.savePrinter(p);
      await audit(db, merchantId, req.staff!.id, "printer.save", { id: p.id, name: p.name, roles: p.roles });
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>("/api/printers/:id/test", manage, async (req, reply) => {
      const ok = await queue.testPage(req.params.id, Date.now());
      return ok ? { ok: true } : reply.code(404).send({ error: "printer_not_found" });
    });

    app.get<{ Querystring: { status?: string } }>("/api/print/jobs", manage, async (req) => ({ jobs: await queue.listJobs(req.query.status) }));

    app.post<{ Params: { id: string } }>("/api/print/jobs/:id/retry", manage, async (req, reply) => {
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
    app.post<{ Body: { orderId?: string; docType?: "receipt" | "kitchen"; printerId?: string } }>("/api/print/reprint", { preHandler: needs("print.reprint") }, async (req, reply) => {
      const { orderId, docType, printerId } = req.body ?? {};
      if (!orderId || (docType !== "receipt" && docType !== "kitchen")) return reply.code(400).send({ error: "orderId and docType (receipt or kitchen) required" });
      const order = reduceOrder(orderId, await store.eventsForOrder(orderId));
      if (!order) return reply.code(404).send({ error: "order_not_found" });
      const queued = await queue.reprint(order, docType, { catalog: await catalog.load(), config, print: { merchantName: config.name, outletName: config.outletName, now: Date.now() } }, printerId);
      await audit(db, merchantId, req.staff!.id, "print.reprint", { orderId, docType, queued });
      return queued ? { queued } : reply.code(409).send({ error: "no_printer_for_this" });
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

  const routes = [
    ["topup", topUp, "wallet.topup"],
    ["spend", spend, "wallet.spend"],
    ["refund", refund, "wallet.refund"],
  ] as const;
  for (const [path, fn, permission] of routes) {
    app.post<{ Body: MoneyBody }>(`/api/wallet/${path}`, { preHandler: needs(permission) }, async (req, reply) => {
      const b = req.body;
      if (!valid(b)) return reply.code(400).send({ error: "customerId, idempotencyKey and a positive integer amountCents are required" });
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
