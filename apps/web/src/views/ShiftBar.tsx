import { formatMoney, paymentLabel } from "@pos/core";
import type { ShiftReport } from "../shift";

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/** The shift's figures: what each way of paying took, the cash in and out, what the drawer should hold, and (once closed) what was counted. */
export function ShiftReportView({ r, final }: { r: ShiftReport; final?: boolean }) {
  const s = r.shift;
  const row = (k: string, v: string, bold = false) => <div className="od-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0", ...(bold ? { fontWeight: 700 } : {}) }}><span>{k}</span><span>{v}</span></div>;
  return (
    <div className="od-card">
      <b>{final ? "Z report · shift closed" : "Shift so far"} · Drawer {s.drawer} · {s.staffName}</b>
      <div className="muted">Opened {hm(s.openedAt)}{s.closedAt ? ` · closed ${hm(s.closedAt)}` : ""} · {r.orders} order{r.orders === 1 ? "" : "s"}</div>
      {r.tenders.map((t) => row(`${METHOD[t.method] ?? paymentLabel(t.method)}${t.refundsCents ? ` (refunded ${formatMoney(t.refundsCents)})` : ""}`, formatMoney(t.netCents)))}
      {row("Opening float", formatMoney(s.openingFloatCents))}
      {r.cashIn.map((m) => row(`Cash in · ${m.reason}`, `+${formatMoney(m.amountCents)}`))}
      {r.cashOut.map((m) => row(`Cash out · ${m.reason}`, `-${formatMoney(m.amountCents)}`))}
      {row("Cash the drawer should hold", formatMoney(r.expectedCashCents), true)}
      {s.countedCents !== null && row("Cash counted", formatMoney(s.countedCents), true)}
      {s.varianceCents !== null && row(s.varianceCents === 0 ? "Balanced" : s.varianceCents < 0 ? "Short" : "Over", `${formatMoney(Math.abs(s.varianceCents))}${s.approvedByName ? ` · approved by ${s.approvedByName}` : ""}`, true)}
      {(s.dispositions ?? []).map((d) => row(`Order ${d.queueNumber ?? "·"} left open`, `by ${d.by} · ${hm(d.at)}`))}
      {s.note && <div className="muted">{s.note}</div>}
    </div>
  );
}
