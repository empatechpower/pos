import type { Catalog, Product } from "./catalog.js";
import type { ChosenOption } from "./options.js";
import type { StoredBuild } from "./builder.js";

/**
 * Stock (14 Nov handout, section 1.9 and the schema's stock_basis / recipe / inventory tables).
 * A product has ONE stock basis: Finished Stock (selling it deducts its own stock item) or Made From Recipe (selling it deducts the recipe's
 * ingredients, and nothing of its own). Never both for one sale. A combo's shell never consumes; its chosen parts do, each its own product's stock.
 * A linked option (a combo choice or a build-your-own option that points at a real product) deducts that product's stock. Each element deducts once.
 */
export interface ProductStock {
  basis: "finished" | "recipe";
  /** Finished Stock: the stock item one unit of this product uses up. */
  itemId?: string;
  /** Made From Recipe: the ingredients one unit uses, as whole numbers in each item's own unit (grams, pieces...). */
  recipe?: Array<{ itemId: string; qty: number }>;
}

export interface StockUse { itemId: string; qty: number }

const MAX_QTY = 1_000_000;

/** Problems with a product's stock set-up. `itemExists` is optional: the server knows which stock items exist. */
export function validateProductStock(s: ProductStock | undefined, label: string, itemExists?: (id: string) => boolean): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.basis !== "finished" && s.basis !== "recipe") return [`${label}: stock basis is finished or recipe`];
  if (s.basis === "finished") {
    if (!s.itemId) out.push(`${label}: finished stock needs a stock item`);
    else if (itemExists && !itemExists(s.itemId)) out.push(`${label}: stock item "${s.itemId}" does not exist`);
    if (s.recipe?.length) out.push(`${label}: a product is finished stock or made from a recipe, never both`);
  } else {
    if (s.itemId) out.push(`${label}: a product is finished stock or made from a recipe, never both`);
    if (!s.recipe?.length) out.push(`${label}: a recipe needs at least one ingredient`);
    const seen = new Set<string>();
    for (const l of s.recipe ?? []) {
      if (!l.itemId) out.push(`${label}: a recipe line needs a stock item`);
      else if (seen.has(l.itemId)) out.push(`${label}: ${l.itemId} appears twice in the recipe`);
      else if (itemExists && !itemExists(l.itemId)) out.push(`${label}: stock item "${l.itemId}" does not exist`);
      seen.add(l.itemId);
      if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) out.push(`${label}: a recipe quantity is a whole number from 1 to ${MAX_QTY}`);
    }
  }
  return out;
}

/** What ONE unit of a product uses. A product with no stock basis uses nothing. */
export function unitUse(p: Pick<Product, "stock"> | undefined): StockUse[] {
  const s = p?.stock;
  if (!s) return [];
  if (s.basis === "finished") return s.itemId ? [{ itemId: s.itemId, qty: 1 }] : [];
  return (s.recipe ?? []).map((l) => ({ itemId: l.itemId, qty: l.qty }));
}

const merge = (uses: StockUse[]): StockUse[] => {
  const m = new Map<string, number>();
  for (const u of uses) m.set(u.itemId, (m.get(u.itemId) ?? 0) + u.qty);
  return [...m].filter(([, q]) => q !== 0).map(([itemId, qty]) => ({ itemId, qty }));
};

/**
 * The single consumption plan for one order line: the product's own use, plus the use of every product it links to (combo parts, linked and
 * build-your-own options), all multiplied by the line's quantity. Totals are merged per stock item, so each element deducts exactly once.
 */
export function consumptionPlan(catalog: Pick<Catalog, "products">, line: { productId: string; qty: number; options?: readonly ChosenOption[]; build?: Pick<StoredBuild, "selections"> }): StockUse[] {
  if (!(line.qty > 0)) return [];
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const uses: StockUse[] = [];
  const add = (productId: string | undefined, times: number) => {
    const p = productId ? byId.get(productId) : undefined;
    for (const u of unitUse(p)) uses.push({ itemId: u.itemId, qty: u.qty * times });
  };
  add(line.productId, line.qty);
  for (const o of line.options ?? []) if (o.productId) add(o.productId, line.qty * Math.max(1, o.qty));
  for (const s of line.build?.selections ?? []) if (s.productId) add(s.productId, line.qty * Math.max(1, s.qty));
  return merge(uses);
}

/** The plan for a whole order: every line's plan, merged. */
export function orderConsumption(catalog: Pick<Catalog, "products">, lines: ReadonlyArray<{ productId: string; qty: number; options?: readonly ChosenOption[]; build?: Pick<StoredBuild, "selections"> }>): StockUse[] {
  return merge(lines.flatMap((l) => consumptionPlan(catalog, l)));
}

/** Whether `onHand` (stock item → quantity) covers what is needed. Lists the shortfalls, or an empty list. */
export function shortfalls(needed: readonly StockUse[], onHand: ReadonlyMap<string, number>): Array<{ itemId: string; needed: number; onHand: number }> {
  return needed.filter((n) => (onHand.get(n.itemId) ?? 0) < n.qty).map((n) => ({ itemId: n.itemId, needed: n.qty, onHand: onHand.get(n.itemId) ?? 0 }));
}

/**
 * 86: a product whose stock cannot make one more unit is sold out, and so is any combo choice or build-your-own option that links to it.
 * Products with no stock basis are untouched (manual sold-out still applies). Returns a new catalog; the input is not changed.
 */
export function applyStockToMenu<C extends Pick<Catalog, "products">>(catalog: C, onHand: ReadonlyMap<string, number>): C {
  const out = new Map<string, boolean>();
  const outOf = (p: Product) => shortfalls(unitUse(p), onHand).length > 0;
  for (const p of catalog.products) if (p.stock) out.set(p.id, outOf(p));
  if (![...out.values()].some(Boolean)) return catalog;
  return {
    ...catalog,
    products: catalog.products.map((p) => ({
      ...p,
      ...(out.get(p.id) ? { soldOut: true } : {}),
      ...(p.options ? { options: p.options.map((g) => ({ ...g, choices: g.choices.map((c) => (c.productId && out.get(c.productId) ? { ...c, soldOut: true } : c)) })) } : {}),
      ...(p.builder ? { builder: mapBuilder(p.builder, out) } : {}),
    })),
  };
}

function mapBuilder<T extends { groups?: any[]; variants?: any[] }>(spec: T, out: Map<string, boolean>): T {
  const groups = (gs: any[]) => gs.map((g) => ({ ...g, options: g.options.map((o: any) => (o.productId && out.get(o.productId) ? { ...o, soldOut: true } : o)) }));
  return { ...spec, ...(spec.groups ? { groups: groups(spec.groups) } : {}), ...(spec.variants ? { variants: spec.variants.map((v: any) => ({ ...v, groups: groups(v.groups) })) } : {}) };
}
