import { useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { useStaff } from "../auth";
import { cashMove, closeShift, loadShiftRequired, openShift, shiftReport, syncShift, useShift, useShiftRequired, type ShiftReport } from "../shift";

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
const cents = (v: string) => Math.round(Number(v) * 100);

/** The shift's figures: what each way of paying took, the cash in and out, and what the drawer should hold. */
export function ShiftReportView({ r, final }: { r: ShiftReport; final?: boolean }) {
  const s = r.shift;
  const row = (k: string, v: string, bold = false) => <div className="od-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0", ...(bold ? { fontWeight: 700 } : {}) }}><span>{k}</span><span>{v}</span></div>;
  return (
    <div className="od-card">
      <b>{final ? "Shift closed" : "Shift so far"} · Drawer {s.drawer} · {s.staffName}</b>
      <div className="muted">Opened {hm(s.openedAt)}{s.closedAt ? ` · closed ${hm(s.closedAt)}` : ""} · {r.orders} order{r.orders === 1 ? "" : "s"}</div>
      {r.tenders.map((t) => row(`${METHOD[t.method] ?? t.method}${t.refundsCents ? ` (refunded ${formatMoney(t.refundsCents)})` : ""}`, formatMoney(t.netCents)))}
      {row("Opening float", formatMoney(s.openingFloatCents))}
      {r.cashIn.map((m, i) => row(`Cash in · ${m.reason}`, `+${formatMoney(m.amountCents)}`))}
      {r.cashOut.map((m, i) => row(`Cash out · ${m.reason}`, `-${formatMoney(m.amountCents)}`))}
      {row("Cash the drawer should hold", formatMoney(r.expectedCashCents), true)}
      {s.countedCents !== null && row("Cash counted", formatMoney(s.countedCents), true)}
      {s.varianceCents !== null && row(s.varianceCents === 0 ? "Balanced" : s.varianceCents < 0 ? "Short" : "Over", formatMoney(Math.abs(s.varianceCents)), true)}
      {s.note && <div className="muted">{s.note}</div>}
    </div>
  );
}

/** The cashier's shift on this till: open it with a float, move cash in or out, look at the running figures, close with a count. */
export function ShiftBar() {
  const staff = useStaff();
  const shift = useShift();
  const required = useShiftRequired();
  const [panel, setPanel] = useState<"" | "cash" | "close" | "report">("");
  const [float, setFloat] = useState("");
  const [kind, setKind] = useState<"in" | "out">("out");
  const [amt, setAmt] = useState("");
  const [why, setWhy] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (staff) { void syncShift(); void loadShiftRequired(); } }, [staff?.code]);
  if (!staff) return required ? <div className="flash">Sign in and open your shift to take payments.</div> : null;

  async function open() {
    setBusy(true); setMsg("");
    const r = await openShift(cents(float || "0"));
    setBusy(false);
    if (!r.ok) setMsg(r.error); else setFloat("");
  }
  async function move() {
    setBusy(true); setMsg("");
    const e = await cashMove(kind, cents(amt), why.trim());
    setBusy(false);
    if (e) return setMsg(e);
    setMsg(`${kind === "in" ? "Cash in" : "Cash out"} ${formatMoney(cents(amt))} recorded.`); setAmt(""); setWhy(""); setPanel("");
  }
  async function showReport() {
    if (!shift) return;
    setMsg(""); setPanel("report"); setReport(await shiftReport(shift.id));
  }
  async function close() {
    if (!shift) return;
    setBusy(true); setMsg("");
    const r = await closeShift(shift.id, cents(counted), note.trim(), true);
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    setReport(r.report); setPanel("report"); setCounted(""); setNote("");
  }

  if (!shift) {
    return (
      <div className="od-card">
        {report?.shift.closedAt ? <><ShiftReportView r={report} final /><button className="secondary sm" onClick={() => setReport(null)}>Done</button></> : (
          <>
            <b>{required ? "Open your shift to take payments" : "No shift open"}</b>
            <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label className="field">Opening float (S$)<input inputMode="decimal" value={float} placeholder="0.00" onChange={(e) => setFloat(e.target.value.replace(/[^\d.]/g, ""))} /></label>
              <button className="primary sm" disabled={busy} onClick={() => void open()}>Open shift</button>
            </div>
          </>
        )}
        {msg && <div className="flash" role="status">{msg}</div>}
      </div>
    );
  }
  return (
    <div className="od-card">
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ flex: 1 }}><b>Drawer {shift.drawer}</b> <span className="muted">· {shift.staffName} · since {hm(shift.openedAt)} · float {formatMoney(shift.openingFloatCents)}</span></span>
        <button className="secondary sm" onClick={() => { setPanel(panel === "cash" ? "" : "cash"); setMsg(""); }}>Cash in / out</button>
        <button className="secondary sm" onClick={() => void showReport()}>Report</button>
        <button className="secondary sm" onClick={() => { setPanel(panel === "close" ? "" : "close"); setMsg(""); }}>Close shift</button>
      </div>
      {msg && <div className="flash" role="status">{msg}</div>}
      {panel === "cash" && (
        <div className="editor">
          <div className="row">
            <label className="field">Cash<select value={kind} onChange={(e) => setKind(e.target.value as "in" | "out")}><option value="out">Taken out of the drawer</option><option value="in">Put into the drawer</option></select></label>
            <label className="field">Amount (S$)<input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          </div>
          <label className="field">What for<input maxLength={120} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. bought ice" /></label>
          <button className="primary sm" disabled={busy || !cents(amt) || why.trim().length < 3} onClick={() => void move()}>Record</button>
        </div>
      )}
      {panel === "close" && (
        <div className="editor">
          <p className="muted">Count the cash in the drawer and enter it. The system then shows what it should have held.</p>
          <label className="field">Cash counted (S$)<input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          <label className="field">Note (optional)<input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button className="primary sm" disabled={busy || counted === ""} onClick={() => void close()}>Count and close</button>
        </div>
      )}
      {panel === "report" && report && <ShiftReportView r={report} final={!!report.shift.closedAt} />}
    </div>
  );
}
