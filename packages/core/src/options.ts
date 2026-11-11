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
  /** Pre-selected for required single-choice groups. */
  default?: boolean;
}

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
}

export type OptionError = "unknown_option" | "option_sold_out" | "missing_required" | "too_many_options" | "bad_option_quantity";

export const MAX_EACH_DEFAULT = 5;
export const QTY_MAX_DEFAULT = 10;

export type Resolved = { ok: true; options: ChosenOption[]; extraCents: Cents; key: string } | { ok: false; error: OptionError; groupId?: string };

/**
 * Check a selection against the item's option groups and price it. The same call runs on the server
 * (what is charged) and in the app (the live total), so they cannot disagree.
 */
export function resolveOptions(groups: readonly OptionGroup[] | undefined, input: readonly ChosenOptionInput[] = []): Resolved {
  const byGroup = new Map<string, Map<string, number>>();
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
      for (const q of picked?.values() ?? []) {
        if (g.kind === "multi" && q > 1) return { ok: false, error: "bad_option_quantity", groupId: g.id };
        if (g.kind === "qty" && q > (g.maxEach ?? MAX_EACH_DEFAULT)) return { ok: false, error: "bad_option_quantity", groupId: g.id };
      }
    }
    for (const c of g.choices) {
      const q = picked?.get(c.id);
      if (!q) continue;
      options.push({ group: g.name, name: c.name, qty: q, priceCents: c.priceCents });
      extra += c.priceCents * q;
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
  return (options ?? []).map((o) => (o.qty > 1 ? `${o.name} x${o.qty}` : o.name));
}
