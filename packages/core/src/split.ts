import type { Cents } from "./money.js";

/**
 * Splitting one bill into checks (Revel's model, TengSern's Q41). Check totals are fixed when the split is made and always add up to the
 * order total to the cent. Pure and in integer cents.
 */
export interface CheckPlan { totalCents: Cents; seat?: number; shares?: Array<{ lineId: string; qty: number }> }
export interface SplitLine { lineId: string; qty: number; unitCents: Cents; seat?: number }

/** Split evenly between n people: the remainder cents go to the earliest checks, one cent each. */
export function splitEvenly(totalCents: Cents, n: number): CheckPlan[] | null {
  if (!Number.isInteger(n) || n < 2 || n > 20 || totalCents < 0) return null;
  const base = Math.floor(totalCents / n);
  const extra = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => ({ totalCents: base + (i < extra ? 1 : 0) }));
}

/** Split by amounts the cashier keys: the amounts given are the first checks, and what is left becomes the last check. Null when they are more than the bill. */
export function splitManually(totalCents: Cents, amounts: readonly Cents[]): CheckPlan[] | null {
  if (!amounts.length || amounts.some((a) => !Number.isInteger(a) || a <= 0)) return null;
  const sum = amounts.reduce((n, a) => n + a, 0);
  if (sum >= totalCents) return null;
  return [...amounts, totalCents - sum].map((totalCents) => ({ totalCents }));
}

/**
 * Split by item: each check carries units of the lines (`assignments[i]` maps a line id to how many of its units check i takes).
 * Every unit has to be taken by exactly one check. A check's total is the order total shared by the value of its items; the last check takes the remainder.
 */
export function splitByItem(lines: readonly SplitLine[], assignments: ReadonlyArray<Readonly<Record<string, number>>>, totalCents: Cents): CheckPlan[] | null {
  if (assignments.length < 2) return null;
  const live = lines.filter((l) => l.qty > 0);
  for (const l of live) if (assignments.reduce((n, a) => n + (a[l.lineId] ?? 0), 0) !== l.qty) return null;
  const value = assignments.map((a) => live.reduce((n, l) => n + (a[l.lineId] ?? 0) * l.unitCents, 0));
  if (value.some((v) => v <= 0)) return null;
  const sum = value.reduce((n, v) => n + v, 0);
  let given = 0;
  return assignments.map((a, i) => {
    const t = i === assignments.length - 1 ? totalCents - given : Math.round((totalCents * value[i]!) / sum);
    given += t;
    return { totalCents: t, shares: live.filter((l) => (a[l.lineId] ?? 0) > 0).map((l) => ({ lineId: l.lineId, qty: a[l.lineId]! })) };
  });
}

/** Split by seat number: one check for each seat that has items. */
export function splitBySeat(lines: readonly SplitLine[], totalCents: Cents): CheckPlan[] | null {
  const seats = [...new Set(lines.filter((l) => l.qty > 0).map((l) => l.seat ?? 1))].sort((a, b) => a - b);
  if (seats.length < 2) return null;
  const plan = splitByItem(lines, seats.map((s) => Object.fromEntries(lines.filter((l) => l.qty > 0 && (l.seat ?? 1) === s).map((l) => [l.lineId, l.qty]))), totalCents);
  return plan ? plan.map((c, i) => ({ ...c, seat: seats[i]! })) : null;
}
