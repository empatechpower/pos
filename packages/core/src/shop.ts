import type { BusinessConfig } from "./config.js";
import { channelById, menuFor, fulfilmentOf, type Catalog, type Channel, type PriceContext } from "./catalog.js";
import { isFullyPaid, type OrderState } from "./events.js";
import { priceOrder, type PriceResult } from "./pricing.js";

/**
 * Customer ordering. The customer's device proposes (channel, items, quantities); the SERVER decides
 * the prices. This one function is used by both: the app to show a live total, the server to compute
 * what is actually charged. Prices sent by a client are never trusted: only product ids and quantities.
 */

export const MAX_LINES = 30;
export const MAX_QTY = 20;

export interface QuoteItem {
  productId: string;
  qty: number;
}

export type QuoteError = "unknown_channel" | "channel_off" | "empty" | "too_many_items" | "bad_quantity" | "unavailable";

export type Quote =
  | {
      ok: true;
      channel: Channel;
      fulfilment: ReturnType<typeof fulfilmentOf>;
      lines: Array<{ productId: string; name: string; unitCents: number; qty: number; pointsExempt?: boolean }>;
      priced: PriceResult;
    }
  | { ok: false; error: QuoteError; productId?: string };

export function quoteOrder(catalog: Catalog, config: BusinessConfig, ctx: PriceContext, items: readonly QuoteItem[]): Quote {
  const channel = channelById(catalog, ctx.channelId);
  if (!channel) return { ok: false, error: "unknown_channel" };
  if (!channel.active) return { ok: false, error: "channel_off" };
  if (!items.length) return { ok: false, error: "empty" };
  if (items.length > MAX_LINES) return { ok: false, error: "too_many_items" };

  const menu = new Map(menuFor(catalog, ctx).map((m) => [m.id, m]));
  const merged = new Map<string, number>();
  for (const it of items) {
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) return { ok: false, error: "bad_quantity", productId: it.productId };
    merged.set(it.productId, (merged.get(it.productId) ?? 0) + it.qty);
  }
  const lines: Array<{ productId: string; name: string; unitCents: number; qty: number; pointsExempt?: boolean }> = [];
  for (const [productId, qty] of merged) {
    const m = menu.get(productId);
    if (!m || m.soldOut) return { ok: false, error: "unavailable", productId };
    if (qty > MAX_QTY) return { ok: false, error: "bad_quantity", productId };
    lines.push({ productId, name: m.name, unitCents: m.priceCents, qty, pointsExempt: m.pointsExempt });
  }
  const fulfilment = fulfilmentOf(channel.kind);
  const priced = priceOrder({ lines: lines.map((l) => ({ name: l.name, unitCents: l.unitCents, qty: l.qty, pointsExempt: l.pointsExempt })), fulfilment, serviceCharge: channel.serviceCharge, config: config.pricing });
  return { ok: true, channel, fulfilment, lines, priced };
}

// ---- what the customer is told ----------------------------------------------------------------

export type ShopStatus = "received" | "awaiting_payment" | "queued" | "preparing" | "ready" | "completed" | "cancelled";

/** One plain status for a customer's order, from the order's real state. */
export function shopStatus(order: OrderState, config: BusinessConfig): ShopStatus {
  if (order.stage === "cancelled") return "cancelled";
  if (order.stage === "completed") return "completed";
  if (order.source === "online" && !order.acceptedAt) return "received";
  if (config.paymentTiming === "prepay" && !isFullyPaid(order, config)) return "awaiting_payment";
  if (order.stage === "ready") return "ready";
  if (order.stage === "preparing") return "preparing";
  return "queued";
}

// ---- brand colours ----------------------------------------------------------------------------

export const isHexColor = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** WCAG contrast ratio between two colours, 1 (none) to 21 (black on white). */
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** White or near-black text, whichever reads better on this background. Any brand colour stays usable. */
export const readableOn = (bg: string): "#ffffff" | "#21252a" => (contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#21252a") ? "#ffffff" : "#21252a");
