import type { Cents } from "./money.js";

/**
 * Item options: "Hot or cold", "Choose a protein", "Extras (+S$2.00 each)". A choice adds a price DELTA to
 * the item's base price, so the base price stays the lowest variant and a price range is computed, not stored.
 */
export interface OptionChoice {
  id: string;
  name: string;
  /** Added to the item's price (0 for "included"). */
  priceCents: Cents;
  soldOut?: boolean;
  /** A variant's own barcode or SKU (14 Nov handout 1.2: each variant is its own SKU). Scanning it adds the item as this variant. */
  barcode?: string;
  /** Pre-selected for required single-choice groups. */
  default?: boolean;
  /** Combos: the menu item this choice stands for. Its sold-out state follows that item, and a kitchen ticket prints it as its own item. */
  productId?: string;
  /** An instruction about the item's standard ingredients (14 Nov handout 1.3): No = leave it out, Side = serve it separately, Only = only this one, Lite = less of it. Preparation only: it never changes stock unless mapped in setup. */
  prefix?: OptionPrefix;
}

export type OptionPrefix = "no" | "side" | "only" | "lite";
export const OPTION_PREFIXES: readonly OptionPrefix[] = ["no", "side", "only", "lite"];
export const PREFIX_LABEL: Record<OptionPrefix, string> = { no: "No", side: "Side", only: "Only", lite: "Lite" };

export interface OptionGroup {
  id: string;
  name: string;
  /** single: pick one. multi: pick any, each at most once. qty: pick any, each several times. */
  kind: "single" | "multi" | "qty";
  /** single groups: exactly one must be chosen. */
  required: boolean;
  /** The item's own variation (Hot/Iced, Small/Big), as opposed to an add-on. Each variant is its own bag line. */
  variant?: boolean;
  /** Most units in total in this group (single is always 1). Defaults: multi = all choices, qty = 10. */
  max?: number;
  /** qty groups: most of any one choice. Default 5. */
  maxEach?: number;
  /** multi / qty groups: fewest units in total (counting quantities). A group with a minimum above 0 must be filled in before the item can be added. */
  min?: number;
  /** multi / qty groups: the first N units picked, in the order they were picked, are free; every later unit pays its own price (handout 1.3). Live: remove a free unit and the earliest paid one becomes free. */
  free?: number;
  choices: OptionChoice[];
}

/** What the customer or till picks. Only ids and counts: names and prices are filled in by whoever prices the order. */
export interface ChosenOptionInput {
  groupId: string;
  choiceId: string;
  qty?: number;
}

/** A chosen option with its name and price frozen, as stored on an order line. */
export interface ChosenOption {
  group: string;
  name: string;
  qty: number;
  priceCents: Cents;
  /** Combos: the menu item chosen for this part. */
  productId?: string;
  /** How many of `qty` fell inside the group's free allowance (charged 0). */
  freeQty?: number;
  prefix?: OptionPrefix;
  /** The item's own variation (Hot / Iced, Small / Large), not an add-on: the receipt prints it under the item's name. */
  variant?: boolean;
}

export type OptionError = "unknown_option" | "option_sold_out" | "missing_required" | "too_many_options" | "too_few_options" | "bad_option_quantity";

export const MAX_EACH_DEFAULT = 5;
export const QTY_MAX_DEFAULT = 10;

export type Resolved = { ok: true; options: ChosenOption[]; extraCents: Cents; key: string } | { ok: false; error: OptionError; groupId?: string };

/**
 * Check a selection against the item's option groups and price it. The same call runs on the server
 * (what is charged) and in the app (the live total), so they cannot disagree.
 */
export function resolveOptions(groups: readonly OptionGroup[] | undefined, input: readonly ChosenOptionInput[] = []): Resolved {
  const byGroup = new Map<string, Map<string, number>>();
  const freeBy = new Map<string, Map<string, number>>(); // group -> choice -> units that fell inside the free allowance
  const freeLeft = new Map<string, number>();
  for (const sel of input) {
    const group = groups?.find((g) => g.id === sel.groupId);
    const choice = group?.choices.find((c) => c.id === sel.choiceId);
    if (!group || !choice) return { ok: false, error: "unknown_option", groupId: sel.groupId };
    const qty = sel.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: "bad_option_quantity", groupId: group.id };
    if (choice.soldOut) return { ok: false, error: "option_sold_out", groupId: group.id };
    const m = byGroup.get(group.id) ?? new Map<string, number>();
    m.set(choice.id, (m.get(choice.id) ?? 0) + qty);
    byGroup.set(group.id, m);
    // The free allowance is used up in the order the units were picked, one unit at a time.
    if (group.kind !== "single" && (group.free ?? 0) > 0) {
      const left = freeLeft.get(group.id) ?? group.free!;
      const used = Math.min(left, qty);
      freeLeft.set(group.id, left - used);
      if (used > 0) {
        const f = freeBy.get(group.id) ?? new Map<string, number>();
        f.set(choice.id, (f.get(choice.id) ?? 0) + used);
        freeBy.set(group.id, f);
      }
    }
  }

  const options: ChosenOption[] = [];
  const keyParts: string[] = [];
  let extra = 0;
  for (const g of groups ?? []) {
    const picked = byGroup.get(g.id);
    const total = picked ? [...picked.values()].reduce((n, q) => n + q, 0) : 0;
    if (g.kind === "single") {
      if (total > 1) return { ok: false, error: "too_many_options", groupId: g.id };
      if (total === 0 && g.required) return { ok: false, error: "missing_required", groupId: g.id };
    } else {
      const max = g.max ?? (g.kind === "multi" ? g.choices.length : QTY_MAX_DEFAULT);
      if (total > max) return { ok: false, error: "too_many_options", groupId: g.id };
      if (total < (g.min ?? 0)) return { ok: false, error: "too_few_options", groupId: g.id };
      for (const q of picked?.values() ?? []) {
        if (g.kind === "multi" && q > 1) return { ok: false, error: "bad_option_quantity", groupId: g.id };
        if (g.kind === "qty" && q > (g.maxEach ?? MAX_EACH_DEFAULT)) return { ok: false, error: "bad_option_quantity", groupId: g.id };
      }
    }
    for (const c of g.choices) {
      const q = picked?.get(c.id);
      if (!q) continue;
      const free = freeBy.get(g.id)?.get(c.id) ?? 0;
      options.push({ group: g.name, name: c.name, qty: q, priceCents: c.priceCents, ...(c.productId ? { productId: c.productId } : {}), ...(free ? { freeQty: free } : {}), ...(c.prefix ? { prefix: c.prefix } : {}), ...(g.variant ? { variant: true } : {}) });
      extra += c.priceCents * (q - free);
      keyParts.push(`${g.id}:${c.id}:${q}`);
    }
  }
  return { ok: true, options, extraCents: extra, key: keyParts.join("|") };
}

/** The selection a customer starts with: the default (or first available) choice of each required single group. */
export function defaultSelection(groups: readonly OptionGroup[] | undefined): ChosenOptionInput[] {
  const out: ChosenOptionInput[] = [];
  for (const g of groups ?? []) {
    if (g.kind !== "single" || !g.required) continue;
    const c = g.choices.find((x) => x.default && !x.soldOut) ?? g.choices.find((x) => !x.soldOut);
    if (c) out.push({ groupId: g.id, choiceId: c.id });
  }
  return out;
}

/** Lowest and highest price from the required single-choice groups (e.g. Hot S$2.20 to Cold S$3.00). Extras are not counted. */
export function priceRange(baseCents: Cents, groups: readonly OptionGroup[] | undefined): [Cents, Cents] {
  let lo = baseCents;
  let hi = baseCents;
  for (const g of groups ?? []) {
    if (g.kind !== "single" || !g.required) continue;
    const deltas = g.choices.filter((c) => !c.soldOut).map((c) => c.priceCents);
    if (!deltas.length) continue;
    lo += Math.min(...deltas);
    hi += Math.max(...deltas);
  }
  return [lo, hi];
}

/** Short lines describing a line's options, for tickets and receipts: "Cold", "Sunny Side Egg x2". */
export function optionLines(options: readonly ChosenOption[] | undefined): string[] {
  return (options ?? []).map((o) => {
    const name = o.prefix ? `${PREFIX_LABEL[o.prefix]} ${o.name}` : o.name;
    return o.qty > 1 ? `${name} x${o.qty}` : name;
  });
}

/** A combo is an item whose choices stand for other menu items (a main, a side, a drink). */
export const isCombo = (groups: readonly OptionGroup[] | undefined): boolean => !!groups?.some((g) => g.choices.some((c) => c.productId));

/**
 * What a combo costs if each part were bought alone, against the combo's price: the saving shown to customers.
 * `priceOf` gives an item's own price (null if it has none). Parts with a surcharge count at their own price too,
 * so the saving is measured on the default choices.
 */
export function comboSaving(baseCents: Cents, groups: readonly OptionGroup[] | undefined, priceOf: (productId: string) => Cents | null): Cents {
  let alone = 0;
  let paid = baseCents;
  for (const g of groups ?? []) {
    if (g.kind !== "single" || !g.required || !g.choices.some((c) => c.productId)) continue;
    const c = g.choices.find((x) => x.default && !x.soldOut) ?? g.choices.find((x) => !x.soldOut);
    const own = c?.productId ? priceOf(c.productId) : null;
    if (!c || own === null) return 0;
    alone += own;
    paid += c.priceCents;
  }
  return Math.max(0, alone - paid);
}

/**
 * Split a combo order line into one line per part, so each part goes to the printer for its own kind of item
 * (the drink to the drink printer, the burger to the kitchen). Choices that are not parts (a "no ice" note) stay with the first part.
 * A line that is not a combo comes back unchanged. Part line ids are the combo's id plus "#n".
 */
export function splitComboLine<L extends { lineId: string; productId: string; name: string; qty: number; unitCents: Cents; options?: ChosenOption[] }>(line: L): L[] {
  const parts = (line.options ?? []).filter((o) => o.productId);
  if (!parts.length) return [line];
  const others = (line.options ?? []).filter((o) => !o.productId);
  return parts.map((o, i) => ({
    ...line,
    lineId: `${line.lineId}#${i}`,
    productId: o.productId!,
    name: o.name,
    qty: line.qty * o.qty,
    unitCents: 0,
    options: [{ group: "Combo", name: line.name, qty: 1, priceCents: 0 }, ...(i === 0 ? others : [])],
  }));
}
