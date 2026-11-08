import type { Cents } from "./money.js";

/**
 * Catalog: what is sold, the price lists it is sold under, and the channels (dining / fulfilment
 * options) it is sold through. One pure resolver decides the price for a given outlet + channel,
 * and it runs identically on the server and on a device with no network.
 *
 * Precedence for "which pricebook applies", most specific first:
 *   1. assigned to this outlet AND this channel   (Regal, Take away)
 *   2. assigned to this channel, any outlet       (Grab, everywhere)
 *   3. assigned to this outlet, any channel       (LIDO, everything)
 *   4. the merchant's default pricebook
 * A product with no price in the winning pricebook falls through to the next one, unless that
 * pricebook is set to "hide", in which case the product is not sold in that context.
 */

export interface Product {
  id: string;
  name: string;
  category: string;
  soldOut?: boolean;
  pointsExempt?: boolean;
}

export interface Pricebook {
  id: string;
  name: string;
  /** productId → price in cents. A product that is absent has no price in this book. */
  prices: Record<string, Cents>;
  /** When a product has no price here: use the next pricebook down, or do not sell it at all. */
  missing: "fallback" | "hide";
}

export type Fulfilment = "dine_in" | "takeaway" | "delivery";
export type ChannelKind = Fulfilment | "other";

export interface Channel {
  id: string;
  /** What staff and customers see. Editable. */
  name: string;
  kind: ChannelKind;
  /** Whether the service charge applies to orders in this channel. */
  serviceCharge: boolean;
  active: boolean;
}

export interface PricebookAssignment {
  pricebookId: string;
  outletId?: string;
  channelId?: string;
}

export interface Catalog {
  /** Bumped on every change, so devices know when their copy is stale. */
  version: number;
  defaultPricebookId: string;
  products: Product[];
  pricebooks: Pricebook[];
  channels: Channel[];
  assignments: PricebookAssignment[];
}

export interface PriceContext {
  outletId: string;
  channelId: string;
}

/** The old three-way fulfilment an order still records, for anything that predates channels. */
export const fulfilmentOf = (kind: ChannelKind): Fulfilment => (kind === "other" ? "takeaway" : kind);

/** Pricebooks that apply in this context, most specific first, without repeats. */
export function pricebookChain(catalog: Catalog, ctx: PriceContext): Pricebook[] {
  const a = catalog.assignments;
  const ids = [
    a.find((x) => x.outletId === ctx.outletId && x.channelId === ctx.channelId)?.pricebookId,
    a.find((x) => !x.outletId && x.channelId === ctx.channelId)?.pricebookId,
    a.find((x) => x.outletId === ctx.outletId && !x.channelId)?.pricebookId,
    catalog.defaultPricebookId,
  ];
  const seen = new Set<string>();
  const chain: Pricebook[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const book = catalog.pricebooks.find((p) => p.id === id);
    if (book) chain.push(book);
  }
  return chain;
}

export interface ResolvedPrice {
  priceCents: Cents;
  pricebookId: string;
}

/** The price of one product here, or null when it is not sold in this context. */
export function resolvePrice(catalog: Catalog, productId: string, ctx: PriceContext): ResolvedPrice | null {
  for (const book of pricebookChain(catalog, ctx)) {
    if (Object.prototype.hasOwnProperty.call(book.prices, productId)) return { priceCents: book.prices[productId]!, pricebookId: book.id };
    if (book.missing === "hide") return null;
  }
  return null;
}

export interface MenuEntry extends Product {
  priceCents: Cents;
  pricebookId: string;
}

/** Everything sellable in this context, with its price. */
export function menuFor(catalog: Catalog, ctx: PriceContext): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const p of catalog.products) {
    const r = resolvePrice(catalog, p.id, ctx);
    if (r) out.push({ ...p, ...r });
  }
  return out;
}

export const channelById = (catalog: Catalog, id: string): Channel | undefined => catalog.channels.find((c) => c.id === id);

/** Problems that would make a catalog misbehave. Empty means fine. Used before accepting any change. */
export function validateCatalog(c: Catalog): string[] {
  const problems: string[] = [];
  const books = new Set(c.pricebooks.map((p) => p.id));
  const channels = new Set(c.channels.map((x) => x.id));
  const products = new Set(c.products.map((p) => p.id));
  if (!books.has(c.defaultPricebookId)) problems.push("default pricebook does not exist");
  for (const a of c.assignments) {
    if (!a.outletId && !a.channelId) problems.push("an assignment needs an outlet, a channel, or both");
    if (!books.has(a.pricebookId)) problems.push(`assignment points at missing pricebook ${a.pricebookId}`);
    if (a.channelId && !channels.has(a.channelId)) problems.push(`assignment points at missing channel ${a.channelId}`);
  }
  for (const b of c.pricebooks) {
    for (const [pid, cents] of Object.entries(b.prices)) {
      if (!products.has(pid)) problems.push(`pricebook ${b.id} prices unknown product ${pid}`);
      if (!Number.isSafeInteger(cents) || cents < 0) problems.push(`pricebook ${b.id} has an invalid price for ${pid}`);
    }
  }
  const def = c.pricebooks.find((p) => p.id === c.defaultPricebookId);
  if (def && def.missing === "hide") problems.push("the default pricebook cannot be set to hide");
  return problems;
}
