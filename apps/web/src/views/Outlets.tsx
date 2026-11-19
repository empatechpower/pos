import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch } from "../auth";

interface Franchise { id: string; name: string; active: boolean }
interface Outlet { id: string; name: string; franchiseId: string | null; address: string | null; phone: string | null; hours: string | null; active: boolean; serviceMode: "qsr" | "tsr" | null }
interface Summary { orders: number; netCents: number; netToAccountForCents: number; discountsCents: number; voided: { orders: number } }
interface Row { outletId: string; name: string; franchiseId: string | null; summary: Summary }
interface Info { brand: { id: string; name: string }; scope: { franchiseId: string | null; outletId: string | null; brandWide: boolean }; franchises: Franchise[]; outlets: Outlet[] }

const TZ = "Asia/Singapore";
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const MODE = { qsr: "Quick service (no table)", tsr: "Table service (a table is required)" } as const;
const RANGES = { today: ["Today", 0], week: ["Last 7 days", 6], month: ["Last 30 days", 29] } as const;

/**
 * The brand's franchises and outlets, and how each is trading. A brand owner sees everything and can add franchises and outlets;
 * a franchise or outlet login sees only what is theirs and can update their own outlet's address, phone and opening hours.
 */
export function Outlets() {
  const [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<{ outlets: Row[]; total: Summary } | null>(null);
  const [range, setRange] = useState<keyof typeof RANGES>("today");
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<Outlet | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [fr, setFr] = useState({ id: "", name: "" });
  const [opts, setOpts] = useState<{ serviceChargeOn: boolean; gstOn: boolean; serviceRate: number; gstRate: number } | null>(null);

  const load = useCallback(async () => {
    const r = await staffFetch("/api/outlets");
    if ("res" in r && r.res.ok) setInfo((await r.res.json()) as Info);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      const r = await staffFetch("/api/settings");
      if ("res" in r && r.res.ok) setOpts((await r.res.json()) as NonNullable<typeof opts>);
    })();
  }, []);
  async function setOption(body: { serviceChargeOn?: boolean; gstOn?: boolean }) {
    const r = await staffFetch("/api/settings", { method: "PUT", body });
    if ("res" in r && r.res.ok) { setOpts((await r.res.json()) as NonNullable<typeof opts>); say("Saved. Open screens pick it up on their next reload."); } else say("Could not save.");
  }
  useEffect(() => {
    void (async () => {
      const r = await staffFetch(`/api/reports/outlets?from=${day(RANGES[range][1])}&to=${day(0)}`);
      if ("res" in r && r.res.ok) setRows((await r.res.json()) as { outlets: Row[]; total: Summary });
    })();
  }, [range, info]);

  const say = (t: string) => { setMsg(t); window.setTimeout(() => setMsg(null), 4000); };
  const ERR: Record<string, string> = { brand_only: "Only the brand owner can do that.", outside_your_scope: "That is outside your outlets.", unknown_franchise: "That franchise does not exist." };
  async function save(path: string, body: object, done: string) {
    const r = await staffFetch(path, { method: "PUT", body });
    if ("res" in r && r.res.ok) { say(done); await load(); return true; }
    const code = "res" in r ? ((await r.res.json().catch(() => ({}))) as { error?: string }).error ?? "" : "";
    say(ERR[code] ?? "Could not save.");
    return false;
  }

  if (!info) return <p className="muted">Loading outlets…</p>;
  const brandWide = info.scope.brandWide;
  const frName = (id: string | null) => info.franchises.find((f) => f.id === id)?.name ?? null;
  const row = (id: string) => rows?.outlets.find((r) => r.outletId === id);

  return (
    <div className="rp">
      {msg && <div className="flash">{msg}</div>}
      <div className="rp-card">
        <h3>{info.brand.name}</h3>
        <p className="muted">
          You can see {brandWide ? "every franchise and outlet" : info.scope.outletId ? "one outlet" : "your franchise's outlets"}.
        </p>
        <div className="seg" style={{ margin: "6px 0" }}>
          {(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((k) => <button key={k} className={range === k ? "on" : ""} aria-pressed={range === k} onClick={() => setRange(k)}>{RANGES[k][0]}</button>)}
        </div>
        {rows && (
          <div className="rp-kv">
            <div><small>Orders</small><b>{rows.total.orders}</b></div>
            <div><small>Net sales</small><b>{formatMoney(rows.total.netCents)}</b></div>
            <div><small>To account for</small><b>{formatMoney(rows.total.netToAccountForCents)}</b></div>
            <div><small>Voided</small><b>{rows.total.voided.orders}</b></div>
          </div>
        )}
      </div>

      <div className="rp-card">
        <h3>Outlets ({info.outlets.length})</h3>
        {info.outlets.map((o) => {
          const s = row(o.id)?.summary;
          return (
            <button key={o.id} className="rp-row" onClick={() => { setEditing(o); setIsNew(false); }}>
              <span className="rp-main"><b>{o.name}{!o.active ? " (off)" : ""}</b><small>{o.serviceMode === "qsr" ? "Quick service · " : o.serviceMode === "tsr" ? "Table service · " : ""}{frName(o.franchiseId) ?? "No franchise"}{o.hours ? ` · ${o.hours}` : ""}{s ? ` · ${s.orders} order${s.orders === 1 ? "" : "s"}` : ""}</small></span>
              <span className="rp-amt">{s ? formatMoney(s.netToAccountForCents) : "—"}</span><span className="rp-chev">›</span>
            </button>
          );
        })}
        {brandWide && <button className="secondary sm" style={{ marginTop: 8 }} onClick={() => { setEditing({ id: "", name: "", franchiseId: null, address: null, phone: null, hours: null, active: true, serviceMode: "qsr" }); setIsNew(true); }}>Add outlet</button>}
      </div>

      {editing && (
        <div className="rp-card">
          <h3>{isNew ? "New outlet" : editing.name}</h3>
          {isNew && <label className="cust"><span>Short code</span><input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value.trim() })} placeholder="e.g. AMK-01" /></label>}
          <label className="cust"><span>Name</span><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <label className="cust"><span>Address</span><input value={editing.address ?? ""} onChange={(e) => setEditing({ ...editing, address: e.target.value })} /></label>
          <label className="cust"><span>Phone</span><input value={editing.phone ?? ""} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} inputMode="tel" /></label>
          <label className="cust"><span>Opening hours</span><input value={editing.hours ?? ""} onChange={(e) => setEditing({ ...editing, hours: e.target.value })} placeholder="e.g. Daily 8am-9pm" /></label>
          <label className="cust"><span>Service mode</span>
            <select value={editing.serviceMode ?? ""} onChange={(e) => setEditing({ ...editing, serviceMode: (e.target.value || null) as Outlet["serviceMode"] })}>
              <option value="">Not chosen (follows the server's table list)</option>
              <option value="qsr">{MODE.qsr}</option>
              <option value="tsr">{MODE.tsr}</option>
            </select>
          </label>
          <p className="muted">Quick service: customers order with no table, and Dine in and Take away are both offered. Table service: Dine in only, and a table is required.</p>
          {brandWide && (
            <label className="cust"><span>Franchise</span>
              <select value={editing.franchiseId ?? ""} onChange={(e) => setEditing({ ...editing, franchiseId: e.target.value || null })}>
                <option value="">None (the brand runs it)</option>
                {info.franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          )}
          {brandWide && !isNew && <label className="inline"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Outlet is open for business</label>}
          <p className="muted">Customers see the address, phone and hours under Help &amp; support.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" disabled={!editing.name.trim() || (isNew && !editing.id)} onClick={async () => {
              const body = brandWide ? { name: editing.name, address: editing.address, phone: editing.phone, hours: editing.hours, franchiseId: editing.franchiseId, active: editing.active, serviceMode: editing.serviceMode } : { name: editing.name, address: editing.address, phone: editing.phone, hours: editing.hours, serviceMode: editing.serviceMode };
              if (await save(`/api/outlets/${encodeURIComponent(editing.id)}`, body, "Saved.")) setEditing(null);
            }}>Save</button>
            <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {brandWide && opts && (
        <div className="rp-card">
          <h3>Charges</h3>
          <p className="muted">Off by default. Most quick-service shops have neither; turn them on only if you charge them.</p>
          <label className="inline"><input type="checkbox" checked={opts.serviceChargeOn} onChange={(e) => void setOption({ serviceChargeOn: e.target.checked })} /> Service charge ({Math.round(opts.serviceRate * 1000) / 10}%, dine-in only)</label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={opts.gstOn} onChange={(e) => void setOption({ gstOn: e.target.checked })} /> Tax (GST {Math.round(opts.gstRate * 1000) / 10}%)</label>
        </div>
      )}

      {brandWide && (
        <div className="rp-card">
          <h3>Franchises ({info.franchises.length})</h3>
          {info.franchises.map((f) => <p key={f.id} style={{ margin: "4px 0" }}><b>{f.name}</b> <small className="muted">· {info.outlets.filter((o) => o.franchiseId === f.id).length} outlet(s)</small></p>)}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <input placeholder="Short code" value={fr.id} onChange={(e) => setFr({ ...fr, id: e.target.value.trim() })} style={{ width: 110 }} />
            <input placeholder="Franchise name" value={fr.name} onChange={(e) => setFr({ ...fr, name: e.target.value })} />
            <button className="secondary sm" disabled={!fr.id || !fr.name.trim()} onClick={async () => { if (await save(`/api/franchises/${encodeURIComponent(fr.id)}`, { name: fr.name }, "Franchise saved.")) setFr({ id: "", name: "" }); }}>Add franchise</button>
          </div>
        </div>
      )}
    </div>
  );
}
