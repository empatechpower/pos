import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { confirmedPaid, isFullyPaid, menuFor, newId, reduceOrder, type BusinessConfig, type ChannelKind, type OptionGroup, type OrderEvent } from "@pos/core";
import { CASHIER_TOPUP_LIMIT_CENTS, audit, authenticate, can, createStaff, login, logout, recentAudit, type Permission, type Role, type Staff } from "./auth.js";
import type { CatalogStore, ChangeResult, PgCatalogStore } from "./catalog.js";
import type { Db } from "./db/pool.js";
import { balanceOf, refund, spend, topUp } from "./ledger.js";
import { authenticateDevice, createEnrollmentCode, enroll, issueStreamTicket, listDevices, redeemStreamTicket, revokeDevice, type Device } from "./devices.js";
import { BrandStore } from "./brand.js";
import { PrintStore, validatePrinter, type Printer } from "./print.js";
import { registerShop } from "./shop.js";
import type { Integrations } from "./integrations.js";
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

  /** Points follow the order: earned once when it is paid, spent points returned if it is cancelled. */
  async function settleMemberOrders(orderIds: string[]) {
    for (const id of orderIds) {
      const o = reduceOrder(id, await store.eventsForOrder(id));
      if (!o?.memberId) continue;
      if (o.stage === "cancelled") await members!.reverseForOrder(id);
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

  app.post<{ Body: { deviceId?: string } }>("/api/devices/enrollment", { preHandler: needs("device.manage") }, async (req) => {
    const c = await createEnrollmentCode(db, { merchantId, outletId: config.outletName, createdBy: req.staff!.id, deviceId: req.body?.deviceId });
    await audit(db, merchantId, req.staff!.id, "device.code", { reissue: req.body?.deviceId ?? null });
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

    app.post<{ Params: { id: string } }>("/api/print/jobs/:id/done", agent, async (req, reply) => ((await queue.markDone(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "not_leased" })));

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

  return app;
}
