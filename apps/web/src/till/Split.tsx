import { useState } from "react";
import { COURSE_NAMES, checkStanding, formatMoney, newId, splitBySeat, splitByItem, splitEvenly, splitManually, type CheckPlan, type OrderState } from "@pos/core";
import { Modal } from "./Modal";

type Method = "even" | "manual" | "item" | "seat";
export interface SplitLineIn { lineId: string; name: string; qty: number; unitCents: number; seat?: number }

/**
 * Split Bill, as the prototype has it after TengSern reverted the radio list (Q43): four buttons, each with its name and a line saying what it does; tapping one goes straight to its step.
 * Check totals are fixed when the split is made and always add up to the order total.
 */
export function SplitDialog({ totalCents, lines, onCreate, onClose }: { totalCents: number; lines: SplitLineIn[]; onCreate: (method: Method, plan: CheckPlan[]) => void; onClose: () => void }) {
  const [method, setMethod] = useState<Method>("even");
  const [step, setStep] = useState<"pick" | "even" | "manual" | "item">("pick");
  const [n, setN] = useState(2);
  const [amounts, setAmounts] = useState<string[]>([""]);
  const [checks, setChecks] = useState(2);
  const [assign, setAssign] = useState<Array<Record<string, number>>>([{}, {}]);
  const [err, setErr] = useState("");
  const seats = new Set(lines.map((l) => l.seat ?? 1)).size;
  const cents = (s: string) => Math.round(Number(s || 0) * 100);

  const evenPlan = splitEvenly(totalCents, n);
  const manualAmts = amounts.map(cents).filter((a) => a > 0);
  const manualPlan = splitManually(totalCents, manualAmts);
  const taken = (id: string) => assign.reduce((c, a) => c + (a[id] ?? 0), 0);
  const itemPlan = splitByItem(lines.map((l) => ({ lineId: l.lineId, qty: l.qty, unitCents: l.unitCents })), assign, totalCents);
  const move = (ci: number, id: string, d: number) => setAssign((cur) => cur.map((a, i) => {
    if (i !== ci) return a;
    const next = (a[id] ?? 0) + d;
    if (next < 0 || (d > 0 && taken(id) >= (lines.find((l) => l.lineId === id)?.qty ?? 0))) return a;
    return { ...a, [id]: next };
  }));

  /** A method was tapped: By Seat makes the checks at once; the others ask for what they need. */
  function choose(m: Method) {
    setErr("");
    setMethod(m);
    if (m === "seat") { const p = splitBySeat(lines.map((l) => ({ lineId: l.lineId, qty: l.qty, unitCents: l.unitCents, seat: l.seat })), totalCents); if (!p) return setErr("Give items to at least two different seats first (open an item and set its seat)."); return onCreate("seat", p); }
    setStep(m);
  }
  function ok() {
    setErr("");
    if (step === "even") return evenPlan ? onCreate("even", evenPlan) : setErr("Choose between 2 and 20 people.");
    if (step === "manual") return manualPlan ? onCreate("manual", manualPlan) : setErr("Enter amounts that add up to less than the bill. What is left becomes the last check.");
    if (step === "item") return itemPlan ? onCreate("item", itemPlan) : setErr("Give every unit to a check, and every check at least one item.");
  }

  return (
    <Modal title="Split Bill" wide={step === "item"} onClose={onClose}>
      <p className="t-muted">Bill total {formatMoney(totalCents)}</p>
      {step === "pick" && (
        <>
          <p className="t-muted">Split this bill into separate checks. Each check is paid on its own; the order closes when every check is paid in full.</p>
          <div className="t-splitmethods">
            {([["even", "Split Evenly", "Divide the total equally between people"], ["manual", "Split Manually", "Key in an amount for each check"], ["item", "Split By Item", "Choose which items go on each check"], ["seat", "Split By Seat Number", "One check per seat"]] as Array<[Method, string, string]>).map(([m, l, d]) => (
              <button key={m} onClick={() => choose(m)} title={m === "seat" && seats < 2 ? "Needs items at two or more seats" : undefined}><strong>{l}</strong><span>{d}</span></button>
            ))}
          </div>
        </>
      )}
      {step === "even" && (
        <>
          <div className="t-stepper"><button onClick={() => setN(Math.max(2, n - 1))}>−</button><strong>{n}</strong><button onClick={() => setN(Math.min(20, n + 1))}>+</button></div>
          <p className="t-muted">people share the bill{evenPlan ? `: ${evenPlan.map((c) => formatMoney(c.totalCents)).join(" · ")}` : ""}</p>
        </>
      )}
      {step === "manual" && (
        <>
          {amounts.map((a, i) => <label className="t-field" key={i}>Check {i + 1} amount<input inputMode="decimal" value={a} onChange={(e) => setAmounts((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} placeholder="0.00" /></label>)}
          <button className="t-ghost" onClick={() => setAmounts((cur) => [...cur, ""])}>＋ Another check</button>
          <p className="t-muted">{manualPlan ? `Last check: ${formatMoney(manualPlan[manualPlan.length - 1]!.totalCents)}` : "The rest of the bill becomes the last check."}</p>
        </>
      )}
      {step === "item" && (
        <>
          <div className="t-stepper"><button onClick={() => { setChecks(Math.max(2, checks - 1)); setAssign((c) => c.slice(0, Math.max(2, checks - 1))); }}>−</button><strong>{checks} checks</strong><button onClick={() => { setChecks(Math.min(8, checks + 1)); setAssign((c) => [...c, {}]); }}>+</button></div>
          <div className="t-itemsplit">
            {lines.map((l) => (
              <div key={l.lineId} className="t-isrow"><b>{l.name}</b><span className="t-muted">{taken(l.lineId)} of {l.qty} given · {formatMoney(l.unitCents)} each</span>
                <div className="t-isc">{assign.map((a, ci) => <span key={ci} className="t-step"><small>#{ci + 1}</small><button aria-label={`Check ${ci + 1} fewer ${l.name}`} onClick={() => move(ci, l.lineId, -1)}>−</button><i>{a[l.lineId] ?? 0}</i><button aria-label={`Check ${ci + 1} more ${l.name}`} onClick={() => move(ci, l.lineId, 1)}>+</button></span>)}</div>
              </div>
            ))}
          </div>
          {itemPlan && <p className="t-muted">{itemPlan.map((c, i) => `#${i + 1} ${formatMoney(c.totalCents)}`).join(" · ")}</p>}
        </>
      )}
      {err && <p className="t-err" role="alert">{err}</p>}
      <div className="t-dact"><button className="t-ghost" onClick={step === "pick" ? onClose : () => { setStep("pick"); setErr(""); }}>{step === "pick" ? "Cancel" : "Back"}</button>{step !== "pick" && <button className="t-primary" onClick={ok}>Create checks</button>}</div>
    </Modal>
  );
}

/**
 * The checks board is its own full-screen view (Q43): one big card for each check with what it carries, what has been paid and what is due,
 * Print Check / Pay Check on each, and the board actions across the top.
 */
export function ChecksBoard(p: {
  order: OrderState; canAdd: boolean;
  onPay: (checkId: string) => void; onPrint: (checkId?: string) => void; onRefund: () => void; onClear: () => void; onAdd: () => void; onClose: () => void; onHold: () => void;
}) {
  const split = p.order.split;
  if (!split) return null;
  const anyPaid = p.order.payments.some((x) => x.checkId && x.confirmed);
  const lineBy = new Map(p.order.lines.map((l) => [l.lineId, l]));
  const paidAll = split.checks.reduce((n, c) => n + (checkStanding(p.order, c.id)?.paidCents ?? 0), 0);
  const total = split.checks.reduce((n, c) => n + c.totalCents, 0);
  return (
    <section className="t-checks" aria-label="Checks">
      <div className="t-checkbar">
        <h2>Split bill · {p.order.spot ?? "Order"}</h2>
        <div className="t-checkacts">
          <button className="t-ghost" onClick={() => p.onPrint()}>Print All Checks</button>
          <button className="t-ghost" onClick={p.onRefund} disabled={!anyPaid}>Refund Payments</button>
          <button className="t-ghost" onClick={p.onClear}>Clear Split Bills</button>
          <button className="t-primary" onClick={p.onClose}>Order Screen</button>
        </div>
      </div>
      <div className="t-checkgrid">
        {split.checks.map((c) => {
          const st = checkStanding(p.order, c.id)!;
          const paid = st.dueCents === 0;
          return (
            <article key={c.id} className={`t-check ${paid ? "paid" : ""}`}>
              <header><strong>Check #{String(c.no).padStart(2, "0")}</strong>{c.seat ? <span>Seat {c.seat}</span> : null}{paid && <em>PAID</em>}</header>
              <div className="t-checklines">
                {c.shares ? c.shares.map((sh) => { const l = lineBy.get(sh.lineId); return l ? <div key={sh.lineId}><span>{sh.qty} × {l.name}{l.course ? ` · ${COURSE_NAMES[l.course] ?? ""}` : ""}</span><span>{formatMoney(l.unitCents * sh.qty)}</span></div> : null; }) : <div className="t-muted">{split.method === "even" ? "An equal share of the bill" : "An amount of the bill"}</div>}
              </div>
              <div className="t-checktot"><span>TOTAL</span><strong>{formatMoney(c.totalCents)}</strong></div>
              {st.paidCents > 0 && <div className="t-checkpaid"><span>Paid</span><span>{formatMoney(st.paidCents)}</span></div>}
              <div className="t-checkdue"><span>Balance Due</span><strong>{formatMoney(st.dueCents)}</strong></div>
              <footer><button className="t-ghost" onClick={() => p.onPrint(c.id)}>Print Check</button><button className="t-primary" disabled={paid} onClick={() => p.onPay(c.id)}>Pay Check</button></footer>
            </article>
          );
        })}
        <button className="t-check addtile" disabled={!p.canAdd} onClick={p.onAdd} title={p.canAdd ? undefined : "Checks cannot be added once a payment has been taken."}>＋ Add New Check{!p.canAdd && <small>Payments have started</small>}</button>
      </div>
      <div className="t-checkfoot"><span>Paid so far {formatMoney(paidAll)} · still due {formatMoney(Math.max(0, total - paidAll))}</span><button className="t-ghost" onClick={p.onHold}>Hold Order</button></div>
    </section>
  );
}
export { newId };
