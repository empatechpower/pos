import type { BusinessConfig } from "./config.js";
import { channelById, menuFor, fulfilmentOf, type Catalog, type Channel, type PriceContext } from "./catalog.js";
import { isFullyPaid, visibleToKitchen, type OrderState } from "./events.js";
import { resolveOptions, type ChosenOption, type ChosenOptionInput, type OptionError } from "./options.js";
import { groupedBuild, hasBuilder, priceBuild, type BuildInput, type BuildValidation, type StoredBuild } from "./builder.js";
import { priceOrder, type CouponInput, type PointsInput, type PriceResult } from "./pricing.js";

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
  options?: ChosenOptionInput[];
  /** A free-text request for the kitchen ("no onions"). Costs nothing; it is printed on the ticket. */
  note?: string;
  /** What the customer picked on a build-your-own product (ids only; names and prices come from the menu). */
  build?: BuildInput;
}

export const MAX_NOTE = 140;

/** One tidy line of at most 140 characters: control characters and line breaks become spaces. Empty when there is nothing to say. */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
}

export type QuoteError = "unknown_channel" | "channel_off" | "empty" | "too_many_items" | "bad_quantity" | "unavailable" | "build_invalid" | OptionError;

export interface QuoteLine {
  productId: string;
  name: string;
  /** Price of one, including options. */
  unitCents: number;
  qty: number;
  pointsExempt?: boolean;
  taxInclusive?: boolean;
  taxGroup?: string;
  /** The item's deposit setting at the moment of sale, frozen on the order line. */
  bcrs: boolean;
  options: ChosenOption[];
  /** Build-your-own: the structured build with every selection's allocation frozen (full price, covered by allowance, charged). */
  build?: StoredBuild;
}

export type Quote =
  | {
      ok: true;
      channel: Channel;
      fulfilment: ReturnType<typeof fulfilmentOf>;
      lines: QuoteLine[];
      priced: PriceResult;
    }
  | { ok: false; error: QuoteError; productId?: string; validation?: BuildValidation };

export function quoteOrder(catalog: Catalog, config: BusinessConfig, ctx: PriceContext, items: readonly QuoteItem[], points?: PointsInput | null, coupon?: CouponInput | null): Quote {
  const channel = channelById(catalog, ctx.channelId);
  if (!channel) return { ok: false, error: "unknown_channel" };
  if (!channel.active) return { ok: false, error: "channel_off" };
  if (!items.length) return { ok: false, error: "empty" };
  if (items.length > MAX_LINES) return { ok: false, error: "too_many_items" };

  const menu = new Map(menuFor(catalog, ctx).map((m) => [m.id, m]));
  // The same product with different options is a different line; the same product and options merge.
  const merged = new Map<string, QuoteLine>();
  for (const it of items) {
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) return { ok: false, error: "bad_quantity", productId: it.productId };
    const m = menu.get(it.productId);
    if (!m || m.soldOut) return { ok: false, error: "unavailable", productId: it.productId };
    let built: StoredBuild | undefined;
    let r: { ok: true; options: ChosenOption[]; extraCents: number; key: string };
    if (hasBuilder(m.builder)) {
      // A build-your-own product is priced by its rule set and allowances; an incomplete or invalid build is refused with the per-group reasons.
      const pb = priceBuild(m.builder, it.build ?? { picks: [] }, m.priceCents, { ruleVersion: catalog.version });
      if (!pb.ok) return { ok: false, error: "build_invalid", productId: it.productId, validation: pb.validation };
      built = pb;
      const grouped = groupedBuild(pb).flatMap((g) => g.items.map((i) => ({ group: g.group, name: i.name, qty: i.qty, priceCents: i.chargedCents })));
      const options = [...(pb.variantName ? [{ group: "Choice", name: pb.variantName, qty: 1, priceCents: pb.variantDeltaCents }] : []), ...grouped];
      r = { ok: true, options, extraCents: pb.unitCents - m.priceCents, key: JSON.stringify(it.build ?? {}) };
    } else {
      const ro = resolveOptions(m.options, it.options);
      if (!ro.ok) return { ok: false, error: ro.error, productId: it.productId };
      r = ro as typeof r;
    }
    const note = cleanNote(it.note);
    const key = `${it.productId}#${r.key}#${note}`;
    const have = merged.get(key);
    const qty = (have?.qty ?? 0) + it.qty;
    if (qty > MAX_QTY) return { ok: false, error: "bad_quantity", productId: it.productId };
    merged.set(key, { productId: it.productId, name: m.name, unitCents: m.priceCents + r.extraCents, qty, pointsExempt: m.pointsExempt, bcrs: !!m.bcrs, ...(m.taxInclusive !== undefined ? { taxInclusive: m.taxInclusive } : {}), ...(m.taxGroup ? { taxGroup: m.taxGroup } : {}), ...(built ? { build: built } : {}), options: note ? [...r.options, { group: "Special request", name: `Note: ${note}`, qty: 1, priceCents: 0 }] : r.options });
  }
  const lines = [...merged.values()];
  if (lines.length > MAX_LINES) return { ok: false, error: "too_many_items" };
  const fulfilment = fulfilmentOf(channel.kind);
  const priced = priceOrder({ lines: lines.map((l) => ({ name: l.name, unitCents: l.unitCents, qty: l.qty, pointsExempt: l.pointsExempt, bcrs: l.bcrs, taxInclusive: l.taxInclusive, taxGroup: l.taxGroup })), fulfilment, serviceCharge: channel.serviceCharge, points: points ?? null, coupon: coupon ?? null, config: config.pricing });
  return { ok: true, channel, fulfilment, lines, priced };
}

// ---- what the customer is told ----------------------------------------------------------------

export type ShopStatus = "received" | "awaiting_payment" | "scheduled" | "queued" | "preparing" | "ready" | "completed" | "cancelled";

/** One plain status for a customer's order, from the order's real state. */
export function shopStatus(order: OrderState, config: BusinessConfig): ShopStatus {
  if (order.stage === "cancelled") return "cancelled";
  if (order.stage === "completed") return "completed";
  if (order.source === "online" && !order.acceptedAt) return "received";
  if (config.paymentTiming === "prepay" && !order.onTab && !order.refunds?.length && !isFullyPaid(order, config)) return "awaiting_payment";
  if (order.fireAt !== undefined && order.firedAt === undefined) return "scheduled";
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

/**
 * White text when it reaches a 3:1 contrast (the accessibility minimum for bold or large text, which is what
 * buttons are), otherwise near-black. Preferring white when it is acceptable keeps typical brand reds and
 * oranges looking the way designers draw them; light colours such as yellow get dark text.
 */
export const readableOn = (bg: string): "#ffffff" | "#21252a" => (contrastRatio(bg, "#ffffff") >= 3 ? "#ffffff" : "#21252a");

// ---- the customer's own place in the queue ------------------------------------------------------

export interface QueueView {
  /** Orders that reached the kitchen before this one and are not ready yet. */
  ahead: number;
  /** A guess in whole minutes, from how long recent orders really took. Null until there is enough to go on. */
  etaMinutes: number | null;
}

const MIN = 60_000;
/** When an order joined the kitchen's queue: opened, accepted by staff, and (if the shop takes payment first) paid. */
const joinedAt = (o: OrderState) => Math.max(o.openedAt, o.acceptedAt ?? 0, o.paidAt ?? 0);

/**
 * Where is this order in line, and about how long is it? The wait is learned from the last few hours of real orders
 * (how long each took to be marked ready, and how many came out in the last half hour), never from a fixed number.
 * With fewer than 3 finished orders to learn from it gives no time, rather than a made-up one, unless the merchant has set a typical minutes-per-order figure. Null if the order is not
 * in the kitchen's queue (not accepted or paid yet, already ready, collected or cancelled).
 */
export function queueView(orders: readonly OrderState[], mine: OrderState, config: BusinessConfig, now: number, fallbackMinutes?: number): QueueView | null {
  const status = shopStatus(mine, config);
  if ((status !== "queued" && status !== "preparing") || !visibleToKitchen(mine, config)) return null;
  const myAt = joinedAt(mine);
  const waiting = (o: OrderState) => o.orderId !== mine.orderId && (o.stage === "open" || o.stage === "preparing") && visibleToKitchen(o, config) && o.lines.some((l) => l.qty > 0);
  const ahead = orders.filter((o) => waiting(o) && (joinedAt(o) < myAt || (joinedAt(o) === myAt && o.orderId < mine.orderId))).length;

  const took = orders
    .filter((o) => o.readyAt !== undefined && o.readyAt >= now - 180 * MIN)
    .map((o) => o.readyAt! - joinedAt(o))
    .filter((d) => d > 0 && d <= 90 * MIN)
    .sort((a, b) => a - b);
  if (took.length < 3) {
    // Not enough finished orders to learn from. Only if the merchant has said how long one order usually takes do we show a time (that figure per order in line, this one included).
    const per = fallbackMinutes && fallbackMinutes > 0 ? fallbackMinutes : null;
    return { ahead, etaMinutes: per === null ? null : Math.min(120, Math.max(1, Math.ceil(per * (ahead + 1)))) };
  }
  const mid = Math.floor(took.length / 2);
  const typical = took.length % 2 ? took[mid]! : (took[mid - 1]! + took[mid]!) / 2;
  const lastHalfHour = orders.filter((o) => o.readyAt !== undefined && o.readyAt >= now - 30 * MIN).length;
  let wait: number | null = null;
  if (ahead === 0) wait = typical;
  else if (lastHalfHour >= 3) wait = Math.max(typical, ((ahead + 1) / lastHalfHour) * 30 * MIN);
  return { ahead, etaMinutes: wait === null ? null : Math.min(120, Math.max(1, Math.ceil(wait / MIN))) };
}
