/** Notes and coins, biggest first. A count by denomination is optional: the cashier may type just a total. */
export const DENOMS = [10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5];
export interface CountValue { counts: Record<string, string>; total: string }
export const emptyCount = (): CountValue => ({ counts: {}, total: "" });
/** What the count comes to in cents: the grid when any denomination is filled, else the typed total. */
export function countCents(v: CountValue): number {
  const filled = DENOMS.some((d) => v.counts[String(d)]);
  return filled ? DENOMS.reduce((n, d) => n + (parseInt(v.counts[String(d)] || "0", 10) || 0) * d, 0) : Math.round(Number(v.total || 0) * 100);
}
/** The denominations that were counted, as the server keeps them. */
export const countDenoms = (v: CountValue): Record<string, number> => Object.fromEntries(DENOMS.filter((d) => parseInt(v.counts[String(d)] || "0", 10) > 0).map((d) => [String(d), parseInt(v.counts[String(d)]!, 10)]));
