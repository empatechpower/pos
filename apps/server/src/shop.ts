import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { newId, orderTotals, quoteOrder, reduceOrder, shopStatus, type BusinessConfig, type OrderEvent } from "@pos/core";
import { audit, type Permission } from "./auth.js";
import type { BrandStore } from "./brand.js";
import type { CatalogStore } from "./catalog.js";
import type { Db } from "./db/pool.js";
import { FailureLimiter } from "./rateLimit.js";
import type { EventStore } from "./store.js";

/** The server's own device id on events it creates for customers. */
export const SHOP_DEVICE = "shop";

interface ShopDeps {
  db: Db;
  config: BusinessConfig;
  store: EventStore;
  catalog: CatalogStore;
  brand: BrandStore;
  /** Stores events, nudges live screens, queues prints (same path as a till's push). */
  ingest: (events: OrderEvent[]) => Promise<unknown>;
  needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
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

/** Strip control characters and cap length: customer text ends up on staff screens and printers. */
const clean = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || undefined;
};

export function registerShop(app: FastifyInstance, d: ShopDeps) {
  const merchantId = d.config.businessId;
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
    return { primary: b.primary, accent: b.accent, ink: b.ink, logoUrl: b.hasLogo ? `/api/brand/logo?v=${b.logoVersion}` : null };
  };

  /** Everything the ordering page needs to dress itself. Public. */
  app.get("/api/shop/info", async (req, reply) => {
    if (limited(readLimit, req, reply)) return;
    const cat = await d.catalog.load();
    return {
      name: d.config.name,
      outletName: d.config.outletName,
      paymentTiming: d.config.paymentTiming,
      channels: cat.channels.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      brand: await brandPayload(),
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

  interface OrderBody {
    channelId?: string;
    items?: Array<{ productId?: string; qty?: number }>;
    customerName?: string;
    customerPhone?: string;
    spot?: string;
    /** The total the customer was shown. If prices moved since, they are told before anything is placed. */
    expectedTotalCents?: number;
  }

  /** A customer places an order. Held for staff to accept; nothing reaches the kitchen yet. */
  app.post<{ Body: OrderBody }>("/api/shop/orders", async (req, reply) => {
    if (limited(orderLimit, req, reply)) return;
    const b = req.body ?? {};
    if (typeof b.channelId !== "string" || !Array.isArray(b.items)) return reply.code(400).send({ error: "channelId and items are required" });
    const items = b.items.map((i) => ({ productId: String(i?.productId ?? ""), qty: Number(i?.qty) }));

    const phone = clean(b.customerPhone, 20);
    if (phone && !/^[+\d][\d\s-]{5,19}$/.test(phone)) return reply.code(400).send({ error: "phone number looks wrong" });

    const cat = await d.catalog.load();
    const quote = quoteOrder(cat, d.config, { outletId: d.config.outletName, channelId: b.channelId }, items);
    if (!quote.ok) return reply.code(400).send({ error: quote.error, productId: quote.productId });
    if (b.expectedTotalCents !== undefined && b.expectedTotalCents !== quote.priced.total) {
      return reply.code(409).send({ error: "price_changed", totalCents: quote.priced.total });
    }

    const orderId = newId();
    const queueNumber = await nextOnlineNumber(d.db, merchantId);
    const ts = Date.now();
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
        customerName: clean(b.customerName, 40),
        customerPhone: phone,
        spot: quote.channel.kind === "dine_in" ? clean(b.spot, 30)?.replace(/[^\w #-]/g, "") : undefined,
        queueNumber,
      }),
      ...quote.lines.map((l) => mk({ type: "ItemAdded", lineId: newId(), productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty, pointsExempt: l.pointsExempt })),
    ];
    await d.ingest(events);
    return { orderId, queueNumber, totalCents: quote.priced.total, status: "received" };
  });

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
      items: order.lines.filter((l) => l.qty > 0).map((l) => ({ name: l.name, qty: l.qty, unitCents: l.unitCents })),
      totalCents: total,
      paidCents: paid,
    };
  });
}
