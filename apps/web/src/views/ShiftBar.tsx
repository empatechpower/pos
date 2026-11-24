import { useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { useStaff } from "../auth";
import { isTraining } from "../training";
import { cashMove, closeShift, loadShiftRequired, openOrders, openShift, shiftReport, syncShift, useShift, useShiftSettings, type OpenOrder, type ShiftReport } from "../shift";
import { CountEntry, countCents, countDenoms, emptyCount, type CountValue } from "./CountEntry";

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
const cents = (v: string) => Math.round(Number(v) * 100);

/** The shift's figures: what each way of paying took, the cash in and out, what the drawer should hold, and (once closed) what was counted. */
export function ShiftReportView({ r, final }: { r: ShiftReport; final?: boolean }) {
  const s = r.shift;
  const row = (k: string, v: string, bold = false) => <div className="od-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0", ...(bold ? { fontWeight: 700 } : {}) }}><span>{k}</span><span>{v}</span></div>;
  return (
    <div className="od-card">
      <b>{final ? "Z report · shift closed" : "Shift so far"} · Drawer {s.drawer} · {s.staffName}</b>
      <div className="muted">Opened {hm(s.openedAt)}{s.closedAt ? ` · closed ${hm(s.closedAt)}` : ""} · {r.orders} order{r.orders === 1 ? "" : "s"}</div>
      {r.tenders.map((t) => row(`${METHOD[t.method] ?? t.method}${t.refundsCents ? ` (refunded ${formatMoney(t.refundsCents)})` : ""}`, formatMoney(t.netCents)))}
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

/** The cashier's shift on this till: open it with a counted float, move cash in or out, look at the running figures, close with a count. */
export function ShiftBar() {
  const staff = useStaff();
  const shift = useShift();
  const { required } = useShiftSettings();
  const [panel, setPanel] = useState<"" | "cash" | "close" | "report">("");
  const [step, setStep] = useState<"orders" | "count">("count");
  const [open, setOpen] = useState<OpenOrder[]>([]);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [floatCount, setFloatCount] = useState<CountValue>(emptyCount());
  const [kind, setKind] = useState<"in" | "out">("out");
  const [amt, setAmt] = useState("");
  const [why, setWhy] = useState("");
  const [counted, setCounted] = useState<CountValue>(emptyCount());
  const [note, setNote] = useState("");
  const [needApproval, setNeedApproval] = useState(false);
  const [mgrCode, setMgrCode] = useState("");
  const [mgrPin, setMgrPin] = useState("");
  const [msg, setMsg] = useState("");
  const [assigned, setAssigned] = useState<null | { drawer: number; floatCents: number }>(null);
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (staff && !isTraining()) { void syncShift(); void loadShiftRequired(); } }, [staff?.code]);
  if (isTraining()) return <div className="muted">Shifts and drawers are not used in training mode.</div>;
  if (!staff) return required ? <div className="flash">Sign in and open your shift to take payments.</div> : null;

  async function doOpen() {
    setBusy(true); setMsg("");
    const r = await openShift(countCents(floatCount), countDenoms(floatCount));
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    setFloatCount(emptyCount());
    setAssigned({ drawer: r.shift.drawer, floatCents: r.shift.openingFloatCents });
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
  /** Closing starts with the orders still open: each is answered for before the count. */
  async function startClose() {
    if (!shift) return;
    setMsg(""); setNeedApproval(false); setMgrCode(""); setMgrPin(""); setLeft(new Set());
    const orders = await openOrders(shift.id);
    setOpen(orders);
    setStep(orders.length ? "orders" : "count");
    setPanel("close");
  }
  async function close() {
    if (!shift) return;
    setBusy(true); setMsg("");
    const r = await closeShift(shift.id, countCents(counted), note.trim(), true, { denominations: countDenoms(counted), dispositions: open, ...(needApproval ? { approverCode: mgrCode.trim(), approverPin: mgrPin } : {}) });
    setBusy(false);
    if (r.ok) { setReport(r.report); setPanel("report"); setCounted(emptyCount()); setNote(""); setNeedApproval(false); return; }
    if (r.needs === "approval") setNeedApproval(true);
    if (r.needs === "orders") { setOpen(r.orders ?? []); setLeft(new Set()); setStep("orders"); }
    setMsg(r.error);
  }

  if (!shift) {
    return (
      <div className="od-card">
        {report?.shift.closedAt ? <><ShiftReportView r={report} final /><button className="secondary sm" onClick={() => setReport(null)}>Done</button></> : assigned ? (
          <div role="status">
            <b>You are on Drawer {assigned.drawer}</b>
            <p className="muted">Drawer {assigned.drawer} opens for your cash sales, cash in and cash out. Your float is {formatMoney(assigned.floatCents)}.</p>
            <button className="primary sm" onClick={() => setAssigned(null)}>Start selling</button>
          </div>
        ) : (
          <>
            <b>{required ? "Open your shift to take payments" : "No shift open"}</b>
            <p className="muted">Your cash drawer is handed out for you. Count the opening float; the till starts counting from it.</p>
            <CountEntry value={floatCount} onChange={setFloatCount} />
            <button className="primary sm" disabled={busy} onClick={() => void doOpen()}>Open shift</button>
          </>
        )}
        {msg && <div className="flash" role="status">{msg}</div>}
      </div>
    );
  }
  return (
    <div className="od-card">
      {assigned && (
        <div role="status" className="flash">
          <b>You are on Drawer {assigned.drawer}.</b> It opens for your cash sales, cash in and cash out. Float {formatMoney(assigned.floatCents)}. <button className="link" onClick={() => setAssigned(null)}>OK</button>
        </div>
      )}
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ flex: 1 }}><b>Drawer {shift.drawer}</b> <span className="muted">· {shift.staffName} · since {hm(shift.openedAt)} · float {formatMoney(shift.openingFloatCents)}</span></span>
        <button className="secondary sm" onClick={() => { setPanel(panel === "cash" ? "" : "cash"); setMsg(""); }}>Cash in / out</button>
        <button className="secondary sm" onClick={() => void showReport()}>Report</button>
        <button className="secondary sm" onClick={() => void (panel === "close" ? setPanel("") : startClose())}>Close shift</button>
      </div>
      {msg && <div className="flash" role="status">{msg}</div>}
      {panel === "cash" && (
        <div className="editor">
          <div className="row">
            <label className="field">Cash<select value={kind} onChange={(e) => setKind(e.target.value as "in" | "out")}><option value="out">Taken out of the drawer (supplier, salary…)</option><option value="in">Put into the drawer (float top-up…)</option></select></label>
            <label className="field">Amount (S$)<input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(kind === "out" ? ["Supplier", "Staff salary", "Other"] : ["Float top-up", "Other"]).map((q) => <button key={q} type="button" className="secondary sm" onClick={() => setWhy(q === "Other" ? "" : q)}>{q}</button>)}
          </div>
          <label className="field">What for<input maxLength={120} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. bought ice" /></label>
          <button className="primary sm" disabled={busy || !cents(amt) || why.trim().length < 3} onClick={() => void move()}>Record</button>
        </div>
      )}
      {panel === "close" && step === "orders" && (
        <div className="editor">
          <b>Orders still open</b>
          <p className="muted">A shift cannot close while orders are unaccounted for. Settle each one at the till first, or leave it open on purpose.</p>
          {open.map((o) => (
            <div key={o.orderId} className="row" style={{ alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>#{o.queueNumber ?? "?"} · {o.channel ?? o.source} · {formatMoney(o.totalCents - o.paidCents)} owed</span>
              {left.has(o.orderId) ? <span className="muted">Left open</span> : <button className="secondary sm" onClick={() => setLeft(new Set([...left, o.orderId]))}>Leave open</button>}
            </div>
          ))}
          <button className="primary sm" disabled={left.size < open.length} onClick={() => setStep("count")}>Next: count the drawer</button>
        </div>
      )}
      {panel === "close" && step === "count" && (
        <div className="editor">
          <p className="muted">Count the cash in the drawer. The till then shows what it should have held.</p>
          <CountEntry value={counted} onChange={setCounted} />
          <label className="field">Note (optional)<input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {needApproval && (
            <div className="row">
              <label className="field">Manager code<input autoComplete="off" value={mgrCode} onChange={(e) => setMgrCode(e.target.value)} /></label>
              <label className="field">Manager PIN<input type="password" inputMode="numeric" autoComplete="off" value={mgrPin} onChange={(e) => setMgrPin(e.target.value)} /></label>
            </div>
          )}
          <button className="primary sm" disabled={busy || (needApproval && (!mgrCode.trim() || !mgrPin))} onClick={() => void close()}>{needApproval ? "Approve and close" : "Count and close"}</button>
        </div>
      )}
      {panel === "report" && report && <ShiftReportView r={report} final={!!report.shift.closedAt} />}
    </div>
  );
}
