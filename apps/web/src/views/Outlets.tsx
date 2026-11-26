import { useCallback, useEffect, useState } from "react";
import { DEFAULT_COUNTRY, TAX_PACKS, formatMoney } from "@pos/core";
import { staffFetch } from "../auth";

interface Franchise { id: string; name: string; active: boolean }
interface Outlet { id: string; name: string; franchiseId: string | null; address: string | null; phone: string | null; hours: string | null; active: boolean; serviceMode: "qsr" | "tsr" | "retail" | null; prepMinutes?: number | null; latitude?: number | null; longitude?: number | null; country?: string; gstRegNo?: string | null; uen?: string | null; gstOn?: boolean | null; receiptFooter?: string | null; customerService?: string | null; tenderRounding?: Record<string, number>; taxRemovable?: boolean }
interface Summary { orders: number; netCents: number; netToAccountForCents: number; discountsCents: number; voided: { orders: number } }
interface Row { outletId: string; name: string; franchiseId: string | null; summary: Summary }
interface Info { brand: { id: string; name: string }; scope: { franchiseId: string | null; outletId: string | null; brandWide: boolean }; franchises: Franchise[]; outlets: Outlet[] }

const TZ = "Asia/Singapore";
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
const MODE = { qsr: "Quick service (no table)", tsr: "Table service (a table is required)", retail: "Retail (sells by scanning; no tables or kitchen)" } as const;
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
  const [opts, setOpts] = useState<{ serviceChargeOn: boolean; gstOn: boolean; stackable: boolean; pointsItemsEligibleOnly: boolean; pointsDeductService: boolean; pointsDeductTax: boolean; pointsDeductDeposit: boolean; serviceRate: number; gstRate: number; taxName?: string } | null>(null);
  const [kiosk, setKiosk] = useState<{ idleMinutes: number; signinBlock: boolean; chips: { earn: boolean; rate: boolean; stamps: boolean } } | null>(null);

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
  useEffect(() => {
    void (async () => {
      const r = await staffFetch("/api/settings/kiosk");
      if ("res" in r && r.res.ok) setKiosk((await r.res.json()) as NonNullable<typeof kiosk>);
    })();
  }, []);
  async function setKioskOption(body: object) {
    const r = await staffFetch("/api/settings/kiosk", { method: "PUT", body });
    if ("res" in r && r.res.ok) { setKiosk((await r.res.json()) as NonNullable<typeof kiosk>); say("Saved. A kiosk picks it up when its screen is next reloaded."); } else say("Could not save.");
  }
  async function setRate(pct: number) {
    const r = await staffFetch("/api/settings", { method: "PUT", body: { serviceRatePct: pct } });
    if ("res" in r && r.res.ok) { setOpts((await r.res.json()) as NonNullable<typeof opts>); say("Saved. Orders opened from now on use the new rate."); } else say("The rate is a percentage from 0 to 30, with at most one decimal place.");
  }
  async function setOption(body: Partial<Record<"serviceChargeOn" | "gstOn" | "stackable" | "pointsItemsEligibleOnly" | "pointsDeductService" | "pointsDeductTax" | "pointsDeductDeposit", boolean>>) {
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
              <span className="rp-main"><b>{o.name}{!o.active ? " (off)" : ""}</b><small>{o.serviceMode === "qsr" ? "Quick service · " : o.serviceMode === "tsr" ? "Table service · " : o.serviceMode === "retail" ? "Retail · " : ""}{frName(o.franchiseId) ?? "No franchise"}{o.hours ? ` · ${o.hours}` : ""}{s ? ` · ${s.orders} order${s.orders === 1 ? "" : "s"}` : ""}</small></span>
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
          {brandWide && (
            <>
              <label className="cust"><span>Country</span>
                <select value={editing.country ?? DEFAULT_COUNTRY} onChange={(e) => setEditing({ ...editing, country: e.target.value })}>
                  {Object.values(TAX_PACKS).map((p) => <option key={p.country} value={p.country}>{p.countryName} · {p.taxName} {Math.round(p.rate * 1000) / 10}%</option>)}
                </select>
              </label>
              <p className="muted">Tax follows the country the outlet is in. The rate cannot be changed here.</p>
              <label className="cust"><span>GST registration no.</span><input value={editing.gstRegNo ?? ""} maxLength={24} onChange={(e) => setEditing({ ...editing, gstRegNo: e.target.value })} placeholder="Leave empty if not GST registered" /></label>
              <label className="cust"><span>Business no. (UEN)</span><input value={editing.uen ?? ""} maxLength={24} onChange={(e) => setEditing({ ...editing, uen: e.target.value })} /></label>
              <p className="muted">With a GST registration number, this outlet's receipts print as a TAX Invoice with both numbers.</p>
              <label className="cust"><span>Charges tax</span>
                <select value={editing.gstOn == null ? "" : editing.gstOn ? "yes" : "no"} onChange={(e) => setEditing({ ...editing, gstOn: e.target.value === "" ? null : e.target.value === "yes" })}>
                  <option value="">Follows the brand's setting ({opts?.gstOn ? "on" : "off"})</option>
                  <option value="yes">Yes, this outlet charges tax</option>
                  <option value="no">No, this outlet charges no tax</option>
                </select>
              </label>
              <p className="muted">Applies to orders opened from now on. Orders already open keep what they were opened with.</p>
              <label className="cust"><span>Cash rounding</span>
                <select aria-label="Cash rounding" value={String(editing.tenderRounding?.cash ?? 0)} onChange={(e) => { const n = Number(e.target.value); const next = { ...(editing.tenderRounding ?? {}) }; if (n) next.cash = n; else delete next.cash; setEditing({ ...editing, tenderRounding: next }); }}>
                  <option value="0">No rounding</option>
                  {(TAX_PACKS[editing.country ?? DEFAULT_COUNTRY]?.roundingSteps ?? []).map((s) => <option key={s} value={s}>To the nearest {s} cents</option>)}
                </select>
              </label>
              <p className="muted">Only cash payments are rounded; cards and PayNow are charged to the cent. The difference shows as "Rounding" on the till and the receipt.</p>
              <label className="inline"><input type="checkbox" aria-label="Staff may take tax off an order" checked={!!editing.taxRemovable} onChange={(e) => setEditing({ ...editing, taxRemovable: e.target.checked })} /> Staff may take tax off an order (a manager, with a reason; it is recorded)</label>
            </>
          )}
          <label className="cust"><span>Receipt closing lines</span><textarea aria-label="Receipt closing lines" rows={3} value={editing.receiptFooter ?? ""} placeholder={"Thank you\nFollow us @yourshop"} onChange={(e) => setEditing({ ...editing, receiptFooter: e.target.value })} /></label>
          <p className="muted">Printed at the foot of this outlet's receipts: up to four lines of 42 letters. Leave empty for "Thank you".</p>
          <label className="cust"><span>Customer service line</span><input aria-label="Customer service line" maxLength={60} value={editing.customerService ?? ""} placeholder="e.g. 6123 4567 or help@yourshop.sg" onChange={(e) => setEditing({ ...editing, customerService: e.target.value })} /></label>
          <label className="cust"><span>Service mode</span>
            <select value={editing.serviceMode ?? ""} onChange={(e) => setEditing({ ...editing, serviceMode: (e.target.value || null) as Outlet["serviceMode"] })}>
              <option value="">Not chosen (follows the server's table list)</option>
              <option value="qsr">{MODE.qsr}</option>
              <option value="tsr">{MODE.tsr}</option>
              <option value="retail">{MODE.retail}</option>
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
          <div className="row">
            <label className="cust"><span>Latitude</span><input value={editing.latitude ?? ""} inputMode="decimal" placeholder="e.g. 1.2965" onChange={(e) => setEditing({ ...editing, latitude: e.target.value === "" ? null : Number(e.target.value) })} /></label>
            <label className="cust"><span>Longitude</span><input value={editing.longitude ?? ""} inputMode="decimal" placeholder="e.g. 103.8764" onChange={(e) => setEditing({ ...editing, longitude: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Both, or neither. With them, customers can sort outlets by distance. In Google Maps, right-click the shop and tap the numbers to copy them.</p>
          <label className="cust"><span>Minutes to prepare an order</span><input value={editing.prepMinutes ?? ""} onChange={(e) => setEditing({ ...editing, prepMinutes: e.target.value === "" ? null : Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))) })} inputMode="numeric" placeholder="e.g. 15" /></label>
          {!isNew && <SchedulingBox outletId={editing.id} />}
          {!isNew && editing.serviceMode === "tsr" && <TabSettingsBox outletId={editing.id} />}
          {brandWide && !isNew && <label className="inline"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Outlet is open for business</label>}
          <p className="muted">Customers see the address, phone and hours under Help &amp; support.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" disabled={!editing.name.trim() || (isNew && !editing.id)} onClick={async () => {
              const body = brandWide ? { name: editing.name, receiptFooter: editing.receiptFooter ?? null, customerService: editing.customerService ?? null, address: editing.address, phone: editing.phone, hours: editing.hours, franchiseId: editing.franchiseId, active: editing.active, country: editing.country ?? DEFAULT_COUNTRY, gstRegNo: editing.gstRegNo?.trim() || null, uen: editing.uen?.trim() || null, gstOn: editing.gstOn ?? null, tenderRounding: editing.tenderRounding ?? {}, taxRemovable: !!editing.taxRemovable, serviceMode: editing.serviceMode, prepMinutes: editing.prepMinutes ?? null, latitude: editing.latitude ?? null, longitude: editing.longitude ?? null } : { name: editing.name, receiptFooter: editing.receiptFooter ?? null, customerService: editing.customerService ?? null, address: editing.address, phone: editing.phone, hours: editing.hours, serviceMode: editing.serviceMode, prepMinutes: editing.prepMinutes ?? null, latitude: editing.latitude ?? null, longitude: editing.longitude ?? null };
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
          <label className="inline"><input type="checkbox" checked={opts.serviceChargeOn} onChange={(e) => void setOption({ serviceChargeOn: e.target.checked })} /> Service charge (dine-in only)</label>
          <label className="cust" style={{ marginTop: 6 }}><span>Service charge rate (%)</span><input aria-label="Service charge rate" inputMode="decimal" style={{ width: 90 }} defaultValue={String(Math.round(opts.serviceRate * 1000) / 10)} key={opts.serviceRate} onBlur={(e) => { const n = Number(e.target.value); if (e.target.value.trim() !== "" && n !== Math.round(opts.serviceRate * 1000) / 10) void setRate(n); }} /></label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={opts.gstOn} onChange={(e) => void setOption({ gstOn: e.target.checked })} /> Tax ({opts.taxName ?? "GST"} {Math.round(opts.gstRate * 1000) / 10}%, set by the outlet's country)</label>
          <p className="muted" style={{ margin: "10px 0 4px" }}>Promotions and points</p>
          <label className="inline"><input type="checkbox" checked={opts.stackable} onChange={(e) => void setOption({ stackable: e.target.checked })} /> A coupon and points can be used on the same order</label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={opts.pointsItemsEligibleOnly} onChange={(e) => void setOption({ pointsItemsEligibleOnly: e.target.checked })} /> Points pay only for items that earn points</label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={opts.pointsDeductService} onChange={(e) => void setOption({ pointsDeductService: e.target.checked })} /> Points can pay the service charge</label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={opts.pointsDeductTax} onChange={(e) => void setOption({ pointsDeductTax: e.target.checked })} /> Points can pay the tax</label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={opts.pointsDeductDeposit} onChange={(e) => void setOption({ pointsDeductDeposit: e.target.checked })} /> Points can pay the container deposit</label>
        </div>
      )}

      {brandWide && kiosk && (
        <div className="rp-card">
          <h3>Self-order kiosk</h3>
          <p className="muted">Applies to every kiosk. A single tablet can still override these from its own settings (double-tap the logo).</p>
          <label className="inline">Clears itself after{" "}
            <select value={kiosk.idleMinutes} onChange={(e) => void setKioskOption({ idleMinutes: Number(e.target.value) })}>
              {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n} minute{n > 1 ? "s" : ""} untouched</option>)}
            </select>
          </label>
          <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={kiosk.signinBlock} onChange={(e) => void setKioskOption({ signinBlock: e.target.checked })} /> Show the member sign-in block on the start screen</label>
          {kiosk.signinBlock && (
            <div style={{ marginLeft: 22 }}>
              <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={kiosk.chips.earn} onChange={(e) => void setKioskOption({ chips: { earn: e.target.checked } })} /> "Earn points on every order"</label>
              <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={kiosk.chips.rate} onChange={(e) => void setKioskOption({ chips: { rate: e.target.checked } })} /> "100 points = S$1 off"</label>
              <label className="inline" style={{ marginTop: 6 }}><input type="checkbox" checked={kiosk.chips.stamps} onChange={(e) => void setKioskOption({ chips: { stamps: e.target.checked } })} /> "Collect stamps &amp; rewards"</label>
            </div>
          )}
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

/** Whether this outlet takes orders for a chosen pickup time, how far apart the times are and how many days ahead. Saves as it changes. */
function SchedulingBox({ outletId }: { outletId: string }) {
  const [v, setV] = useState<{ on: boolean; intervalMinutes: number; daysAhead: number } | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    void (async () => {
      const r = await staffFetch(`/api/outlets/${encodeURIComponent(outletId)}/scheduling`);
      if ("res" in r && r.res.ok) setV((await r.res.json()) as NonNullable<typeof v>);
    })();
  }, [outletId]);
  async function change(body: object) {
    const r = await staffFetch(`/api/outlets/${encodeURIComponent(outletId)}/scheduling`, { method: "PUT", body });
    if ("res" in r && r.res.ok) { setV((await r.res.json()) as NonNullable<typeof v>); setSaved("Saved."); } else setSaved("Could not save.");
  }
  if (!v) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <label className="inline"><input type="checkbox" checked={v.on} onChange={(e) => void change({ on: e.target.checked })} /> Take orders for a chosen pickup time</label>
      {v.on && (
        <>
          <label className="cust"><span>Pickup times are every</span>
            <select value={v.intervalMinutes} onChange={(e) => void change({ intervalMinutes: Number(e.target.value) })}>
              {[5, 10, 15, 20, 30, 60].map((n) => <option key={n} value={n}>{n} minutes</option>)}
            </select>
          </label>
          <label className="cust"><span>Days ahead a customer can book</span><input value={v.daysAhead} inputMode="numeric" onChange={(e) => setV({ ...v, daysAhead: Number(e.target.value) || 0 })} onBlur={() => void change({ daysAhead: Math.max(0, Math.min(30, v.daysAhead)) })} /></label>
          <p className="muted">Pickup times follow the menu's ordering hours and the minutes to prepare above. An order waits and goes to the kitchen that many minutes before its time.</p>
        </>
      )}
      {saved && <p className="muted">{saved}</p>}
    </div>
  );
}

/** Table service with a shared tab: a table's orders join one bill, paid after the waiter releases payment. Off until switched on here. */
function TabSettingsBox({ outletId }: { outletId: string }) {
  const [v, setV] = useState<{ tabService: boolean; allocation: "oldest_first" | "reduce_only" } | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    void (async () => {
      const r = await staffFetch(`/api/outlets/${encodeURIComponent(outletId)}/tab-settings`);
      if ("res" in r && r.res.ok) setV((await r.res.json()) as NonNullable<typeof v>);
    })();
  }, [outletId]);
  async function change(body: object) {
    const r = await staffFetch(`/api/outlets/${encodeURIComponent(outletId)}/tab-settings`, { method: "PUT", body });
    if ("res" in r && r.res.ok) { setV((await r.res.json()) as NonNullable<typeof v>); setSaved("Saved."); } else setSaved("Could not save.");
  }
  if (!v) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <label className="inline"><input type="checkbox" checked={v.tabService} onChange={(e) => void change({ tabService: e.target.checked })} /> Table service uses a shared tab (customers pay after the waiter releases payment)</label>
      {v.tabService && (
        <label className="cust"><span>A custom amount paid on a tab</span>
          <select value={v.allocation} onChange={(e) => void change({ allocation: e.target.value })}>
            <option value="oldest_first">Marks items paid, oldest round first</option>
            <option value="reduce_only">Only reduces what remains</option>
          </select>
        </label>
      )}
      {saved && <p className="muted">{saved}</p>}
    </div>
  );
}
