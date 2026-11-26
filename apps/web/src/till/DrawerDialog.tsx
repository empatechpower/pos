import { useEffect, useState, type ReactNode } from "react";
import { formatMoney, paymentLabel } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { isTraining } from "../training";
import { cashMove, closeShift, drawerCount, drawerHistory, loadShiftRequired, openOrders, openShift, shiftReport, shiftSettings, syncShift, useShift, type DrawerHistory, type OpenOrder, type ShiftReport } from "../shift";
import { DENOMS, countCents, countDenoms, emptyCount, type CountValue } from "../views/CountEntry";
import { ProtoDialog } from "../proto/ProtoDialog";

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const when = (ms: number) => new Date(ms).toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore" });
const signed = (c: number) => `${c < 0 ? "−" : ""}${formatMoney(Math.abs(c))}`;

/** The prototype's denomination grid (denomGridHTML) and the total under it: count by note and coin, or just type the total. */
function Count({ label, value, onChange }: { label: string; value: CountValue; onChange: (v: CountValue) => void }) {
  const filled = DENOMS.some((d) => value.counts[String(d)]);
  return (
    <>
      <div className="denoms">
        {DENOMS.map((d) => (
          <div className="drow" key={d}>
            <span>{formatMoney(d)}</span>
            <input type="number" min={0} placeholder="0" aria-label={`Count of ${formatMoney(d)}`} value={value.counts[String(d)] ?? ""} onChange={(e) => onChange({ ...value, counts: { ...value.counts, [String(d)]: e.target.value.replace(/\D/g, "").slice(0, 5) } })} />
            <span className="dval">{formatMoney((parseInt(value.counts[String(d)] || "0", 10) || 0) * d)}</span>
          </div>
        ))}
      </div>
      <label className="field ce-total">{label}<input type="number" step="0.01" min={0} placeholder="0.00" readOnly={filled} value={filled ? (countCents(value) / 100).toFixed(2) : value.total} onChange={(e) => onChange({ ...value, total: e.target.value.replace(/[^\d.]/g, "") })} /></label>
    </>
  );
}

/** A shift's figures as the prototype's report table: each way of paying, the cash in and out, what the drawer should hold and, once closed, what was counted. */
function ReportTable({ r }: { r: ShiftReport }) {
  const s = r.shift;
  const row = (k: ReactNode, v: ReactNode, key?: string) => <tr key={key ?? String(k)}><td>{k}</td><td>{v}</td></tr>;
  return (
    <table className="rep">
      <tbody>
        {row("Paid orders", r.orders)}
        {r.tenders.map((t) => row(`${METHOD[t.method] ?? paymentLabel(t.method)}${t.refundsCents ? ` (refunded ${formatMoney(t.refundsCents)})` : ""}`, formatMoney(t.netCents), `t-${t.method}`))}
        {row("Opening float", formatMoney(s.openingFloatCents))}
        {r.cashIn.map((m, i) => row(`Cash in · ${m.reason}`, formatMoney(m.amountCents), `in-${i}`))}
        {r.cashOut.map((m, i) => row(`Cash out · ${m.reason}`, signed(-m.amountCents), `out-${i}`))}
        {row(<strong>Expected in drawer</strong>, <strong>{formatMoney(r.expectedCashCents)}</strong>, "expected")}
        {s.countedCents !== null && row("Counted", formatMoney(s.countedCents))}
        {s.varianceCents !== null && row("Variance", `${signed(s.varianceCents)}${s.approvedByName ? ` · approved by ${s.approvedByName}` : ""}`)}
        {(s.dispositions ?? []).map((d, i) => row(`Order ${d.queueNumber ?? "·"} left open`, `${d.by} · ${hm(d.at)}`, `d-${i}`))}
      </tbody>
    </table>
  );
}

type Step = "hub" | "in" | "out" | "count" | "counted" | "history" | "x" | "orders" | "z" | "approve";

/**
 * The cashier's shift and cash drawer, in the prototype's own dialogs (proto-reference/index.html: showOpenShift, openShift, drawerDialog, cashMove,
 * drawerCount, showCount, drawerHistory, xReport, zFlow, zCount, zFinish): open the shift with a counted float; then Cash Drawer N with its figures
 * and its actions; closing answers for the open orders, counts the drawer and ends on the Z report.
 */
export function DrawerDialog({ onClose }: { onClose: () => void }) {
  const staff = useStaff();
  const shift = useShift();
  const [step, setStep] = useState<Step>("hub");
  const [figures, setFigures] = useState<ShiftReport | null>(null);
  const [floatCount, setFloatCount] = useState<CountValue>(emptyCount());
  const [assigned, setAssigned] = useState<null | { drawer: number; floatCents: number }>(null);
  const [amt, setAmt] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [count, setCount] = useState<CountValue>(emptyCount());
  const [compared, setCompared] = useState<null | { countedCents: number; expectedCents: number; varianceCents: number }>(null);
  const [history, setHistory] = useState<DrawerHistory | null>(null);
  const [open, setOpen] = useState<OpenOrder[]>([]);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [mgrCode, setMgrCode] = useState("");
  const [mgrPin, setMgrPin] = useState("");
  const [closed, setClosed] = useState<ShiftReport | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (staff && !isTraining()) { void syncShift(); void loadShiftRequired(); } }, [staff?.code]);
  // The hub's figures come from the server; they are asked for again whenever the hub is shown, so a cash move or a sale is counted.
  useEffect(() => { if (shift && step === "hub") void shiftReport(shift.id).then((r) => { if (r) setFigures(r); }); }, [shift?.id, step]);

  const wrap = (title: string, body: ReactNode, extra = "") => <div className="proto protohead"><ProtoDialog title={title} extra={extra} onClose={onClose}>{body}</ProtoDialog></div>;
  const go = (s: Step) => { setMsg(""); setStep(s); };
  const error = <div className="error" role="alert">{msg}</div>;

  if (isTraining()) return wrap("Cash Drawer", <><p className="muted">Shifts and drawers are not used in training mode.</p><div className="actions"><button onClick={onClose}>Close</button></div></>);
  if (!staff) return wrap("Cash Drawer", <><p className="muted">Sign in and open your shift to take payments.</p><div className="actions"><button onClick={onClose}>Close</button></div></>);

  // The Z report of the shift that was just closed.
  if (closed) return wrap(`Z Report · ${closed.shift.staffName} · Drawer ${closed.shift.drawer}`, (
    <>
      <p className="muted">Shift opened {when(closed.shift.openedAt)}{closed.shift.closedAt ? ` · closed ${when(closed.shift.closedAt)}` : ""} · Float {formatMoney(closed.shift.openingFloatCents)}</p>
      <ReportTable r={closed} />
      {closed.shift.note && <p className="muted">{closed.shift.note}</p>}
      <div className="actions"><button className="primary" onClick={onClose}>Done</button></div>
    </>
  ));

  if (!shift) {
    if (assigned) return wrap("Your cash drawer", (
      <>
        <p style={{ fontSize: "1.0625em" }}>You are assigned <strong>Drawer {assigned.drawer}</strong>.</p>
        <p className="muted">Drawer {assigned.drawer} will kick for your cash sales, cash in and cash out. Your float is {formatMoney(assigned.floatCents)}.</p>
        <div className="actions"><button className="primary" onClick={onClose}>Start selling</button></div>
      </>
    ));
    const doOpen = async () => {
      setBusy(true); setMsg("");
      const r = await openShift(countCents(floatCount), countDenoms(floatCount));
      setBusy(false);
      if (!r.ok) return setMsg(r.error);
      setAssigned({ drawer: r.shift.drawer, floatCents: r.shift.openingFloatCents });
    };
    return wrap(`Open your shift, ${staff.name}`, (
      <>
        <p className="muted">Your cash drawer is assigned automatically from the drawers available. Count the opening float — selling starts once your shift is open.</p>
        <h3>Opening float</h3>
        <p className="muted">Denominations optional — or just enter the total.</p>
        <Count label="Float total $" value={floatCount} onChange={setFloatCount} />
        {error}
        <div className="actions"><button onClick={onClose}>Close</button><button className="primary" disabled={busy} onClick={() => void doOpen()}>Open shift</button></div>
      </>
    ), "openshift");
  }
  // The shift was opened a moment ago in this dialog: say which drawer before anything else.
  if (assigned) return wrap("Your cash drawer", (
    <>
      <p style={{ fontSize: "1.0625em" }}>You are assigned <strong>Drawer {assigned.drawer}</strong>.</p>
      <p className="muted">Drawer {assigned.drawer} will kick for your cash sales, cash in and cash out. Your float is {formatMoney(assigned.floatCents)}.</p>
      <div className="actions"><button className="primary" onClick={onClose}>Start selling</button></div>
    </>
  ));

  if (step === "in" || step === "out") {
    const reasons = step === "in" ? ["Float top-up", "Other"] : ["Supplier", "Staff salary", "Other"];
    const picked = reason || reasons[0]!;
    const cents = Math.round(Number(amt || 0) * 100);
    const why = picked === "Other" ? note.trim() : note.trim() ? `${picked} · ${note.trim()}` : picked;
    const save = async () => {
      if (!(cents > 0)) return setMsg("Enter an amount above zero.");
      if (why.length < 3) return setMsg("Say what it was for.");
      setBusy(true); setMsg("");
      const e = await cashMove(step, cents, why);
      setBusy(false);
      if (e) return setMsg(e);
      setAmt(""); setNote(""); setReason(""); go("hub");
    };
    return wrap(step === "in" ? "Cash in · Pay in" : "Cash out · Pay out", (
      <>
        <label className="field">Amount $<input type="number" step="0.01" min={0} aria-label="Amount" value={amt} onChange={(e) => setAmt(e.target.value)} /></label>
        <h3>Reason</h3>
        <div className="choices">{reasons.map((r) => <button type="button" key={r} className={picked === r ? "selected" : ""} onClick={() => setReason(r)}>{r}</button>)}</div>
        <label className="field">Note<input type="text" maxLength={100} aria-label="Note" placeholder={picked === "Other" ? "What it was for" : "Optional detail"} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {error}
        <div className="actions"><button onClick={() => { setAmt(""); setNote(""); setReason(""); go("hub"); }}>Back</button><button className="primary" disabled={busy} onClick={() => void save()}>Save</button></div>
      </>
    ));
  }

  if (step === "count") {
    const compare = async () => {
      setBusy(true); setMsg("");
      const r = await drawerCount(shift.id, countCents(count), countDenoms(count));
      setBusy(false);
      if (typeof r === "string") return setMsg(r);
      setCompared(r); setCount(emptyCount()); go("counted");
    };
    return wrap("Drawer count", (
      <>
        <Count label="Counted total $" value={count} onChange={setCount} />
        <p className="muted">{figures ? `Expected ${formatMoney(figures.expectedCashCents)}` : "The shift stays open. The till then shows what it expected."}</p>
        {error}
        <div className="actions"><button onClick={() => go("hub")}>Back</button><button className="primary" disabled={busy} onClick={() => void compare()}>Compare</button></div>
      </>
    ));
  }
  if (step === "counted" && compared) return wrap("Drawer count", (
    <>
      <table className="rep"><tbody>
        <tr><td>Counted</td><td>{formatMoney(compared.countedCents)}</td></tr>
        <tr><td>Expected</td><td>{formatMoney(compared.expectedCents)}</td></tr>
        <tr><td>Variance</td><td>{signed(compared.varianceCents)}</td></tr>
      </tbody></table>
      <div className="actions"><button onClick={() => go("hub")}>Done</button></div>
    </>
  ));

  if (step === "history") return wrap(`Drawer history · Drawer ${shift.drawer}`, (
    <>
      {!history ? <p className="muted">Loading…</p> : (
        <table className="rep"><tbody>
          <tr><td>{hm(history.openedAt)} · Opening float</td><td>{formatMoney(history.openingFloatCents)}</td></tr>
          {history.rows.map((h, i) => <tr key={i}><td>{hm(h.at)} · {h.what}<br /><small>{h.by}</small></td><td>{h.amountCents === null || h.amountCents === 0 ? "—" : signed(h.amountCents)}</td></tr>)}
        </tbody></table>
      )}
      {history && history.rows.length === 0 && <p className="muted">No drawer activity yet.</p>}
      <div className="actions"><button onClick={() => go("hub")}>Back</button></div>
    </>
  ));

  if (step === "x") return wrap(`X Report · ${shift.staffName} · Drawer ${shift.drawer}`, (
    <>
      <p className="muted">Shift opened {when(shift.openedAt)} · Float {formatMoney(shift.openingFloatCents)}{figures ? ` · Expected cash ${formatMoney(figures.expectedCashCents)}` : ""}</p>
      {figures ? <ReportTable r={figures} /> : <p className="muted">The figures could not be loaded. Check the connection and try again.</p>}
      <div className="actions"><button onClick={() => go("hub")}>Back</button></div>
    </>
  ));

  const close = async (approve: boolean) => {
    setBusy(true); setMsg("");
    const r = await closeShift(shift.id, countCents(count), note.trim(), true, { denominations: countDenoms(count), dispositions: open, ...(approve ? { approverCode: mgrCode.trim(), approverPin: mgrPin } : {}) });
    setBusy(false);
    if (r.ok) { setCount(emptyCount()); setNote(""); setMgrCode(""); setMgrPin(""); setClosed(r.report); return; }
    if (r.needs === "orders") { setOpen(r.orders ?? []); setLeft(new Set()); setStep("orders"); }
    else if (r.needs === "approval") setStep("approve");
    setMsg(r.error);
  };
  if (step === "orders") return wrap("Close shift — open orders first", (
    <>
      <p className="muted">Your shift cannot close until every open order is answered for: settle it at the till, or leave it open.</p>
      {open.map((o) => (
        <div className="row" style={{ margin: "0.75em 0" }} key={o.orderId}>
          <span><strong>#{o.queueNumber ?? "?"}</strong> · {o.channel ?? o.source} · {formatMoney(o.totalCents - o.paidCents)} owed<br /><small>Opened {hm(o.openedAt)}</small></span>
          <span>{left.has(o.orderId) ? <small>Left open</small> : <button onClick={() => setLeft(new Set([...left, o.orderId]))}>Leave open</button>}</span>
        </div>
      ))}
      {error}
      <div className="actions"><button onClick={() => go("hub")}>Cancel</button><button className="primary" disabled={left.size < open.length} onClick={() => go("z")}>Next: count your drawer</button></div>
    </>
  ));
  if (step === "z") {
    const policy = shiftSettings().variancePolicy;
    return wrap("Close shift · Z — count your drawer", (
      <>
        <Count label="Counted total $" value={count} onChange={setCount} />
        <label className="field">Note<input type="text" maxLength={200} aria-label="Closing note" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <p className="muted">{figures ? `Expected ${formatMoney(figures.expectedCashCents)} · ` : ""}Variance policy: {policy === "proceed" ? "close proceeds, variance on Z" : policy === "managerpin" ? "manager PIN for variance" : "blocked on variance"}</p>
        {error}
        <div className="actions"><button onClick={() => go("hub")}>Back</button><button className="primary" disabled={busy} onClick={() => void close(false)}>Close shift</button></div>
      </>
    ));
  }
  if (step === "approve") return wrap("Manager approval needed", (
    <>
      <p className="muted">{msg || "The drawer does not balance. A manager must approve closing this shift."}</p>
      <label className="field">Manager code<input type="text" autoComplete="off" aria-label="Manager code" value={mgrCode} onChange={(e) => setMgrCode(e.target.value)} /></label>
      <label className="field">Manager PIN<input type="password" inputMode="numeric" autoComplete="off" maxLength={8} aria-label="Manager PIN" value={mgrPin} onChange={(e) => setMgrPin(e.target.value)} /></label>
      <div className="actions"><button onClick={() => go("z")}>Back</button><button className="primary" disabled={busy || !mgrCode.trim() || !mgrPin} onClick={() => void close(true)}>Approve &amp; close</button></div>
    </>
  ));

  // The hub: Cash Drawer N.
  const noSale = async () => {
    setMsg("");
    const r = await staffFetch("/api/print/drawer", { body: { reason: "no sale" } });
    setMsg("problem" in r ? r.problem : r.res.ok ? `Drawer ${shift.drawer} opened (no-sale). It is logged.` : r.res.status === 403 ? "This account is not allowed to open the drawer." : "The drawer could not be opened: no receipt printer with a drawer is set up.");
  };
  const startClose = async () => {
    setMsg(""); setLeft(new Set()); setMgrCode(""); setMgrPin("");
    const orders = await openOrders(shift.id);
    setOpen(orders);
    setStep(orders.length ? "orders" : "z");
  };
  const cashSales = figures?.tenders.find((t) => t.method === "cash")?.netCents;
  const sum = (m: Array<{ amountCents: number }> | undefined) => (m ? formatMoney(m.reduce((n, x) => n + x.amountCents, 0)) : "—");
  return wrap(`Cash Drawer ${shift.drawer}`, (
    <>
      <table className="rep"><tbody>
        <tr><td>Shift opened</td><td>{when(shift.openedAt)}</td></tr>
        <tr><td>Opening float</td><td>{formatMoney(shift.openingFloatCents)}</td></tr>
        <tr><td>Cash sales</td><td>{figures ? formatMoney(cashSales ?? 0) : "—"}</td></tr>
        <tr><td>Cash in</td><td>{sum(figures?.cashIn)}</td></tr>
        <tr><td>Cash out</td><td>{sum(figures?.cashOut)}</td></tr>
        <tr><td><strong>Expected in drawer</strong></td><td><strong>{figures ? formatMoney(figures.expectedCashCents) : "—"}</strong></td></tr>
      </tbody></table>
      {msg && <div className="error" role="status">{msg}</div>}
      <div className="settingsgroup">
        <button onClick={() => void noSale()}>Open drawer (no-sale)</button>
        <button onClick={() => go("in")}>Cash in · Pay in</button>
        <button onClick={() => go("out")}>Cash out · Pay out</button>
        <button onClick={() => { setCount(emptyCount()); go("count"); }}>Drawer count</button>
        <button onClick={() => { setHistory(null); go("history"); void drawerHistory(shift.id).then(setHistory); }}>Drawer history</button>
        <button onClick={() => go("x")}>X report</button>
        <button className="primary" onClick={() => { setCount(emptyCount()); void startClose(); }}>Close shift · Z report</button>
      </div>
      <div className="actions"><button onClick={onClose}>Close</button></div>
    </>
  ));
}
