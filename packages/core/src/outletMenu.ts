import { hasBuilder, validateBuilderSpec, type BuilderSpec } from "./builder.js";
import type { Catalog, Product } from "./catalog.js";

/**
 * A menu is published PER OUTLET (backend handout section 8). The brand's catalogue is the starting point; an outlet overrides only what is
 * different there: an item switched off, sold out, its own builder rules, or sold-out options. Prices already differ by outlet through the
 * price book assigned to it. Pure, so the server and a device apply the same overrides the same way.
 */
export interface OutletProductOverride {
  /** Not offered at this outlet at all. */
  off?: boolean;
  /** Sold out here (true), or available here though the brand marks it sold out (false). Missing = follow the brand. */
  soldOut?: boolean;
  /** This outlet's own build rules, replacing the brand's (clone and change). */
  builder?: BuilderSpec;
  /** Options sold out here: a builder option's id, or "groupId:choiceId" for an ordinary option group. */
  soldOutOptions?: string[];
}
export type OutletMenu = Record<string, OutletProductOverride>;

export const isEmptyOverride = (o: OutletProductOverride): boolean => !o.off && o.soldOut === undefined && !o.builder && !(o.soldOutOptions?.length);

/** The catalogue as one outlet sells it. Products switched off there are gone; the rest carry that outlet's state. */
export function applyOutletMenu(catalog: Catalog, menu: OutletMenu | undefined): Catalog {
  if (!menu || !Object.keys(menu).length) return catalog;
  const products: Product[] = [];
  for (const p of catalog.products) {
    const o = menu[p.id];
    if (!o) { products.push(p); continue; }
    if (o.off) continue;
    const out: Product = { ...p };
    if (o.soldOut !== undefined) out.soldOut = o.soldOut || undefined;
    if (o.builder) out.builder = o.builder;
    const gone = new Set(o.soldOutOptions ?? []);
    if (gone.size) {
      if (out.builder) {
        const mark = (groups: NonNullable<BuilderSpec["groups"]>) => groups.map((g) => ({ ...g, options: g.options.map((x) => (gone.has(x.id) ? { ...x, soldOut: true } : x)) }));
        out.builder = { ...out.builder, ...(out.builder.groups ? { groups: mark(out.builder.groups) } : {}), ...(out.builder.variants ? { variants: out.builder.variants.map((v) => ({ ...v, groups: mark(v.groups) })) } : {}) };
      }
      if (out.options) out.options = out.options.map((g) => ({ ...g, choices: g.choices.map((c) => (gone.has(`${g.id}:${c.id}`) ? { ...c, soldOut: true } : c)) }));
    }
    products.push(out);
  }
  return { ...catalog, products };
}

/** Problems with one product's override at an outlet. Empty means fine. */
export function validateOutletOverride(catalog: Catalog, productId: string, o: OutletProductOverride): string[] {
  const p = catalog.products.find((x) => x.id === productId);
  if (!p) return [`${productId}: no such item`];
  const problems: string[] = [];
  if (o.builder) {
    if (p.options?.length) problems.push(`${productId}: an item with options cannot have a builder here`);
    problems.push(...validateBuilderSpec(o.builder, `${productId} (this outlet)`, (id) => {
      const l = catalog.products.find((x) => x.id === id);
      return { exists: !!l, hasOptions: !!l && (!!l.options?.length || hasBuilder(l.builder)) };
    }));
  }
  if (o.soldOutOptions?.length) {
    const spec = o.builder ?? p.builder;
    const known = new Set<string>();
    for (const g of spec?.groups ?? []) for (const x of g.options) known.add(x.id);
    for (const v of spec?.variants ?? []) for (const g of v.groups) for (const x of g.options) known.add(x.id);
    for (const g of p.options ?? []) for (const c of g.choices) known.add(`${g.id}:${c.id}`);
    for (const id of o.soldOutOptions) if (!known.has(id)) problems.push(`${productId}: "${id}" is not one of this item's options`);
  }
  return problems;
}
