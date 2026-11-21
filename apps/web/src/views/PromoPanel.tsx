import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch } from "../auth";

interface Promo { code: string; title: string; kind: "percent" | "amount"; value: number; minSpendCents: number; startsAt: string | null; endsAt: string | null; maxUses: number | null; maxPerMember: number | null; active: boolean; uses: number; discountedCents: number }

const blank = () => ({ code: "", title: "", kind: "amount" as "percent" | "amount", value: "", minSpend: "", startsAt: "", endsAt: "", maxUses: "", maxPerMember: "", active: true });
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * Promo codes for managers: a typed code that takes a percentage or a fixed amount off. The minimum spend is on the items only, before service
 * charge, tax and deposits. Whether a code can be used together with a wallet coupon is a setting here; points are independent of both.
 */
export function PromoPanel() {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [basis, setBasis] = useState("");
  const [stack, setStack] = useState(false);
  const [f, setF] = useState(blank());
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await staffFetch("/api/promos");
    if ("res" in r && r.res.ok) { const j = (await r.res.json()) as { basis: string; promos: Promo[] }; setPromos(j.promos); setBasis(j.basis); }
    const s = await staffFetch("/api/promo/settings");
    if ("res" in s && s.res.ok) setStack(((await s.res.json()) as { stackWithCoupons: boolean }).stackWithCoupons);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const edit = (p: Promo) => { setF({ code: p.code, title: p.title, kind: p.kind, value: p.kind === "percent" ? String(p.value) : (p.value / 100).toFixed(2), minSpend: p.minSpendCents ? (p.minSpendCents / 100).toFixed(2) : "", startsAt: day(p.startsAt), endsAt: day(p.endsAt), maxUses: p.maxUses ? String(p.maxUses) : "", maxPerMember: p.maxPerMember ? String(p.maxPerMember) : "", active: p.active }); setEditing(true); };

  async function save() {
    const cents = (v: string) => (v.trim() === "" ? undefined : Math.round(Number(v) * 100));
    const body = {
      title: f.title, kind: f.kind, value: f.kind === "percent" ? Math.round(Number(f.value)) : Math.round(Number(f.value) * 100),
      minSpendCents: cents(f.minSpend) ?? 0, startsAt: f.startsAt ? `${f.startsAt}T00:00:00+08:00` : null, endsAt: f.endsAt ? `${f.endsAt}T23:59:59+08:00` : null,
      maxUses: f.maxUses ? Number(f.maxUses) : null, maxPerMember: f.maxPerMember ? Number(f.maxPerMember) : null, active: f.active,
    };
    const r = await staffFetch(`/api/promos/${encodeURIComponent(f.code.trim())}`, { method: "PUT", body });
    if ("res" in r && r.res.ok) { setMsg(`${f.code.toUpperCase()} saved.`); setEditing(false); setF(blank()); void load(); }
    else if ("res" in r) { const j = (await r.res.json().catch(() => ({}))) as { problems?: string[] }; setMsg(j.problems?.join(" ") ?? "Could not save the code."); } else setMsg(r.problem);
  }
  async function setStacking(on: boolean) {
    const r = await staffFetch("/api/promo/settings", { method: "PUT", body: { stackWithCoupons: on } });
    if ("res" in r && r.res.ok) { setStack(on); setMsg(on ? "A code can now be used together with a coupon." : "One code or coupon per order."); }
  }
  const ok = f.code.trim().length >= 3 && f.title.trim() && Number(f.value) > 0;

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Promo codes</h3>
      <p className="muted">A customer types a code at checkout. {basis ? `The minimum spend is on the ${basis}.` : ""}</p>
      {msg && <div className="flash">{msg}</div>}
      <label className="inline"><input type="checkbox" checked={stack} onChange={(e) => void setStacking(e.target.checked)} /> A code can be used together with a wallet coupon (points are always separate)</label>
      {promos.length === 0 && <p className="muted">No promo codes yet.</p>}
      {promos.map((p) => (
        <div className="row" key={p.code} style={{ alignItems: "center", opacity: p.active ? 1 : 0.55 }}>
          <span style={{ flex: 1 }}><b>{p.code}</b> · {p.title}<small className="muted" style={{ display: "block" }}>{p.kind === "percent" ? `${p.value}% off` : `${formatMoney(p.value)} off`}{p.minSpendCents ? ` · min ${formatMoney(p.minSpendCents)} on items` : ""}{p.endsAt ? ` · until ${day(p.endsAt)}` : ""}{p.maxUses ? ` · ${p.uses}/${p.maxUses} used` : ` · ${p.uses} used`}{p.discountedCents ? ` · ${formatMoney(p.discountedCents)} given` : ""}{!p.active ? " · off" : ""}</small></span>
          <button className="secondary sm" onClick={() => edit(p)}>Edit</button>
        </div>
      ))}
      {!editing ? <button className="secondary sm" onClick={() => { setF(blank()); setEditing(true); }}>New promo code</button> : (
        <div className="editor">
          <div className="row">
            <label className="field">Code<input value={f.code} maxLength={30} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "") })} placeholder="e.g. SAVE5" /></label>
            <label className="field">Name customers see<input value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. S$5 off" /></label>
          </div>
          <div className="row">
            <label className="field">Takes off<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "percent" | "amount" })}><option value="amount">A fixed amount (S$)</option><option value="percent">A percentage</option></select></label>
            <label className="field">{f.kind === "percent" ? "Percent (1 to 100)" : "Amount (S$)"}<input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^\d.]/g, "") })} /></label>
            <label className="field">Minimum spend on items (S$)<input inputMode="decimal" value={f.minSpend} onChange={(e) => setF({ ...f, minSpend: e.target.value.replace(/[^\d.]/g, "") })} placeholder="none" /></label>
          </div>
          <div className="row">
            <label className="field">Valid from<input type="date" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></label>
            <label className="field">Valid until<input type="date" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
          </div>
          <div className="row">
            <label className="field">Most uses in total<input inputMode="numeric" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value.replace(/\D/g, "") })} placeholder="unlimited" /></label>
            <label className="field">Most uses per member<input inputMode="numeric" value={f.maxPerMember} onChange={(e) => setF({ ...f, maxPerMember: e.target.value.replace(/\D/g, "") })} placeholder="unlimited" /></label>
          </div>
          <label className="inline"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> The code works</label>
          <div className="row"><button className="primary sm" disabled={!ok} onClick={() => void save()}>Save</button><button className="secondary sm" onClick={() => { setEditing(false); setF(blank()); }}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}
