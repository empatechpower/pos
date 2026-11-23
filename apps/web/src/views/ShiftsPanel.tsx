import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch } from "../auth";
import { closeShift, shiftReport, type ShiftReport } from "../shift";
import { ShiftReportView } from "./ShiftBar";

interface Row { id: string; drawer: 1 | 2; staffName: string; openedAt: number; closedAt: number | null; openingFloatCents: number; countedCents: number | null; expectedCents: number | null; varianceCents: number | null }
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/** For managers: who is on which drawer now, how recent shifts balanced, closing one a cashier forgot, and whether a shift must be open before payments. */
export function ShiftsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [required, setRequired] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [counted, setCounted] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const a = await staffFetch("/api/shifts");
    if ("res" in a && a.res.ok) setRows(((await a.res.json()) as { shifts: Row[] }).shifts);
    const b = await staffFetch("/api/settings/shifts");
    if ("res" in b && b.res.ok) setRequired(!!((await b.res.json()) as { required: boolean }).required);
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load]);

  async function toggle(on: boolean) {
    const r = await staffFetch("/api/settings/shifts", { method: "PUT", body: { required: on } });
    if ("res" in r && r.res.ok) { setRequired(on); setMsg(on ? "Cashiers must open a shift before taking payments." : "Shifts are optional."); } else setMsg("Only a manager can change this.");
  }
  async function view(row: Row) { setOpen(row.id); setReport(null); setCounted(""); setReport(await shiftReport(row.id)); }
  async function force(row: Row) {
    const r = await closeShift(row.id, Math.round(Number(counted || "0") * 100), "Closed by a manager", false);
    if (!r.ok) return setMsg(r.error);
    setReport(r.report); setMsg("Shift closed."); void load();
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Shifts and drawers</h3>
      <p className="muted">Each cashier opens a shift with a float and gets a drawer (two cashiers can share one till). Closing counts the cash against what the drawer should hold.</p>
      <label className="inline"><input type="checkbox" checked={required} onChange={(e) => void toggle(e.target.checked)} /> A shift must be open before a payment can be taken</label>
      {msg && <div className="flash">{msg}</div>}
      {rows.length === 0 && <p className="muted">No shifts yet.</p>}
      {rows.map((s) => (
        <div key={s.id} style={{ borderBottom: "1px solid var(--line, #ddd)", padding: "8px 0" }}>
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1 }}>
              <b>Drawer {s.drawer}</b> · {s.staffName} · {s.closedAt ? "closed" : <b style={{ color: "#1a7f37" }}>open</b>}
              <small className="muted" style={{ display: "block" }}>{when(s.openedAt)}{s.closedAt ? ` to ${when(s.closedAt)}` : ""} · float {formatMoney(s.openingFloatCents)}{s.varianceCents !== null ? ` · ${s.varianceCents === 0 ? "balanced" : s.varianceCents < 0 ? `short ${formatMoney(-s.varianceCents)}` : `over ${formatMoney(s.varianceCents)}`}` : ""}</small>
            </span>
            <button className="secondary sm" onClick={() => void (open === s.id ? setOpen(null) : view(s))}>{open === s.id ? "Hide" : "Report"}</button>
          </div>
          {open === s.id && (
            <div>
              {report && <ShiftReportView r={report} final={!!report.shift.closedAt} />}
              {!s.closedAt && (
                <div className="row" style={{ alignItems: "center", gap: 8 }}>
                  <label className="field">Cash counted (S$)<input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ""))} /></label>
                  <button className="secondary sm" disabled={counted === ""} onClick={() => void force(s)}>Close this shift</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
