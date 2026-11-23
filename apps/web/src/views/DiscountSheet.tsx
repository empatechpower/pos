import { useEffect, useState } from "react";
import { DISCOUNT_REASONS, formatMoney } from "@pos/core";
import { useStaff } from "../auth";
import { askApproval, cachedPolicy, loadDiscountPolicy, needsApproval, type Approver, type DiscountPolicy } from "../discountPolicy";

export interface DiscountChoice {
  /** "price" sets the line's price by hand. */
  kind: "percent" | "amount" | "price";
  /** Percent (1 to 100), or cents. */
  value: number;
  reason: string;
  approver?: Approver;
}

/**
 * Giving a discount or changing a price at the till. A cashier may give up to the shop's limit alone; beyond it, or for any price change,
 * a manager types their code and PIN here. A reason is always asked for.
 */
export function DiscountSheet({ target, onApply, onClose }: { target: { scope: "line"; name: string; unitCents: number; qty: number } | { scope: "bill"; name: string; subtotalCents: number }; onApply: (c: DiscountChoice) => void; onClose: () => void }) {
  const staff = useStaff();
  const [policy, setPolicy] = useState<DiscountPolicy>(cachedPolicy());
  const [kind, setKind] = useState<"percent" | "amount" | "price">("percent");
  const [val, setVal] = useState("");
  const [why, setWhy] = useState<string>(DISCOUNT_REASONS[0]);
  const [other, setOther] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadDiscountPolicy().then(setPolicy); }, []);
  if (!staff) return null;

  const raw = Number(val);
  const value = kind === "percent" ? Math.round(raw) : Math.round(raw * 100);
  const reason = why === "Other" ? other.trim() : why;
  const base = target.scope === "line" ? target.unitCents * target.qty : target.subtotalCents;
  const valid = val !== "" && raw > 0 && (kind === "percent" ? raw <= 100 : kind === "amount" ? value <= base : value >= 0) && reason.length >= 3;
  const approval = needsApproval(staff.role, policy, { kind, value });
  const off = kind === "percent" ? Math.round((base * Math.min(raw, 100)) / 100) : kind === "amount" ? Math.min(value, base) : 0;

  async function apply() {
    setBusy(true); setMsg("");
    let approver: Approver | undefined;
    if (approval) {
      const r = await askApproval(code, pin, kind === "price" ? "price change" : "discount");
      if (!r.ok) { setBusy(false); return setMsg(r.error); }
      approver = r.approver;
    }
    setBusy(false);
    onApply({ kind, value, reason, ...(approver ? { approver } : {}) });
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", zIndex: 60 }}>
      <div style={{ background: "var(--bg, #fff)", color: "var(--fg, #111)", borderRadius: 14, padding: 20, width: "min(94vw, 440px)" }}>
        <h3 style={{ marginTop: 0 }}>{target.scope === "line" ? `Discount or price · ${target.name}` : "Discount the whole bill"}</h3>
        <div className="seg" role="tablist">
          <button className={kind === "percent" ? "on" : ""} onClick={() => setKind("percent")}>% off</button>
          <button className={kind === "amount" ? "on" : ""} onClick={() => setKind("amount")}>S$ off</button>
          {target.scope === "line" && <button className={kind === "price" ? "on" : ""} onClick={() => setKind("price")}>Set price</button>}
        </div>
        <label className="field">{kind === "percent" ? "Percent (1 to 100)" : kind === "amount" ? "Amount off (S$)" : "New price for one (S$)"}
          <input autoFocus inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.]/g, ""))} />
        </label>
        {kind !== "price" && val !== "" && <p className="muted">Takes off {formatMoney(off)} of {formatMoney(base)}.</p>}
        <label className="field">Why
          <select value={why} onChange={(e) => setWhy(e.target.value)}>{DISCOUNT_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
        </label>
        {why === "Other" && <label className="field">Say why<input maxLength={120} value={other} onChange={(e) => setOther(e.target.value)} /></label>}
        {approval && (
          <>
            <p className="muted">{kind === "price" ? "Changing a price needs a manager." : `A cashier can give up to ${policy.cashierMaxPercent}% or ${formatMoney(policy.cashierMaxAmountCents)}. This needs a manager.`}</p>
            <div className="row">
              <label className="field">Manager code<input autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} /></label>
              <label className="field">Manager PIN<input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
            </div>
          </>
        )}
        {msg && <div className="flash" role="alert">{msg}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="secondary sm" onClick={onClose}>Cancel</button>
          <button className="primary sm" disabled={!valid || busy || (approval && (!code.trim() || !pin))} onClick={() => void apply()}>Apply</button>
        </div>
      </div>
    </div>
  );
}
