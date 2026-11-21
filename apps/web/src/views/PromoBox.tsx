import { useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { tx } from "../shopI18n";

export interface AppliedPromo { code: string; title: string; discountCents: number }

interface Verdict { ok: boolean; code?: string; title?: string; discountCents?: number; reason?: string; minSpendCents?: number; shortfallCents?: number }

/** Why a code was refused, in words. The minimum is always stated on its basis: the items, before service charge, tax and deposits. */
function why(v: Verdict): string {
  switch (v.reason) {
    case "unknown": return tx("That code was not found.");
    case "inactive": return tx("That code is not active.");
    case "not_started": return tx("That code is not valid yet.");
    case "expired": return tx("That code has expired.");
    case "below_minimum": return tx("Add {amt} more in items to use this code. The minimum is {min} on the items, before service charge, tax and deposits.", { amt: formatMoney(v.shortfallCents ?? 0), min: formatMoney(v.minSpendCents ?? 0) });
    case "usage_exhausted": return tx("That code has been fully used.");
    case "member_limit_reached": return tx("You have already used that code.");
    case "sign_in_required": return tx("Sign in to use that code.");
    default: return tx("That code could not be used.");
  }
}

/** A typed promo code. It is checked by the shop's server against the bag, and again when the order is placed. */
export function PromoBox({ outletId, channelId, items, token, value, onChange }: { outletId?: string; channelId: string; /** The bag as it will be ordered (choices and builds included), so the subtotal matches what the server prices. */ items: object[]; token?: string | null; value: AppliedPromo | null; onChange: (p: AppliedPromo | null) => void }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const idsKey = JSON.stringify(items);

  async function check(code: string): Promise<Verdict | null> {
    const r = await fetch("/api/shop/promo/validate", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ outletId, channelId, items, code }) }).catch(() => null);
    return r?.ok ? ((await r.json()) as Verdict) : null;
  }

  async function apply() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const v = await check(text);
    setBusy(false);
    if (!v) { setMsg(tx("Could not check the code. Try again.")); return; }
    if (v.ok && v.code) { onChange({ code: v.code, title: v.title ?? v.code, discountCents: v.discountCents ?? 0 }); setMsg(""); setText(""); }
    else setMsg(why(v));
  }

  // The bag changed: the code is checked again, so a discount never outlives the cart it was worked out for.
  useEffect(() => {
    if (!value) return;
    let live = true;
    void check(value.code).then((v) => {
      if (!live || !v) return;
      if (!v.ok) { onChange(null); setMsg(why(v)); }
      else if ((v.discountCents ?? 0) !== value.discountCents) onChange({ code: value.code, title: v.title ?? value.code, discountCents: v.discountCents ?? 0 });
    });
    return () => { live = false; };
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="e2e-card" style={{ marginBottom: 12 }}>
      <h3>{tx("Promo code")}</h3>
      {value ? (
        <div className="sum-row"><span className="k">{value.title} · {value.code}</span><span className="v">−{formatMoney(value.discountCents)} <button className="secondary sm" onClick={() => onChange(null)}>{tx("Remove")}</button></span></div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <input className="e2e-input" value={text} maxLength={30} placeholder={tx("Enter code")} autoCapitalize="characters" aria-label={tx("Promo code")} onChange={(e) => setText(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") void apply(); }} />
          <button className="secondary sm" disabled={busy || !text.trim()} onClick={() => void apply()}>{tx("Apply")}</button>
        </div>
      )}
      {msg && <p className="muted" role="status">{msg}</p>}
    </div>
  );
}
