import { useState } from "react";
import { formatMoney, newId, type OrderState } from "@pos/core";
import { hasPerm, staffFetch, useStaff } from "../auth";
import { isTraining } from "../training";
import { logView } from "../orderViews";

const METHOD: Record<string, string> = { cash: "Cash", credit: "Member credit", card: "Card", paynow: "PayNow" };
const REASONS = ["Wrong item", "Customer changed their mind", "Food or drink quality", "Cashier mistake", "Customer left", "Other"];
const ERRORS: Record<string, string> = {
  manager_approval_needed: "A manager has to approve this. Enter their code and PIN.",
  approval_refused: "That manager code or PIN is not right.",
  approver_locked: "That manager is locked out for a few minutes after too many wrong PINs.",
  approver_cannot_approve: "That person is not a manager.",
  payment_not_found: "The server does not have this payment yet. Wait a few seconds for it to sync, then try again.",
  reason_required: "Say why (at least a few letters).",
  amount_not_allowed: "That is more than is left to refund on this payment.",
  already_voided: "This order has already been voided.",
  card_payments_are_refunded_in_full_only: "A card payment can only be refunded in full.",
  payment_provider_refused_the_refund: "The card provider refused the refund. Try again, or refund it in their console.",
  credit_could_not_be_returned: "The member's credit could not be returned.",
  order_not_found: "The server does not have that order yet. Wait for it to sync, then try again.",
  outside_your_scope: "That order belongs to another outlet.",
};

/**
 * Giving money back on an order: refund part or all of one payment, or void the whole order. A reason is always asked for, and a manager always
 * approves: a signed-in manager does it themselves, a cashier types a manager's code and PIN. Every refund records who approved and why.
 */
export function RefundPanel({ order: o, onDone, startOpen }: { order: OrderState; onDone?: () => void; /** Show the form at once (the till's Refund Payments dialog), not behind a "Refund or void" button. */ startOpen?: boolean }) {
  const staff = useStaff();
  const [open, setOpen] = useState(!!startOpen);
  const [voidAsk, setVoidAsk] = useState(false);
  const [pay, setPay] = useState("");
  const [amt, setAmt] = useState("");
  const [why, setWhy] = useState(REASONS[0]!);
  const [other, setOther] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!staff || isTraining()) return null;
  const needsManager = !hasPerm(staff, "order.refund");
  const paid = o.payments.filter((p) => p.confirmed && p.amountCents > 0).map((p) => ({ ...p, left: p.amountCents - (o.refunds ?? []).filter((r) => r.paymentId === p.paymentId).reduce((n, r) => n + r.amountCents, 0) }));
  const refundable = paid.filter((p) => p.left > 0);
  const chosen = refundable.find((p) => p.paymentId === pay) ?? refundable[0];
  const reason = why === "Other" ? other.trim() : why;
  const approval = needsManager ? { approverCode: code.trim(), approverPin: pin } : {};
  const ready = reason.length >= 3 && (!needsManager || (code.trim() && pin));

  async function send(path: "refund" | "void") {
    setBusy(true); setMsg("");
    const body = path === "refund" ? { paymentId: chosen!.paymentId, amountCents: Math.round(Number(amt || chosen!.left / 100) * 100), reason, ...approval, refundId: newId() } : { reason, ...approval, voidId: newId() };
    const r = await staffFetch(`/api/orders/${o.orderId}/${path}`, { method: "POST", body });
    setBusy(false);
    if (!("res" in r)) return setMsg(r.problem);
    const j = (await r.res.json().catch(() => ({}))) as { error?: string; manual?: boolean | Array<{ method: string; amountCents: number }>; amountCents?: number; method?: string };
    if (!r.res.ok) return setMsg(ERRORS[j.error ?? ""] ?? "Could not do that. Try again.");
    setPin("");
    const by = Array.isArray(j.manual) ? j.manual.map((m) => `${formatMoney(m.amountCents)} ${METHOD[m.method]?.toLowerCase() ?? m.method}`).join(" and ") : j.manual ? `${formatMoney(j.amountCents ?? 0)} ${METHOD[j.method ?? ""]?.toLowerCase() ?? j.method}` : "";
    setMsg(path === "void" ? `Order voided.${by ? ` Give back ${by} by hand.` : ""}` : `Refunded.${by ? ` Give back ${by} by hand.` : ""}`);
    setOpen(false);
    onDone?.();
  }

  if (o.voided) return <div className="od-card"><b>Voided</b><div className="muted">{o.voided.reason} · approved by {o.voided.approvedByName}</div>{msg && <div className="flash" role="status">{msg}</div>}</div>;
  return (
    <div className="od-card">
      {(o.refunds ?? []).map((r) => <div className="od-row" key={r.refundId}><span>Refunded {METHOD[r.method] ?? r.method} · {r.reason} · {r.approvedByName}</span><span>-{formatMoney(r.amountCents)}</span></div>)}
      {msg && <div className="flash" role="status">{msg}</div>}
      {!open ? <button className="secondary sm" onClick={() => { setOpen(true); setMsg(""); logView(o.orderId, "Refund panel"); }}>Refund or void…</button> : (
        <div className="editor">
          {refundable.length > 0 && (
            <div className="row">
              <label className="field">Refund from<select value={chosen?.paymentId ?? ""} onChange={(e) => { setPay(e.target.value); setAmt(""); }}>{refundable.map((p) => <option key={p.paymentId} value={p.paymentId}>{METHOD[p.method] ?? p.method} · {formatMoney(p.left)} left</option>)}</select></label>
              <label className="field">Amount (S$)<input inputMode="decimal" value={amt} placeholder={chosen ? (chosen.left / 100).toFixed(2) : ""} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} /></label>
            </div>
          )}
          <div className="row">
            <label className="field">Why<select value={why} onChange={(e) => setWhy(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
            {why === "Other" && <label className="field">Say why<input maxLength={200} value={other} onChange={(e) => setOther(e.target.value)} /></label>}
          </div>
          {needsManager && (
            <div className="row">
              <label className="field">Manager code<input autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></label>
              <label className="field">Manager PIN<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
            </div>
          )}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {chosen && <button className="primary sm" disabled={!ready || busy} onClick={() => void send("refund")}>Refund {formatMoney(Math.round(Number(amt || chosen.left / 100) * 100))}</button>}
            {!voidAsk && <button className="secondary sm" disabled={!ready || busy} onClick={() => setVoidAsk(true)}>Void whole order</button>}
            {!voidAsk && <button className="secondary sm" onClick={() => setOpen(false)}>Cancel</button>}
          </div>
          {voidAsk && (
            <div className="flash warn" role="alertdialog" aria-label="Void this order?">
              Void this whole order and give back everything paid? This cannot be undone.
              <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: "center" }}>
                <button className="secondary sm" onClick={() => setVoidAsk(false)}>Keep order</button>
                <button className="primary sm" disabled={!ready || busy} onClick={() => { setVoidAsk(false); void send("void"); }}>Void order</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
