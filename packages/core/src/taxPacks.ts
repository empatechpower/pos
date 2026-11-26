import type { Cents } from "./money.js";
import type { PricingConfig } from "./pricing.js";

/**
 * A country's tax pack (handout 4.3 and standing rule 1): the tax an outlet charges follows the country the outlet is in. There is no setting
 * that overrides it. A pack holds the name and rate of the tax, how a total is rounded where the country requires it, and whether staff may
 * take the tax off an order.
 *
 * Whether a shop is registered for the tax is a fact about the shop (its registration number), not part of the pack.
 */
export interface RoundingRule {
  /** The smallest step a total may land on, in cents (5 = to the nearest five cents). */
  stepCents: number;
  mode: "nearest" | "down" | "up";
}

export interface TaxPack {
  /** ISO 3166-1 alpha-2. */
  country: string;
  countryName: string;
  taxName: string;
  /** 0.09 = 9%. */
  rate: number;
  /** Shelf prices already include the tax (it is shown, never added on top). A single item can still say otherwise. */
  pricesIncludeTax: boolean;
  /** The total is rounded this way and the difference is shown as its own line. Missing = totals are never rounded. */
  rounding?: RoundingRule;
  /** The steps (in cents) an outlet here may round a payment to, by tender: 5 = to the nearest five cents. An outlet chooses one, or none. */
  roundingSteps: number[];
  /** An outlet here may let staff take the tax off an order (the Add/Remove Tax action). It stays off until the outlet switches it on. */
  removable: boolean;
}

/**
 * Singapore: GST 9% (since 1 Jan 2024), inside the prices: the reference receipt reads "Total (SGD) INCL. GST" with the GST amount taken
 * out of the total (decision Q44, handout section 6).
 *
 * Malaysia: the tax is called SST. Its rate has not been given yet, so it is 0 here and charges nothing until the owner supplies it.
 *
 * Rounding and tax removal (owner, 25 Nov 2026): rounding is by tender, off by default, and an outlet may choose 5 or 10 cents in both
 * countries; taking tax off an order is an outlet setting, off by default.
 */
export const TAX_PACKS: Readonly<Record<string, TaxPack>> = {
  SG: { country: "SG", countryName: "Singapore", taxName: "GST", rate: 0.09, pricesIncludeTax: true, roundingSteps: [5, 10], removable: true },
  MY: { country: "MY", countryName: "Malaysia", taxName: "SST", rate: 0, pricesIncludeTax: false, roundingSteps: [5, 10], removable: true },
};
/** An outlet's rounding choices, kept to the tenders and steps its country allows: { cash: 5 } rounds cash payments to five cents. */
export function cleanTenderRounding(v: unknown, country: string | null | undefined): Record<string, number> | null {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const steps = taxPackFor(country).roundingSteps, out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,30}$/.test(k)) return null;
    if (n === 0 || n === null) continue;
    if (typeof n !== "number" || !steps.includes(n)) return null;
    out[k] = n;
  }
  return out;
}

export const DEFAULT_COUNTRY = "SG";
export const isTaxCountry = (c: unknown): c is string => typeof c === "string" && Object.prototype.hasOwnProperty.call(TAX_PACKS, c);
export const taxPackFor = (country: string | null | undefined): TaxPack => TAX_PACKS[isTaxCountry(country) ? country : DEFAULT_COUNTRY]!;

/** The pricing rules with the country's tax written in: the rate, the name, the rounding and whether the tax can be taken off. */
export function withTaxPack(pricing: PricingConfig, country: string | null | undefined): PricingConfig {
  const p = taxPackFor(country);
  const { rounding: _r, ...rest } = pricing;
  // Whether tax may be taken off is the outlet's own switch, within what the country allows: it stays as it was unless the country forbids it.
  return { ...rest, country: p.country, gstRate: p.rate, taxInclusive: p.pricesIncludeTax, taxName: p.taxName, roundingSteps: p.roundingSteps, taxRemovable: p.removable && !!pricing.taxRemovable, ...(p.rounding ? { rounding: p.rounding } : {}) };
}

/** A total rounded by the rule. A step under two cents rounds nothing. */
export function roundTotal(cents: Cents, rule: RoundingRule | undefined): Cents {
  const step = Math.round(rule?.stepCents ?? 0);
  if (!rule || step < 2 || cents <= 0) return cents;
  const q = cents / step;
  return (rule.mode === "down" ? Math.floor(q) : rule.mode === "up" ? Math.ceil(q) : Math.round(q)) * step;
}
