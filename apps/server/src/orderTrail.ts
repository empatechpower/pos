import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { COURSE_NAMES, formatMoney, recordedTender, reduceOrder, type OrderEvent } from "@pos/core";
import { audit, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";
import type { EventStore } from "./store.js";

export interface TrailEntry { at: number; kind: string; text: string; who: string }

const METHOD: Record<string, string> = { cash: "cash", credit: "member credit", card: "card", paynow: "PayNow" };

/** One plain line for each thing that happened to an order, with who did it where the record says. */
export function eventTrail(events: readonly OrderEvent[], deviceName: (id: string) => string): TrailEntry[] {
  const out: TrailEntry[] = [];
  for (const e of events) {
    const x = e as OrderEvent & Record<string, any>;
    const dev = deviceName(e.deviceId);
    const add = (kind: string, text: string, who = dev) => out.push({ at: e.ts, kind, text, who });
    switch (e.type) {
      case "OrderOpened": add("opened", x.source === "online" ? "Order placed online" : "Order opened", x.source === "online" ? "Customer" : dev); break;
      case "ItemAdded": add("item", `Added ${x.qty} × ${x.name}${x.channelName ? ` (${x.channelName})` : ""}${x.hold ? " · held" : ""}`); break;
      case "ItemQtySet": add("item", x.qty === 0 ? "Removed an item" : `Changed an item's quantity to ${x.qty}`); break;
      case "PaymentRecorded": add("payment", `Payment ${formatMoney(x.amountCents)} by ${recordedTender(x.tender)?.label.toLowerCase() ?? METHOD[x.method] ?? x.method}${x.confirmed ? "" : " (waiting for confirmation)"}${x.note ? ` · ${x.note}` : ""}`); break;
      case "PaymentConfirmed": add("payment", "Payment confirmed"); break;
      case "RefundRecorded": add("refund", `Refunded ${formatMoney(x.amountCents)} ${METHOD[x.method] ?? x.method} · ${x.reason}`, `${x.approvedByName} (approved)`); break;
      case "OrderVoided": add("void", `Order voided · ${x.reason}`, `${x.approvedByName} (approved)`); break;
      case "DiscountApplied": add("discount", `Discount ${x.kind === "percent" ? `${x.value}%` : formatMoney(x.value)} on ${x.scope === "bill" ? "the bill" : "an item"} · ${x.reason}`, `${x.byName ?? dev}${x.approvedByName ? `, approved by ${x.approvedByName}` : ""}`); break;
      case "DiscountRemoved": add("discount", "Discount removed", x.byName ?? dev); break;
      case "LinePriceOverridden": add("price", `Price set to ${formatMoney(x.unitCents)} · ${x.reason}`, `${x.byName ?? dev}${x.approvedByName ? `, approved by ${x.approvedByName}` : ""}`); break;
      case "TaxRemovalSet": add("tax", x.removed ? `Tax removed · ${x.reason}` : "Tax put back", `${x.byName ?? dev}${x.approvedByName ? `, approved by ${x.approvedByName}` : ""}`); break;
      case "LinesReady": add("kitchen", `Kitchen finished ${x.lineIds?.length ?? 0} item${x.lineIds?.length === 1 ? "" : "s"}${x.station ? ` · ${x.station}` : ""}`, x.byName ?? dev); break;
      case "LinesServed": add("kitchen", `Served ${x.lineIds?.length ?? 0} item${x.lineIds?.length === 1 ? "" : "s"}`, x.byName ?? dev); break;
      case "OrderNoted": add("note", x.note ? `Order note: ${x.note}` : "Order note removed", x.byName ?? dev); break;
      case "StageSet": add("stage", x.stage === "cancelled" ? "Order cancelled" : `Marked ${x.stage}`); break;
      case "OrderAccepted": add("stage", "Order accepted"); break;
      case "OrderFired": add("stage", "Sent to the kitchen"); break;
      case "TableChanged": add("table", `Moved to ${x.to}`); break;
      case "CourseFired": add("stage", `Course fired · ${COURSE_NAMES[x.course] ?? `Course ${x.course}`}`, x.byName ?? dev); break;
      case "FeeApplied": add("discount", `Fee added: ${x.label} ${x.kind === "percent" ? `${x.value}%` : formatMoney(x.value)}`, x.byName ?? dev); break;
      case "FeeRemoved": add("discount", "Fee removed", x.byName ?? dev); break;
      case "LineFired": add("stage", "An item was sent to the kitchen", x.byName ?? dev); break;
      case "GuestsChanged": add("note", `Guests changed to ${x.pax}`, x.byName ?? dev); break;
      case "BillRequested": add("stage", "Guest check printed", x.byName ?? dev); break;
      case "TableCleared": add("table", "Table cleared", x.byName ?? dev); break;
      case "OrderMerged": add("table", `Merged into ${x.intoSpot ?? "another table"}`, x.byName ?? dev); break;
      case "SplitCreated": add("payment", `Bill split into ${x.checks?.length ?? 0} checks (${x.method})`, x.byName ?? dev); break;
      case "SplitCleared": add("payment", "Split bill cleared", x.byName ?? dev); break;
      case "CouponApplied": add("discount", `Coupon · ${x.title}`); break;
      case "PointsRedeemed": add("discount", `${x.points} points redeemed`); break;
      case "CommissionRecorded": add("commission", `Commission recorded ${formatMoney(x.cents)}`); break;
      default: break;
    }
  }
  return out;
}

/**
 * Who opened which order, and when. Every opening is written, even when nothing was changed (a shop cannot quietly look at an order).
 * A till that was offline reports its openings later with the time they really happened.
 */
export function registerOrderTrail(app: FastifyInstance, d: { db: Db; merchantId: string; store: EventStore; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, store, needs } = d;

  app.post<{ Params: { id: string }; Body: { seenIn?: string; at?: number } }>("/api/orders/:id/viewed", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const events = await store.eventsForOrder(req.params.id);
    if (!events.length) return reply.code(404).send({ error: "order_not_found" });
    const now = Date.now();
    const claimed = Number(req.body?.at);
    // The time a till says it happened is believed only within the last week and never in the future.
    const at = Number.isFinite(claimed) && claimed > now - 7 * 86_400_000 && claimed <= now + 60_000 ? claimed : now;
    const s = req.staff!;
    // The same person opening the same order from the same place a few seconds apart (a screen redrawing) is one opening.
    const seenIn = String(req.body?.seenIn ?? "").slice(0, 40);
    const dup = await db.query("SELECT 1 FROM order_views WHERE merchant_id=$1 AND order_id=$2 AND staff_id=$3 AND seen_in=$4 AND viewed_at > to_timestamp($5/1000.0) - interval '10 seconds' LIMIT 1", [merchantId, req.params.id, s.id, seenIn, at]);
    if (dup.rowCount) return { ok: true, repeated: true };
    await db.query("INSERT INTO order_views (merchant_id, order_id, staff_id, staff_name, staff_role, device_id, seen_in, viewed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0))", [merchantId, req.params.id, s.id, s.name, s.role, req.device?.id ?? null, seenIn, at]);
    return { ok: true };
  });

  /** The whole story of one order for a manager: what happened to it, and who opened it. */
  app.get<{ Params: { id: string } }>("/api/orders/:id/trail", { preHandler: needs("audit.read") }, async (req, reply) => {
    const events = await store.eventsForOrder(req.params.id);
    if (!events.length || !reduceOrder(req.params.id, events)) return reply.code(404).send({ error: "order_not_found" });
    const names = new Map((await db.query("SELECT id, name FROM devices WHERE merchant_id=$1", [merchantId])).rows.map((r) => [r.id as string, r.name as string]));
    const trail = eventTrail(events, (id) => (id === "server" ? "System" : id === "shop" ? "Customer" : names.get(id) ?? "A till"));
    const views = (await db.query("SELECT staff_name, staff_role, seen_in, extract(epoch from viewed_at)*1000 AS at FROM order_views WHERE merchant_id=$1 AND order_id=$2 ORDER BY viewed_at", [merchantId, req.params.id])).rows
      .map((v): TrailEntry => ({ at: Number(v.at), kind: "viewed", text: `Opened${v.seen_in ? ` in ${v.seen_in}` : ""}`, who: `${v.staff_name} (${v.staff_role})` }));
    await audit(db, merchantId, req.staff!.id, "order.trail_read", { orderId: req.params.id });
    return { entries: [...trail, ...views].sort((a, b) => a.at - b.at) };
  });
}
