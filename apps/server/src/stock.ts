import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { consumptionPlan, type Catalog, type OrderState } from "@pos/core";
import type { Db } from "./db/pool.js";
import type { Permission } from "./auth.js";
import { audit } from "./auth.js";

export interface InventoryItem { id: string; name: string; unit: string; active: boolean }

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REASONS = ["receive", "count", "waste", "adjust"] as const;

/** On-hand for every stock item at one outlet: the sum of its movements. */
export async function onHandAt(db: Db, merchantId: string, outletId: string): Promise<Map<string, number>> {
  const r = await db.query("SELECT item_id, COALESCE(SUM(delta),0)::int AS qty FROM stock_movements WHERE merchant_id=$1 AND outlet_id=$2 GROUP BY item_id", [merchantId, outletId]);
  return new Map(r.rows.map((x) => [x.item_id as string, Number(x.qty)]));
}

/** A number that rises with every movement at an outlet, so a phone that watches the menu version sees an item go sold out (or come back). 0 when nothing is tracked. */
export async function stockVersion(db: Db, merchantId: string, outletId: string): Promise<number> {
  return Number((await db.query("SELECT count(*) FROM stock_movements WHERE merchant_id=$1 AND outlet_id=$2", [merchantId, outletId])).rows[0].count);
}

export async function itemNames(db: Db, merchantId: string): Promise<Map<string, string>> {
  return new Map((await db.query("SELECT id, name FROM inventory_items WHERE merchant_id=$1", [merchantId])).rows.map((x) => [x.id as string, x.name as string]));
}

/**
 * Make the stock movements of an order match what its lines consume: the difference between what the order should have used (its lines
 * as they stand now, nothing if cancelled) and what its movements already say. Run after every change to the order, so a duplicate delivery adds
 * nothing, a changed quantity adds the difference, and a cancellation puts it all back. Each line deducts exactly once, in one step.
 */
export async function reconcileOrderStock(db: Db, merchantId: string, outletId: string, order: OrderState, catalog: Pick<Catalog, "products">): Promise<number> {
  const tracked = catalog.products.some((p) => p.stock);
  const client = await db.connect();
  let made = 0;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`stock/${merchantId}/${order.orderId}`]);
    const have = new Map<string, number>(); // "lineId|itemId" -> already moved (negative = used)
    for (const r of (await client.query("SELECT line_id, item_id, SUM(delta)::int AS d FROM stock_movements WHERE merchant_id=$1 AND order_id=$2 AND reason='sale' GROUP BY line_id, item_id", [merchantId, order.orderId])).rows) have.set(`${r.line_id}|${r.item_id}`, Number(r.d));
    if (!tracked && have.size === 0) { await client.query("ROLLBACK"); return 0; }
    const want = new Map<string, number>();
    if (order.stage !== "cancelled") {
      for (const l of order.lines) {
        for (const u of consumptionPlan(catalog, { productId: l.productId, qty: Math.max(0, l.qty), options: l.options, build: l.build })) want.set(`${l.lineId}|${u.itemId}`, -u.qty);
      }
    }
    for (const key of new Set([...have.keys(), ...want.keys()])) {
      const diff = (want.get(key) ?? 0) - (have.get(key) ?? 0);
      if (!diff) continue;
      const [lineId, itemId] = key.split("|") as [string, string];
      await client.query("INSERT INTO stock_movements (merchant_id, item_id, outlet_id, delta, reason, order_id, line_id) VALUES ($1,$2,$3,$4,'sale',$5,$6)", [merchantId, itemId, outletId, diff, order.orderId, lineId]);
      made++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return made;
}

/** Staff routes: stock items, receiving, stocktakes, waste, and the movement history. */
export function registerStock(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; outletIds: () => Promise<string[]>; defaultOutlet: string }) {
  const manage = { preHandler: d.needs("catalog.manage") };
  const outletOf = async (asked: unknown) => {
    const all = await d.outletIds();
    return typeof asked === "string" && all.includes(asked) ? asked : d.defaultOutlet;
  };

  /** Every stock item with its on-hand at one outlet. */
  app.get<{ Querystring: { outlet?: string } }>("/api/inventory", manage, async (req) => {
    const outlet = await outletOf(req.query.outlet);
    const items = (await d.db.query("SELECT id, name, unit, active FROM inventory_items WHERE merchant_id=$1 ORDER BY name", [d.merchantId])).rows as InventoryItem[];
    const have = await onHandAt(d.db, d.merchantId, outlet);
    return { outletId: outlet, items: items.map((i) => ({ ...i, onHand: have.get(i.id) ?? 0 })) };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; unit?: string; active?: boolean } }>("/api/inventory/:id", manage, async (req, reply) => {
    const id = req.params.id;
    if (!ID.test(id)) return reply.code(400).send({ error: "id is lowercase letters, digits and dashes" });
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const unit = String(req.body?.unit ?? "pcs").trim().slice(0, 12) || "pcs";
    if (!name) return reply.code(400).send({ error: "name is required" });
    await d.db.query(
      `INSERT INTO inventory_items (merchant_id, id, name, unit, active) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (merchant_id, id) DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, active=EXCLUDED.active`,
      [d.merchantId, id, name, unit, req.body?.active !== false]);
    await audit(d.db, d.merchantId, req.staff!.id, "inventory.item", { id, name, unit });
    return { ok: true, id };
  });

  /**
   * Add a movement: receive (+), waste (−), adjust (±), or a stocktake ("count": the counted figure, stored as the difference from what the books say).
   * Movements are never edited or deleted; a mistake is corrected by another movement.
   */
  app.post<{ Params: { id: string }; Body: { outletId?: string; reason?: string; qty?: number; note?: string } }>("/api/inventory/:id/movements", manage, async (req, reply) => {
    const id = req.params.id;
    const exists = (await d.db.query("SELECT 1 FROM inventory_items WHERE merchant_id=$1 AND id=$2", [d.merchantId, id])).rowCount;
    if (!exists) return reply.code(404).send({ error: "item_not_found" });
    const outlet = await outletOf(req.body?.outletId);
    const reason = String(req.body?.reason ?? "");
    if (!(REASONS as readonly string[]).includes(reason)) return reply.code(400).send({ error: "reason is receive, count, waste or adjust" });
    const qty = Number(req.body?.qty);
    if (!Number.isInteger(qty) || Math.abs(qty) > 100_000_000) return reply.code(400).send({ error: "qty is a whole number" });
    if ((reason === "receive" || reason === "waste") && qty <= 0) return reply.code(400).send({ error: `${reason} is a quantity above zero` });
    if (reason === "count" && qty < 0) return reply.code(400).send({ error: "a count cannot be below zero" });
    const before = (await onHandAt(d.db, d.merchantId, outlet)).get(id) ?? 0;
    const delta = reason === "receive" ? qty : reason === "waste" ? -qty : reason === "count" ? qty - before : qty;
    if (delta === 0) return { ok: true, onHand: before, unchanged: true };
    await d.db.query("INSERT INTO stock_movements (merchant_id, item_id, outlet_id, delta, reason, note, staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [d.merchantId, id, outlet, delta, reason, String(req.body?.note ?? "").trim().slice(0, 200) || null, req.staff!.id]);
    await audit(d.db, d.merchantId, req.staff!.id, `inventory.${reason}`, { item: id, outlet, delta });
    return { ok: true, onHand: before + delta, delta };
  });

  app.get<{ Params: { id: string }; Querystring: { outlet?: string; limit?: string } }>("/api/inventory/:id/movements", manage, async (req) => {
    const outlet = await outletOf(req.query.outlet);
    const r = await d.db.query("SELECT id, delta, reason, order_id, note, created_at FROM stock_movements WHERE merchant_id=$1 AND item_id=$2 AND outlet_id=$3 ORDER BY id DESC LIMIT $4", [d.merchantId, req.params.id, outlet, Math.max(1, Math.min(Number(req.query.limit) || 50, 500))]);
    return { outletId: outlet, movements: r.rows.map((x) => ({ id: Number(x.id), delta: x.delta as number, reason: x.reason as string, orderId: x.order_id as string | null, note: x.note as string | null, at: x.created_at })) };
  });
}
