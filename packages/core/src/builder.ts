import type { Cents } from "./money.js";

/**
 * Build-your-own ("builder") products: a bowl, a pizza, a salad. A product is made of groups ("Protein", "Supplements"); each group has
 * rules (how many may be chosen) and an optional allowance (some of the price is already covered by the base price). Everything here is
 * DATA on the product, never code: minimums, maximums, allowances and prices all come from the catalogue.
 *
 * The server prices every build (the app may preview, but a client total is never trusted), and a built item is stored as groups and
 * selections with their allocated prices, not as a line of text. (Backend handout, 20 Nov 2026.)
 */

export type AllowanceMode = "none" | "count" | "dollar";

export interface BuilderAllowance {
  mode: AllowanceMode;
  /** count: how many selections are free. dollar: how many cents of selections are covered. none: ignored. */
  value: number;
}

export interface BuilderOption {
  /** Unique within its group. The same option keeps the same id in every variant that offers it, so one sold-out switch covers them all. */
  id: string;
  name: string;
  /** The option's FULL price, before any allowance. */
  priceCents: Cents;
  /** Most of this option in one selection (a doubled broccoli is 2). Default 1. */
  maxQty?: number;
  /** Optional link to a plain menu item, for stock deduction, kitchen routing and sold-out. It must have no options of its own. */
  productId?: string;
  /** Sold out (set per outlet when the menu is read for an outlet). A sold-out option cannot be newly selected. */
  soldOut?: boolean;
}

export interface BuilderGroup {
  id: string;
  name: string;
  /** Most units in total (counting quantities). null = no maximum. */
  maxSelect: number | null;
  /** Fewest units in total. A group with a minimum above 0 is required. */
  minSelect: number;
  allowance?: BuilderAllowance;
  options: BuilderOption[];
}

/** A variant (Petite, Regular, Large, No Protein) swaps the ENTIRE rule set: which groups exist, their limits, allowances and option prices. */
export interface BuilderVariant {
  id: string;
  name: string;
  /** Added to the product's price for this variant, in whole cents (negative for a smaller size when the product price is the regular one). */
  priceDeltaCents?: Cents;
  groups: BuilderGroup[];
}

/** What a builder product carries. Either `groups` (one rule set) or `variants` (a rule set each). */
export interface BuilderSpec {
  groups?: BuilderGroup[];
  variants?: BuilderVariant[];
}

/** What the customer picked. The ORDER of `picks` is the order they were selected: allowance is used up in that order. */
export interface BuildInput {
  variantId?: string;
  picks: Array<{ groupId: string; optionId: string; qty?: number }>;
}

export const isRequired = (g: BuilderGroup): boolean => g.minSelect > 0;
export const hasBuilder = (spec: BuilderSpec | undefined): spec is BuilderSpec => !!spec && ((spec.groups?.length ?? 0) > 0 || (spec.variants?.length ?? 0) > 0);

export type VariantError = "variant_required" | "unknown_variant" | "variant_not_allowed";

/** The rule set in force: the product's own groups, or the chosen variant's. */
export function ruleSetFor(spec: BuilderSpec, variantId?: string): { ok: true; groups: BuilderGroup[]; deltaCents: Cents; variantName?: string } | { ok: false; error: VariantError } {
  if (spec.variants?.length) {
    if (!variantId) return { ok: false, error: "variant_required" };
    const v = spec.variants.find((x) => x.id === variantId);
    if (!v) return { ok: false, error: "unknown_variant" };
    return { ok: true, groups: v.groups, deltaCents: v.priceDeltaCents ?? 0, variantName: v.name };
  }
  if (variantId) return { ok: false, error: "variant_not_allowed" };
  return { ok: true, groups: spec.groups ?? [], deltaCents: 0 };
}

export type GroupState = "satisfied" | "below_min" | "above_max" | "unavailable_option" | "unknown_option" | "bad_quantity";

/** The verdict on one group, with the numbers involved, so the app can say exactly what is missing. Validation never fails silently. */
export interface GroupCheck {
  groupId: string;
  groupName: string;
  state: GroupState;
  /** Units chosen in this group (quantities counted). */
  selected: number;
  min: number;
  max: number | null;
  /** below_min: how many more are needed. */
  shortfall?: number;
  /** above_max: how many too many. */
  excess?: number;
  /** unavailable_option / unknown_option / bad_quantity: which options. */
  optionIds?: string[];
}

export interface BuildValidation {
  ok: boolean;
  /** Set when the variant itself is wrong; no group checks are made then. */
  variantError?: VariantError;
  groups: GroupCheck[];
}

const unitsOf = (q: number | undefined) => q ?? 1;

/**
 * Check a build against its rule set. `unavailable` holds the option ids that are sold out (for this outlet); a sold-out option cannot be
 * newly selected. Pure: the same call runs when a line is added, edited, and at order submission.
 */
export function validateBuild(spec: BuilderSpec, input: BuildInput, unavailable: ReadonlySet<string> = new Set()): BuildValidation {
  const rs = ruleSetFor(spec, input.variantId);
  if (!rs.ok) return { ok: false, variantError: rs.error, groups: [] };
  const checks: GroupCheck[] = [];
  const known = new Set(rs.groups.map((g) => g.id));
  for (const g of rs.groups) {
    const picks = input.picks.filter((p) => p.groupId === g.id);
    const selected = picks.reduce((n, p) => n + (Number.isInteger(p.qty ?? 1) && (p.qty ?? 1) > 0 ? unitsOf(p.qty) : 0), 0);
    const base = { groupId: g.id, groupName: g.name, selected, min: g.minSelect, max: g.maxSelect };
    const unknown = picks.filter((p) => !g.options.some((o) => o.id === p.optionId)).map((p) => p.optionId);
    if (unknown.length) { checks.push({ ...base, state: "unknown_option", optionIds: unknown }); continue; }
    const badQty = picks.filter((p) => {
      const o = g.options.find((x) => x.id === p.optionId)!;
      const q = p.qty ?? 1;
      return !Number.isInteger(q) || q < 1 || q > (o.maxQty ?? 1);
    }).map((p) => p.optionId);
    if (badQty.length) { checks.push({ ...base, state: "bad_quantity", optionIds: badQty }); continue; }
    const out = picks.filter((p) => unavailable.has(p.optionId) || g.options.find((o) => o.id === p.optionId)?.soldOut).map((p) => p.optionId);
    if (out.length) { checks.push({ ...base, state: "unavailable_option", optionIds: [...new Set(out)] }); continue; }
    if (selected < g.minSelect) { checks.push({ ...base, state: "below_min", shortfall: g.minSelect - selected }); continue; }
    if (g.maxSelect !== null && selected > g.maxSelect) { checks.push({ ...base, state: "above_max", excess: selected - g.maxSelect }); continue; }
    checks.push({ ...base, state: "satisfied" });
  }
  // A pick for a group this rule set does not have (for example Protein on the No Protein variant).
  const stray = input.picks.filter((p) => !known.has(p.groupId));
  for (const id of new Set(stray.map((p) => p.groupId))) {
    checks.push({ groupId: id, groupName: "", state: "unknown_option", selected: 0, min: 0, max: 0, optionIds: stray.filter((p) => p.groupId === id).map((p) => p.optionId) });
  }
  return { ok: checks.every((c) => c.state === "satisfied"), groups: checks };
}

/** One selection with where its price went: the full price, the part the allowance covered, and what the customer is charged. */
export interface SelectionPrice {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  qty: number;
  unitFullCents: Cents;
  fullCents: Cents;
  coveredCents: Cents;
  chargedCents: Cents;
  productId?: string;
}

export type PricedBuild =
  | {
      ok: true;
      variantId?: string;
      variantName?: string;
      baseCents: Cents;
      variantDeltaCents: Cents;
      selections: SelectionPrice[];
      /** What the selections add beyond the base price (the excess over the allowances). */
      chargedCents: Cents;
      /** One unit of the item: base + variant + the charged excess. */
      unitCents: Cents;
      /** The catalogue version the rules were read from, kept so a line can be re-opened exactly as it was built. */
      ruleVersion?: number;
    }
  | { ok: false; validation: BuildValidation };

/**
 * Price a build. The base price already includes each group's allowance, so the customer pays base + only what exceeds the allowance.
 * Allowance is used up in SELECTION ORDER (the order of `picks`), one unit at a time: an earlier selection uses it first, a later one pays only
 * the part that is left over. Doubling an option uses the allowance per unit.
 */
export function priceBuild(spec: BuilderSpec, input: BuildInput, baseCents: Cents, opts: { unavailable?: ReadonlySet<string>; ruleVersion?: number } = {}): PricedBuild {
  const validation = validateBuild(spec, input, opts.unavailable);
  if (!validation.ok) return { ok: false, validation };
  const rs = ruleSetFor(spec, input.variantId) as Extract<ReturnType<typeof ruleSetFor>, { ok: true }>;
  const left = new Map<string, number>(); // allowance remaining per group (cents, or free selections for "count")
  for (const g of rs.groups) left.set(g.id, g.allowance && g.allowance.mode !== "none" ? Math.max(0, g.allowance.value) : 0);
  const selections: SelectionPrice[] = [];
  for (const p of input.picks) {
    const g = rs.groups.find((x) => x.id === p.groupId)!;
    const o = g.options.find((x) => x.id === p.optionId)!;
    const qty = unitsOf(p.qty);
    let covered = 0;
    for (let u = 0; u < qty; u++) {
      const mode = g.allowance?.mode ?? "none";
      const rem = left.get(g.id) ?? 0;
      if (mode === "dollar") {
        const c = Math.min(o.priceCents, rem);
        covered += c;
        left.set(g.id, rem - c);
      } else if (mode === "count" && rem > 0) {
        covered += o.priceCents;
        left.set(g.id, rem - 1);
      }
    }
    const full = o.priceCents * qty;
    selections.push({ groupId: g.id, groupName: g.name, optionId: o.id, name: o.name, qty, unitFullCents: o.priceCents, fullCents: full, coveredCents: covered, chargedCents: full - covered, ...(o.productId ? { productId: o.productId } : {}) });
  }
  const charged = selections.reduce((n, s) => n + s.chargedCents, 0);
  return {
    ok: true,
    ...(input.variantId ? { variantId: input.variantId } : {}),
    ...(rs.variantName ? { variantName: rs.variantName } : {}),
    baseCents,
    variantDeltaCents: rs.deltaCents,
    selections,
    chargedCents: charged,
    unitCents: baseCents + rs.deltaCents + charged,
    ...(opts.ruleVersion !== undefined ? { ruleVersion: opts.ruleVersion } : {}),
  };
}

/**
 * A build as it is stored on an order line once priced: structured, with every selection's allocation FROZEN. Receipts, the kitchen and any
 * partial refund read this, never a text string. A refund can never exceed a selection's final charged allocation.
 */
export type StoredBuild = Extract<PricedBuild, { ok: true }>;

/** The build grouped by builder group, for a receipt or kitchen ticket: group name, then its selections with quantities and charged amounts. */
export function groupedBuild(b: Pick<StoredBuild, "selections">): Array<{ group: string; items: Array<{ name: string; qty: number; chargedCents: Cents }> }> {
  const out: Array<{ group: string; items: Array<{ name: string; qty: number; chargedCents: Cents }> }> = [];
  for (const s of b.selections) {
    let g = out.find((x) => x.group === s.groupName);
    if (!g) out.push((g = { group: s.groupName, items: [] }));
    const same = g.items.find((i) => i.name === s.name);
    if (same) { same.qty += s.qty; same.chargedCents += s.chargedCents; } else g.items.push({ name: s.name, qty: s.qty, chargedCents: s.chargedCents });
  }
  return out;
}

/** Problems with a builder spec that would make it misbehave. Empty means fine. Used before a catalogue change is accepted. */
export function validateBuilderSpec(spec: BuilderSpec, label: string, linkedProduct?: (productId: string) => { exists: boolean; hasOptions: boolean }): string[] {
  const problems: string[] = [];
  const sets: Array<{ name: string; groups: BuilderGroup[] }> = [];
  if (spec.groups?.length && spec.variants?.length) problems.push(`${label}: a builder product has either its own groups or variants, not both`);
  if (spec.variants?.length) {
    const ids = new Set<string>();
    for (const v of spec.variants) {
      if (!v.id || ids.has(v.id)) problems.push(`${label}: variant id "${v.id}" is empty or repeated`);
      ids.add(v.id);
      if (v.priceDeltaCents !== undefined && !Number.isInteger(v.priceDeltaCents)) problems.push(`${label}: variant ${v.name} has a bad price`);
      sets.push({ name: `${label} / ${v.name}`, groups: v.groups });
    }
  } else sets.push({ name: label, groups: spec.groups ?? [] });
  const optionIds = new Set<string>();
  for (const s of sets) {
    const groupIds = new Set<string>();
    for (const g of s.groups) {
      if (!g.id || groupIds.has(g.id)) problems.push(`${s.name}: group id "${g.id}" is empty or repeated`);
      groupIds.add(g.id);
      if (!g.name?.trim()) problems.push(`${s.name}: a group has no name`);
      if (!Number.isInteger(g.minSelect) || g.minSelect < 0) problems.push(`${s.name} / ${g.name}: the minimum must be a whole number, 0 or more`);
      if (g.maxSelect !== null && (!Number.isInteger(g.maxSelect) || g.maxSelect < Math.max(1, g.minSelect))) problems.push(`${s.name} / ${g.name}: the maximum must be at least the minimum (and at least 1)`);
      if (!g.options.length) problems.push(`${s.name} / ${g.name}: a group needs at least one option`);
      const a = g.allowance;
      if (a && !["none", "count", "dollar"].includes(a.mode)) problems.push(`${s.name} / ${g.name}: unknown allowance mode`);
      if (a && a.mode !== "none" && (!Number.isInteger(a.value) || a.value < 0)) problems.push(`${s.name} / ${g.name}: the allowance must be a whole number, 0 or more`);
      for (const o of g.options) {
        if (!o.id) problems.push(`${s.name} / ${g.name}: an option has no id`);
        if (!Number.isInteger(o.priceCents) || o.priceCents < 0) problems.push(`${s.name} / ${g.name} / ${o.name}: bad price`);
        if (o.maxQty !== undefined && (!Number.isInteger(o.maxQty) || o.maxQty < 1)) problems.push(`${s.name} / ${g.name} / ${o.name}: the most per selection must be 1 or more`);
        if (o.productId && linkedProduct) {
          const l = linkedProduct(o.productId);
          if (!l.exists) problems.push(`${s.name} / ${g.name} / ${o.name}: linked item "${o.productId}" does not exist`);
          else if (l.hasOptions) problems.push(`${s.name} / ${g.name} / ${o.name}: a linked item must not have options of its own (model it as a combo set instead)`);
        }
        optionIds.add(o.id);
      }
      const dup = g.options.map((o) => o.id).filter((id, i, a2) => a2.indexOf(id) !== i);
      if (dup.length) problems.push(`${s.name} / ${g.name}: option id "${dup[0]}" is repeated`);
    }
  }
  return problems;
}

/** The ticket lines of a build, grouped by builder group: a heading per group, then each selection with its quantity (and, for a receipt, what was charged). */
export function buildTicketLines(b: Pick<StoredBuild, "selections" | "variantName">, withPrices: boolean, money: (cents: Cents) => string): string[] {
  const out: string[] = [];
  if (b.variantName) out.push(b.variantName);
  for (const g of groupedBuild(b)) {
    out.push(`${g.group}:`);
    for (const i of g.items) out.push(`  ${i.qty > 1 ? `${i.qty} x ` : ""}${i.name}${withPrices && i.chargedCents > 0 ? ` (+${money(i.chargedCents)})` : ""}`);
  }
  return out;
}

/** The most that can ever be refunded for one selection of a stored build: what the customer was finally charged for it, never its full price. */
export function selectionRefundCap(b: Pick<StoredBuild, "selections">, groupId: string, optionId: string): Cents {
  return b.selections.filter((s) => s.groupId === groupId && s.optionId === optionId).reduce((n, s) => n + s.chargedCents, 0);
}
