import { formatMoney } from "@pos/core";

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

export function CountEntry({ value, onChange }: { value: CountValue; onChange: (v: CountValue) => void }) {
  const filled = DENOMS.some((d) => value.counts[String(d)]);
  const sum = countCents(value);
  return (
    <div>
      <p className="muted">Count by note and coin, or just type the total below.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
        {DENOMS.map((d) => (
          <label key={d} className="row" style={{ alignItems: "center", gap: 8 }}>
            <span style={{ width: 52 }}>{formatMoney(d)}</span>
            <input style={{ width: 64, textAlign: "right" }} inputMode="numeric" placeholder="0" aria-label={`Count of ${formatMoney(d)}`} value={value.counts[String(d)] ?? ""} onChange={(e) => onChange({ ...value, counts: { ...value.counts, [String(d)]: e.target.value.replace(/\D/g, "").slice(0, 5) } })} />
            <small className="muted" style={{ marginLeft: "auto" }}>{formatMoney((parseInt(value.counts[String(d)] || "0", 10) || 0) * d)}</small>
          </label>
        ))}
      </div>
      <label className="field">Total $<input inputMode="decimal" readOnly={filled} placeholder="0.00" value={filled ? (sum / 100).toFixed(2) : value.total} onChange={(e) => onChange({ ...value, total: e.target.value.replace(/[^\d.]/g, "") })} /></label>
    </div>
  );
}
