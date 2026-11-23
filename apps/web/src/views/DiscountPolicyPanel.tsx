import { useEffect, useState } from "react";
import { staffFetch } from "../auth";
import { loadDiscountPolicy } from "../discountPolicy";

/** How much a cashier may take off alone. Beyond it, or for any price change, the till asks for a manager's code and PIN. */
export function DiscountPolicyPanel() {
  const [pct, setPct] = useState("10");
  const [amt, setAmt] = useState("5.00");
  const [price, setPrice] = useState(true);
  const [msg, setMsg] = useState("");
  useEffect(() => { void loadDiscountPolicy().then((p) => { setPct(String(p.cashierMaxPercent)); setAmt((p.cashierMaxAmountCents / 100).toFixed(2)); setPrice(p.overrideNeedsManager); }); }, []);
  async function save() {
    const r = await staffFetch("/api/settings/discounts", { method: "PUT", body: { cashierMaxPercent: Math.round(Number(pct)), cashierMaxAmountCents: Math.round(Number(amt) * 100), overrideNeedsManager: price } });
    setMsg("res" in r && r.res.ok ? "Saved." : "Only a manager can change these limits, and the percentage must be 0 to 100.");
  }
  return (
    <div style={{ marginTop: 24 }}>
      <h3>Discounts and price changes</h3>
      <p className="muted">What a cashier may take off alone. Anything above this needs a manager's code and PIN at the till. Managers and owners are not limited. Every discount records who gave it, who approved it and why.</p>
      {msg && <div className="flash">{msg}</div>}
      <div className="row">
        <label className="field">Cashier may give up to (% off)<input inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value.replace(/\D/g, ""))} /></label>
        <label className="field">or up to (S$ off)<input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} /></label>
      </div>
      <label className="inline"><input type="checkbox" checked={price} onChange={(e) => setPrice(e.target.checked)} /> Changing a price by hand always needs a manager</label>
      <div className="row"><button className="primary sm" onClick={() => void save()}>Save</button></div>
    </div>
  );
}
