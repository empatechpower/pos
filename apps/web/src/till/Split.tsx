import { useState } from "react";
import { COURSE_NAMES, checkStanding, formatMoney, newId, paymentKey, paymentLabel, splitBySeat, splitByItem, splitEvenly, splitManually, type CheckPlan, type OrderState } from "@pos/core";
import { ProtoDialog } from "../proto/ProtoDialog";

type Method = "even" | "manual" | "item" | "seat";
export interface SplitLineIn { lineId: string; name: string; qty: number; unitCents: number; seat?: number }

/**
 * Split Bill in the prototype's own markup (proto-reference/index.html: splitDialog, splitEvenAsk, splitManualRender, splitItemRender): four buttons, each
 * with its name and a line saying what it does; tapping one goes straight to its own dialog. Check totals are fixed when the split is made and always
 * add up to the order total.
 */
export function SplitDialog({ totalCents, lines, guests, onCreate, onClose }: { totalCents: number; lines: SplitLineIn[]; /** The order's guest count: the starting number of people for an even split. */ guests?: number; onCreate: (method: Method, plan: CheckPlan[]) => void; onClose: () => void }) {
  const [step, setStep] = useState<"pick" | "even" | "manual" | "item">("pick");
  const [n, setN] = useState(String(Math.max(2, guests ?? 2)));
  const [draft, setDraft] = useState<number[]>([]); // manual: the amounts carved out so far
  const [amount, setAmount] = useState("");
  const [assign, setAssign] = useState<Array<Record<string, number>>>([{}]);
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState("");
  const seats = new Set(lines.map((l) => l.seat ?? 1)).size;

  const used = draft.reduce((a, x) => a + x, 0), rem = totalCents - used;
  const taken = (id: string) => assign.reduce((c, a) => c + (a[id] ?? 0), 0);
  const subtotal = (a: Record<string, number>) => lines.reduce((c, l) => c + (a[l.lineId] ?? 0) * l.unitCents, 0);
  const unassigned = lines.some((l) => taken(l.lineId) < l.qty);
  const move = (id: string, d: number) => setAssign((cur) => cur.map((a, i) => (i === sel ? { ...a, [id]: Math.max(0, (a[id] ?? 0) + d) } : a)));
  const go = (to: typeof step) => { setErr(""); setStep(to); };

  /** A method was tapped: By Seat makes the checks at once; the others ask for what they need. */
  function choose(m: Method) {
    setErr("");
    if (m === "seat") { const p = splitBySeat(lines.map((l) => ({ lineId: l.lineId, qty: l.qty, unitCents: l.unitCents, seat: l.seat })), totalCents); return p ? onCreate("seat", p) : setErr("Give items to at least two different seats first (open an item and set its seat)."); }
    setStep(m);
  }
  function even() { const p = splitEvenly(totalCents, Math.round(Number(n))); return p ? onCreate("even", p) : setErr("Enter a number of people from 2 to 20."); }
  function addManual() {
    const v = Math.round(Number(amount || 0) * 100);
    if (!(v > 0) || v >= rem) return setErr(`Enter an amount above ${formatMoney(0)} and below the remaining ${formatMoney(rem)}.`);
    setDraft((d) => [...d, v]); setAmount(""); setErr("");
  }
  function manual() { const p = splitManually(totalCents, draft); return p ? onCreate("manual", p) : setErr("Those amounts do not leave anything for the last check."); }
  function items() { const p = splitByItem(lines.map((l) => ({ lineId: l.lineId, qty: l.qty, unitCents: l.unitCents })), assign, totalCents); return p ? onCreate("item", p) : setErr("Every check needs at least one item, and there must be at least two checks."); }

  return (
    <div className="proto protohead">
      {step === "pick" && (
        <ProtoDialog title="Split Bill" onClose={onClose}>
          <p className="muted">Split this bill into separate checks. Each check is paid on its own; the order closes when every check is paid in full.</p>
          <div className="splitmethods">
            {([["even", "Split Evenly", "Divide the total equally between people"], ["manual", "Split Manually", "Key in an amount for each check"], ["item", "Split By Item", "Choose which items go on each check"], ["seat", "Split By Seat Number", "One check per seat"]] as Array<[Method, string, string]>).map(([m, l, d]) => (
              <button key={m} onClick={() => choose(m)} title={m === "seat" && seats < 2 ? "Needs items at two or more seats" : undefined}><strong>{l}</strong><span>{d}</span></button>
            ))}
          </div>
          {err && <div className="error" role="alert">{err}</div>}
          <div className="actions"><button onClick={onClose}>Cancel</button></div>
        </ProtoDialog>
      )}
      {step === "even" && (
        <ProtoDialog title="Split Evenly" onClose={onClose}>
          <label className="field">Enter Number of People<input type="number" min={2} max={20} value={n} aria-label="Number of people" onChange={(e) => setN(e.target.value)} /></label>
          {err && <div className="error" role="alert">{err}</div>}
          <div className="actions"><button onClick={() => go("pick")}>Back</button><button className="primary" onClick={even}>Split</button></div>
        </ProtoDialog>
      )}
      {step === "manual" && (
        <ProtoDialog title="Split Manually" onClose={onClose}>
          <p className="muted">Key an amount to carve out a check. What is left becomes the last check.</p>
          {draft.map((a, i) => <div className="row" key={i}><span>Check {i + 1}</span><span>{formatMoney(a)}</span></div>)}
          <div className="row"><span>Remaining</span><strong>{formatMoney(rem)}</strong></div>
          <label className="field">Amount for Check {draft.length + 1} $<input type="number" step="0.01" min={0} value={amount} aria-label="Check amount" onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addManual(); }} /></label>
          <div className="error" role="alert">{err}</div>
          <div className="actions"><button onClick={() => go("pick")}>Back</button><button onClick={addManual}>Add check</button><button className="primary" disabled={!(draft.length && rem > 0)} onClick={manual}>Done</button></div>
        </ProtoDialog>
      )}
      {step === "item" && (
        <ProtoDialog title="Split By Item" extra="splitdialog" onClose={onClose}>
          <p className="muted">Tap a check, then move items onto it with + and −. Every item must be on a check before you finish.</p>
          <div className="checktabs">
            {assign.map((a, i) => <button key={i} className={i === sel ? "selected" : ""} onClick={() => setSel(i)}>Check {i + 1} · {formatMoney(subtotal(a))}</button>)}
            <button disabled={assign.length >= 8} onClick={() => { setAssign((c) => [...c, {}]); setSel(assign.length); }}>+ New Check</button>
          </div>
          {lines.map((l) => {
            const mine = assign[sel]?.[l.lineId] ?? 0, left = l.qty - taken(l.lineId);
            return (
              <div className="row splitline" key={l.lineId}>
                <span>{l.name} × {l.qty}<br /><small>{left > 0 ? `${left} not on a check yet` : "Fully assigned"} · On Check {sel + 1}: {mine}</small></span>
                <span className="qtycontrols"><button aria-label={`Fewer ${l.name}`} disabled={!mine} onClick={() => move(l.lineId, -1)}>−</button><button aria-label={`More ${l.name}`} disabled={left <= 0} onClick={() => move(l.lineId, 1)}>+</button></span>
              </div>
            );
          })}
          {err && <div className="error" role="alert">{err}</div>}
          <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={unassigned} onClick={items}>Done</button></div>
        </ProtoDialog>
      )}
    </div>
  );
}

const METHOD_NAME: Record<string, string> = { even: "Split Evenly", manual: "Split Manually", item: "Split By Item", seat: "Split By Seat Number" };

/**
 * The checks board, in the prototype's own markup (proto-reference/index.html: splitBoardHTML, checkCardHTML). It is its own full-screen view (Q43):
 * the board actions across the top, one card for each check with what it carries, what has been paid and what is due, Print Check / Pay Check
 * on each, and a tile for another check.
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
  const due = split.checks.reduce((n, c) => n + (checkStanding(p.order, c.id)?.dueCents ?? 0), 0);
  const no = p.order.queueNumber ?? "";
  return (
    <div className="proto protohead checksview">
      <main className="checks-main" aria-label="Checks">
        <div className="checks-top">
          <div>
            <h2>Split Bill · {p.order.spot ? `${p.order.spot} · ` : ""}Order {no}</h2>
            <p className="muted">{METHOD_NAME[split.method] ?? split.method} · {split.checks.length} checks · {formatMoney(due)} still due</p>
          </div>
          <div className="checks-actions">
            <button onClick={() => p.onPrint()}>Print All Checks</button>
            <button onClick={p.onRefund} disabled={!anyPaid}>Refund Payments</button>
            <button onClick={p.onClear}>Clear Split Bills</button>
            <button className="primary" onClick={p.onClose}>Order Screen</button>
          </div>
        </div>
        <div className="checkgrid big">
          {split.checks.map((c) => {
            const st = checkStanding(p.order, c.id)!;
            const paid = st.dueCents <= 0;
            return (
              <div key={c.id} className={`checkcard ${paid ? "paid" : ""}`}>
                <div className="row"><strong>Check #{no} - {c.no}{c.seat ? ` · Seat ${c.seat}` : ""}</strong><span>{paid ? "PAID" : `${formatMoney(st.dueCents)} due`}</span></div>
                {c.shares
                  ? c.shares.map((sh) => { const l = lineBy.get(sh.lineId); return l ? <div className="checkline" key={sh.lineId}><span>{l.name} × {sh.qty}{l.course ? ` · ${COURSE_NAMES[l.course] ?? ""}` : ""}</span><span>{formatMoney(l.unitCents * sh.qty)}</span></div> : null; })
                  : <div className="checkline"><span>Share of the bill</span><span></span></div>}
                {p.order.payments.filter((x) => x.checkId === c.id && x.confirmed).map((x) => <div className="checkline paidline" key={x.paymentId}><span>Paid · {paymentLabel(paymentKey(x))}</span><span>{formatMoney(x.amountCents)}</span></div>)}
                <div className="row checktotal"><span>TOTAL</span><strong>{formatMoney(c.totalCents)}</strong></div>
                <div className="checkactions"><button onClick={() => p.onPrint(c.id)}>Print Check</button><button className="primary" disabled={paid} onClick={() => p.onPay(c.id)}>Pay Check</button></div>
              </div>
            );
          })}
          <button className="addchecktile" disabled={!p.canAdd} onClick={p.onAdd}><span className="addplus">+</span><strong>Add New Check</strong><span>{p.canAdd ? "Split this bill further" : "Payments have started — refund them to change the checks"}</span></button>
        </div>
        <div className="checks-foot">
          <span className="muted">{anyPaid ? `${formatMoney(paidAll)} paid so far · ` : ""}{formatMoney(due)} still due</span>
          <span className="checks-actions"><button onClick={p.onHold}>Hold Order</button><button onClick={p.onClose}>Close</button></span>
        </div>
      </main>
    </div>
  );
}
export { newId };
