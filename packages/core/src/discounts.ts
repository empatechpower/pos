import type { Cents } from "./money.js";

/** A discount a staff member gave: on one line, or on the whole bill. */
export interface StaffDiscount {
  id: string;
  scope: "line" | "bill";
  /** For a line discount: the line it is on. */
  lineId?: string;
  kind: "percent" | "amount";
  /** Percent (1 to 100) or cents. */
  value: number;
  reason: string;
  /** The staff member who gave it, and the manager who approved it when it needed one. */
  byName?: string;
  approvedByName?: string;
  at: number;
}

/** Why a discount or a changed price was given: the choices a till offers. */
export const DISCOUNT_REASONS = ["Staff meal", "Regular customer", "Complaint or delay", "Damaged or wrong item", "Promotion", "Manager's decision", "Other"] as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * What the staff discounts come to, in whole cents. Line discounts come off their line first (never below zero); bill discounts then come
 * off what is left of the whole bill, in the order they were given. Worked out from the order each time, so changing a quantity keeps it right.
 */
export function staffDiscountCents(lines: ReadonlyArray<{ lineId?: string; unitCents: Cents; qty: number }>, discounts: ReadonlyArray<StaffDiscount>): { totalCents: Cents; byDiscount: Record<string, Cents> } {
  const byDiscount: Record<string, Cents> = {};
  const gross = new Map<string, number>();
  for (const l of lines) if (l.lineId && l.qty > 0) gross.set(l.lineId, l.unitCents * l.qty);
  const left = new Map(gross);
  const take = (base: number, d: StaffDiscount) => (d.kind === "percent" ? Math.round((base * clamp(d.value, 0, 100)) / 100) : Math.round(Math.max(0, d.value)));
  for (const d of discounts.filter((x) => x.scope === "line")) {
    const base = left.get(d.lineId ?? "") ?? 0;
    const cents = clamp(take(base, d), 0, base);
    byDiscount[d.id] = cents;
    left.set(d.lineId ?? "", base - cents);
  }
  let billLeft = [...left.values()].reduce((n, v) => n + v, 0);
  for (const d of discounts.filter((x) => x.scope === "bill")) {
    const cents = clamp(take(billLeft, d), 0, billLeft);
    byDiscount[d.id] = cents;
    billLeft -= cents;
  }
  return { totalCents: Object.values(byDiscount).reduce((n, v) => n + v, 0), byDiscount };
}
