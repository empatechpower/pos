import type { Cents } from "./money.js";
import type { OptionGroup } from "./options.js";

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
 * Only the winning pricebook is ever consulted. A product with no price in it is NOT sold in that
 * context and no other pricebook's price is substituted (spec A-1). The pricebook's `missing`
 * setting only decides whether such a product is hidden from the menu or shown but blocked.
 */

export interface Product {
  id: string;
  name: string;
  category: string;
  soldOut?: boolean;
  pointsExempt?: boolean;
  /** A line or two shown under the name. */
  description?: string;
  /** The name in another language, e.g. the Chinese name. */
  altName?: string;
  /** 0 or absent = no photo. Changes whenever the photo does, so devices refetch it. */
  imageVersion?: number;
  /** Hot/cold, protein, extras... Prices here are deltas on top of the pricebook's price. */
  options?: OptionGroup[];
}

export interface Pricebook {
  id: string;
  name: string;
  /** productId → price in cents. A product that is absent has no price in this book. */
  prices: Record<string, Cents>;
  /** A product with no price here can never be ordered; this decides whether it is hidden or shown (blocked). */
  missing: "show" | "hide";
  /** Products switched off in this book: hidden from online ordering, greyed out on the till. They keep their price here. A price of 0 is a real price: that item is sellable. */
  off?: string[];
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
  const book = pricebookChain(catalog, ctx)[0];
  if (!book || !Object.prototype.hasOwnProperty.call(book.prices, productId)) return null;
  if (book.off?.includes(productId)) return null;
  return { priceCents: book.prices[productId]!, pricebookId: book.id };
}

/** Products shown on the menu but not orderable here: no price in the winning book, and the book says "show". */
export function blockedFor(catalog: Catalog, ctx: PriceContext): Product[] {
  const book = pricebookChain(catalog, ctx)[0];
  if (!book || book.missing === "hide") return [];
  return catalog.products.filter((p) => !Object.prototype.hasOwnProperty.call(book.prices, p.id) && !book.off?.includes(p.id));
}

/** Products switched off here, for a till to show greyed out. Online ordering simply leaves them off the menu. */
export function greyedFor(catalog: Catalog, ctx: PriceContext): Product[] {
  const book = pricebookChain(catalog, ctx)[0];
  if (!book?.off?.length) return [];
  const off = new Set(book.off);
  return catalog.products.filter((p) => off.has(p.id));
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
    for (const pid of b.off ?? []) if (!products.has(pid)) problems.push(`pricebook ${b.id} switches off unknown product ${pid}`);
  }
  for (const p of c.products) {
    if (p.description && p.description.length > 200) problems.push(`${p.id}: description is too long`);
    if (p.altName && p.altName.length > 80) problems.push(`${p.id}: alternative name is too long`);
    problems.push(...validateOptions(p.id, p.options));
  }
  return problems;
}

/** Problems with one product's option groups. Empty means fine. */
export function validateOptions(productId: string, groups: readonly OptionGroup[] | undefined): string[] {
  if (!groups?.length) return [];
  const out: string[] = [];
  const at = (m: string) => out.push(`${productId}: ${m}`);
  if (groups.length > 6) at("too many option groups (6 at most)");
  const gids = new Set<string>();
  for (const g of groups) {
    if (!g.id || gids.has(g.id)) at(`option group id "${g.id}" is empty or repeated`);
    gids.add(g.id);
    if (!g.name?.trim() || g.name.length > 60) at(`option group "${g.id}" needs a name of up to 60 characters`);
    if (!["single", "multi", "qty"].includes(g.kind)) at(`option group "${g.name}" has an unknown kind`);
    if (g.variant && (g.kind !== "single" || !g.required)) at(`variant group "${g.name}" must be a required choose-one group`);
    if (g.required && g.kind !== "single") at(`only a choose-one group can be required ("${g.name}")`);
    if (!g.choices?.length || g.choices.length > 30) at(`option group "${g.name}" needs 1 to 30 choices`);
    for (const k of ["max", "maxEach"] as const) if (g[k] !== undefined && (!Number.isInteger(g[k]) || g[k]! < 1)) at(`option group "${g.name}": ${k} must be a whole number of 1 or more`);
    const cids = new Set<string>();
    let defaults = 0;
    for (const c of g.choices ?? []) {
      if (!c.id || cids.has(c.id)) at(`choice id "${c.id}" in "${g.name}" is empty or repeated`);
      cids.add(c.id);
      if (!c.name?.trim() || c.name.length > 60) at(`a choice in "${g.name}" needs a name of up to 60 characters`);
      if (!Number.isSafeInteger(c.priceCents) || c.priceCents < 0) at(`choice "${c.name}" has an invalid price`);
      if (c.default) defaults++;
    }
    if (defaults > 1 || (defaults && g.kind !== "single")) at(`option group "${g.name}": only a choose-one group can have one default`);
    if (g.required && g.kind === "single" && !(g.choices ?? []).some((c) => !c.soldOut)) at(`"${g.name}" is required but every choice is sold out`);
  }
  return out;
}
