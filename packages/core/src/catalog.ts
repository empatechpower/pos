import { validateProductStock, type ProductStock } from "./stock.js";
import type { Cents } from "./money.js";
import { hasBuilder, validateBuilderSpec, type BuilderSpec } from "./builder.js";
import { OPTION_PREFIXES, defaultSelection, type ChosenOptionInput, type OptionGroup } from "./options.js";
import type { Availability } from "./windows.js";

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
 *
 * A Price Zone (HQ's thin layer, Q&A A-3) is a named group of outlets; per channel it points at one pricebook. It slots in after
 * the outlet's own assignment of the same kind: zone + channel after (1), zone for any channel after (3). Prices still live only in pricebooks.
 * Only the winning pricebook is ever consulted. A product with no price in it is NOT sold in that
 * context and no other pricebook's price is substituted (spec A-1). The pricebook's `missing`
 * setting only decides whether such a product is hidden from the menu or shown but blocked.
 */

export interface Product {
  id: string;
  name: string;
  category: string;
  /** Its barcode or SKU: the till adds the item when this is scanned or typed. */
  barcode?: string;
  soldOut?: boolean;
  pointsExempt?: boolean;
  /** This item's price already includes tax (overrides the merchant default). */
  taxInclusive?: boolean;
  /** Its tax group, when it is not taxed at the default GST rate (see PricingConfig.taxGroups). */
  taxGroup?: string;
  /** Carries the container deposit (BCRS, S$0.10 each). Set on the item; never guessed from its name when it is sold. */
  bcrs?: boolean;
  /** A line or two shown under the name. */
  description?: string;
  /** The name in another language, e.g. the Chinese name. */
  altName?: string;
  /** The merchant's own name for this item in each language (code -> name), e.g. { zh: "咖椰面包" }. Never machine-translated on the fly; a language with no entry shows `name`. */
  names?: Record<string, string>;
  /** A build-your-own product: groups with rules and allowances (see builder.ts). A product has options OR a builder, not both. */
  builder?: BuilderSpec;
  /** What one unit of this product uses up: its own stock item (finished stock) or a recipe's ingredients. Absent = not tracked. */
  stock?: ProductStock;
  /** Computed for an outlet when its menu is read (never stored): orderable, available later (with the next opening), sold out. */
  availability?: Availability;
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
  /** productId → what a member pays here, for items that have a member price. It only ever lowers the price. */
  memberPrices?: Record<string, Cents>;
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
  /** Opt-in (Q&A A-5): this merchant records commission for this channel, at this contract rate unless an order says otherwise. Absent = not recorded. */
  commission?: { ratePct: number };
}

export interface PricebookAssignment {
  pricebookId: string;
  outletId?: string;
  channelId?: string;
}

/** A named group of outlets. Per channel (or for any channel) it points at one pricebook. An outlet belongs to at most one zone. */
export interface PriceZone {
  id: string;
  name: string;
  outletIds: string[];
  books: Array<{ channelId?: string; pricebookId: string }>;
}

/**
 * A promotional price for a stretch of time (Q&A A-3: "promotions never create pricebooks; they are date-ranged overrides").
 * It replaces the pricebook price of one product while it is running, in one pricebook or in every pricebook. When several run at once the
 * one that started last wins. Prices stay in the pricebooks: ending the promotion simply puts the pricebook price back.
 */
export interface PriceOverride {
  id: string;
  title: string;
  productId: string;
  /** Absent = whichever pricebook applies. */
  pricebookId?: string;
  priceCents: Cents;
  /** ms since the epoch; the override runs from startsAt (included) to endsAt (excluded). */
  startsAt: number;
  endsAt: number;
}

export interface Catalog {
  /** Bumped on every change, so devices know when their copy is stale. */
  version: number;
  defaultPricebookId: string;
  products: Product[];
  pricebooks: Pricebook[];
  channels: Channel[];
  assignments: PricebookAssignment[];
  /** Price Zones: who uses which pricebook, assigned by HQ. Absent = no zones. */
  zones?: PriceZone[];
  /** Promotional prices that run for a stretch of time. Absent = none. */
  overrides?: PriceOverride[];
  /** The merchant's own name for a category in each language: category -> (language code -> name). Never machine-translated; a language with no entry shows the category as entered. */
  categoryNames?: Record<string, Record<string, string>>;
}

export interface PriceContext {
  outletId: string;
  channelId: string;
  /** When the sale happens (ms). Default: now. Only promotional overrides care. */
  at?: number;
  /** The buyer is a signed-in member: an item with a member price is priced at it (the price everyone else pays is kept as `listPriceCents`). */
  member?: boolean;
}

/** The old three-way fulfilment an order still records, for anything that predates channels. */
export const fulfilmentOf = (kind: ChannelKind): Fulfilment => (kind === "other" ? "takeaway" : kind);

/** Pricebooks that apply in this context, most specific first, without repeats. */
export function pricebookChain(catalog: Catalog, ctx: PriceContext): Pricebook[] {
  const a = catalog.assignments;
  const zone = catalog.zones?.find((z) => z.outletIds.includes(ctx.outletId));
  const ids = [
    a.find((x) => x.outletId === ctx.outletId && x.channelId === ctx.channelId)?.pricebookId,
    zone?.books.find((x) => x.channelId === ctx.channelId)?.pricebookId,
    a.find((x) => !x.outletId && x.channelId === ctx.channelId)?.pricebookId,
    a.find((x) => x.outletId === ctx.outletId && !x.channelId)?.pricebookId,
    zone?.books.find((x) => !x.channelId)?.pricebookId,
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
  /** What a member pays, when the item has a member price below the price everyone pays right now (a promotion can already be lower). */
  memberPriceCents?: Cents;
  /** Set when `priceCents` is the member price (the context said the buyer is a member): what everyone else pays. */
  listPriceCents?: Cents;
  /** Set when a promotional override set this price. */
  overrideId?: string;
}

/** The price of one product here, or null when it is not sold in this context. */
export function resolvePrice(catalog: Catalog, productId: string, ctx: PriceContext): ResolvedPrice | null {
  const book = pricebookChain(catalog, ctx)[0];
  if (!book || !Object.prototype.hasOwnProperty.call(book.prices, productId)) return null;
  if (book.off?.includes(productId)) return null;
  const at = ctx.at ?? Date.now();
  let promo: PriceOverride | undefined;
  for (const o of catalog.overrides ?? []) {
    if (o.productId !== productId || (o.pricebookId && o.pricebookId !== book.id) || at < o.startsAt || at >= o.endsAt) continue;
    if (!promo || o.startsAt > promo.startsAt) promo = o;
  }
  const open = promo ? promo.priceCents : book.prices[productId]!;
  const mp = book.memberPrices?.[productId];
  const forMember = mp !== undefined && mp < open;
  return { priceCents: forMember && ctx.member ? mp : open, pricebookId: book.id, ...(promo ? { overrideId: promo.id } : {}), ...(forMember ? { memberPriceCents: mp } : {}), ...(forMember && ctx.member ? { listPriceCents: open } : {}) };
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
  /** What a member pays here, when that is less than the price. */
  memberPriceCents?: Cents;
  /** Set when this entry is priced for a member: what everyone else pays. */
  listPriceCents?: Cents;
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

/** What one unit of a menu item costs before options: the member price for a member when there is one, else the price everyone pays. */
export const basePriceFor = (m: { priceCents: Cents; memberPriceCents?: Cents }, member: boolean): Cents => (member && m.memberPriceCents !== undefined ? m.memberPriceCents : m.priceCents);

/**
 * What a scanned or typed code means on this menu: an item, or an item as one of its variants. For a variant, the choices that makes
 * (that variant, plus the usual defaults for the rest) are returned too. Null when no item here carries the code.
 */
export function findByBarcode<M extends Product>(menu: readonly M[], code: string): { item: M; variant?: ChosenOptionInput[] } | null {
  const want = code.trim().toLowerCase();
  if (!want) return null;
  for (const m of menu) {
    if (m.barcode?.toLowerCase() === want) return { item: m };
    for (const g of m.options ?? []) {
      const c = g.variant ? g.choices.find((x) => x.barcode?.toLowerCase() === want) : undefined;
      if (c) return { item: m, variant: [...defaultSelection(m.options).filter((s) => s.groupId !== g.id), { groupId: g.id, choiceId: c.id }] };
    }
  }
  return null;
}

export const channelById = (catalog: Catalog, id: string): Channel | undefined => catalog.channels.find((c) => c.id === id);

/** Problems that would make a catalog misbehave. Empty means fine. Used before accepting any change. */
export function validateCatalog(c: Catalog): string[] {
  const problems: string[] = [];
  const books = new Set(c.pricebooks.map((p) => p.id));
  const channels = new Set(c.channels.map((x) => x.id));
  const products = new Set(c.products.map((p) => p.id));
  const byId = new Map(c.products.map((p) => [p.id, p]));
  if (!books.has(c.defaultPricebookId)) problems.push("default pricebook does not exist");
  // One code means one thing: an item's barcode and every variant's barcode are all different from each other.
  const codes = new Map<string, string>();
  for (const p of c.products) {
    const mine: Array<[string, string]> = [...(p.barcode ? [[p.barcode, p.name] as [string, string]] : []), ...(p.options ?? []).flatMap((g) => g.choices.filter((x) => x.barcode).map((x): [string, string] => [x.barcode!, `${p.name} (${x.name})`]))];
    for (const [code, what] of mine) { const k = code.toLowerCase(); if (codes.has(k)) problems.push(`the barcode ${code} is on both ${codes.get(k)} and ${what}`); else codes.set(k, what); }
  }
  for (const o of c.overrides ?? []) {
    if (!products.has(o.productId)) problems.push(`promotion ${o.id} prices unknown product ${o.productId}`);
    if (o.pricebookId && !books.has(o.pricebookId)) problems.push(`promotion ${o.id} points at missing pricebook ${o.pricebookId}`);
    if (!Number.isSafeInteger(o.priceCents) || o.priceCents < 0) problems.push(`promotion ${o.id} has an invalid price`);
    if (!(o.endsAt > o.startsAt)) problems.push(`promotion ${o.id} must end after it starts`);
  }
  for (const ch of c.channels) {
    const r = ch.commission?.ratePct;
    if (r !== undefined && !(Number.isFinite(r) && r >= 0 && r <= 100)) problems.push(`channel ${ch.id}: the commission rate must be between 0 and 100`);
  }
  for (const a of c.assignments) {
    if (!a.outletId && !a.channelId) problems.push("an assignment needs an outlet, a channel, or both");
    if (!books.has(a.pricebookId)) problems.push(`assignment points at missing pricebook ${a.pricebookId}`);
    if (a.channelId && !channels.has(a.channelId)) problems.push(`assignment points at missing channel ${a.channelId}`);
  }
  const inZone = new Map<string, string>();
  for (const z of c.zones ?? []) {
    if (!z.name.trim()) problems.push(`zone ${z.id} needs a name`);
    for (const o of z.outletIds) {
      if (inZone.has(o)) problems.push(`outlet ${o} is in two price zones (${inZone.get(o)} and ${z.id})`);
      inZone.set(o, z.id);
    }
    const seenCh = new Set<string>();
    for (const x of z.books) {
      if (!books.has(x.pricebookId)) problems.push(`zone ${z.id} points at missing pricebook ${x.pricebookId}`);
      if (x.channelId && !channels.has(x.channelId)) problems.push(`zone ${z.id} points at missing channel ${x.channelId}`);
      const k = x.channelId ?? "";
      if (seenCh.has(k)) problems.push(`zone ${z.id} has two pricebooks for the same channel`);
      seenCh.add(k);
    }
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
    for (const [code, n] of Object.entries(p.names ?? {})) {
      if (!/^[a-z]{2,3}$/.test(code)) problems.push(`${p.id}: "${code}" is not a language code`);
      if (typeof n !== "string" || n.length > 80) problems.push(`${p.id}: the ${code} name is too long`);
    }
    problems.push(...validateOptions(p.id, p.options));
    for (const g of p.options ?? []) {
      for (const ch of g.choices ?? []) {
        if (!ch.productId) continue;
        const part = byId.get(ch.productId);
        if (!part) problems.push(`${p.id}: combo choice "${ch.name}" points at an item that does not exist`);
        else if (part.id === p.id) problems.push(`${p.id}: a combo cannot contain itself`);
        else if (part.options?.some((og) => og.choices.some((x) => x.productId))) problems.push(`${p.id}: a combo cannot contain another combo ("${part.name}")`);
      }
    }
  }
  for (const p of c.products) {
    if (!p.builder) continue;
    if (p.options?.length) problems.push(`${p.id}: a product has options or a builder, not both`);
    problems.push(...validateBuilderSpec(p.builder, p.id, (id) => {
      const l = c.products.find((x) => x.id === id);
      return { exists: !!l, hasOptions: !!l && (!!l.options?.length || hasBuilder(l.builder)) };
    }));
  }
  for (const p of c.products) problems.push(...validateProductStock(p.stock, p.id));
  for (const [cat, names] of Object.entries(c.categoryNames ?? {})) {
    for (const [code, n] of Object.entries(names)) {
      if (!/^[a-z]{2,3}$/.test(code)) problems.push(`category ${cat}: "${code}" is not a language code`);
      if (typeof n !== "string" || n.length > 80) problems.push(`category ${cat}: the ${code} name is too long`);
    }
  }
  return problems;
}

/** Problems with one product's option groups. Empty means fine. */
export function validateOptions(productId: string, groups: readonly OptionGroup[] | undefined): string[] {
  if (!groups?.length) return [];
  const out: string[] = [];
  const at = (m: string) => out.push(`${productId}: ${m}`);
  if (groups.length > 6) at("too many option groups (6 at most)");
  if (groups.filter((g) => g.variant).length > 2) at("a product has at most 2 variant axes");
  const gids = new Set<string>();
  for (const g of groups) {
    if (!g.id || gids.has(g.id)) at(`option group id "${g.id}" is empty or repeated`);
    gids.add(g.id);
    if (!g.name?.trim() || g.name.length > 60) at(`option group "${g.id}" needs a name of up to 60 characters`);
    if (!["single", "multi", "qty"].includes(g.kind)) at(`option group "${g.name}" has an unknown kind`);
    if (g.variant && (g.kind !== "single" || !g.required)) at(`variant group "${g.name}" must be a required choose-one group`);
    if (g.required && g.kind !== "single") at(`only a choose-one group can be required ("${g.name}")`);
    if (!g.choices?.length || g.choices.length > 30) at(`option group "${g.name}" needs 1 to 30 choices`);
    for (const k of ["min", "free"] as const) {
      if (g[k] === undefined) continue;
      if (g.kind === "single") at(`a choose-one group cannot have a ${k === "min" ? "minimum" : "free allowance"} ("${g.name}")`);
      else if (!Number.isInteger(g[k]) || g[k]! < 0) at(`option group "${g.name}": ${k} must be a whole number of 0 or more`);
    }
    if (g.min !== undefined && g.max !== undefined && g.min > g.max) at(`option group "${g.name}": the minimum is above the maximum`);
    for (const k of ["max", "maxEach"] as const) if (g[k] !== undefined && (!Number.isInteger(g[k]) || g[k]! < 1)) at(`option group "${g.name}": ${k} must be a whole number of 1 or more`);
    const cids = new Set<string>();
    let defaults = 0;
    for (const c of g.choices ?? []) {
      if (!c.id || cids.has(c.id)) at(`choice id "${c.id}" in "${g.name}" is empty or repeated`);
      cids.add(c.id);
      if (!c.name?.trim() || c.name.length > 60) at(`a choice in "${g.name}" needs a name of up to 60 characters`);
      if (!Number.isSafeInteger(c.priceCents) || c.priceCents < 0) at(`choice "${c.name}" has an invalid price`);
      if (c.prefix !== undefined && !OPTION_PREFIXES.includes(c.prefix)) at(`choice "${c.name}" has an unknown prefix`);
      if (c.barcode !== undefined && (!g.variant || !/^[A-Za-z0-9._-]{3,40}$/.test(c.barcode))) at(`choice "${c.name}": a barcode is 3 to 40 letters, digits, dots or dashes, and only a variant has one`);
      if (c.default) defaults++;
    }
    if (defaults > 1 || (defaults && g.kind !== "single")) at(`option group "${g.name}": only a choose-one group can have one default`);
    if (g.required && g.kind === "single" && !(g.choices ?? []).some((c) => !c.soldOut)) at(`"${g.name}" is required but every choice is sold out`);
  }
  return out;
}

/**
 * For serving: a combo choice is sold out when the item it stands for is. Done on the way out, never before
 * validation, so switching one drink off cannot make an unrelated change fail.
 */
export function withComboAvailability(c: Catalog): Catalog {
  const out = new Map(c.products.map((p) => [p.id, !!p.soldOut]));
  if (!c.products.some((p) => p.options?.some((g) => g.choices.some((x) => x.productId)))) return c;
  return {
    ...c,
    products: c.products.map((p) =>
      p.options?.some((g) => g.choices.some((x) => x.productId))
        ? { ...p, options: p.options.map((g) => ({ ...g, choices: g.choices.map((x) => (x.productId && out.get(x.productId) ? { ...x, soldOut: true } : x)) })) }
        : p,
    ),
  };
}
