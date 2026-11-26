import { useEffect, useMemo, useState } from "react";
import type { Catalog } from "@pos/core";
import { deviceRole, setDeviceRole } from "../device";
import { go } from "../nav";
import { hasPerm, staffFetch, useStaff } from "../auth";
import { TEXT_SCALE, setPref, usePrefs } from "../prefs";
import { ACTION_POOL, TENDER_POOL, actionsPref, tendersPref, arrangeAll, isHidden, loadTillSettings, saveTill, useTillSettings, type ArrangePref, type CustomAction, type CustomTender, type KitchenStation, type TillSettings } from "../till/tillSettings";
import { appVersion, checkForUpdate, useUpdatePending } from "../pwaUpdate";
import { FloorPanel } from "./FloorPanel";
import { ShiftsPanel } from "./ShiftsPanel";
import { TrainingPanel } from "./TrainingPanel";
import { DiscountPolicyPanel } from "./DiscountPolicyPanel";
import { PaynowPanel } from "./PaynowPanel";
import { isTraining } from "../training";
import { getDeviceCode, setDeviceCode } from "../db";
import { setLayout } from "../prefs";
import { READY_LOOKS, lookOf } from "../looks";

type Section = "station" | "selling" | "menu" | "training" | "about";

/** A list of things to show or hide and put in order, with a switch and up/down on each. */
/** Your own sign-in phone number. It needs your PIN, because it opens your account. */
function PhoneSignIn() {
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  async function save(next: string | null) {
    setNote("");
    const r = await staffFetch("/api/auth/phone", { method: "PUT", body: { phone: next, pin } });
    setPin("");
    if (!("res" in r)) return setNote(r.problem);
    const j = await r.res.json().catch(() => ({})) as { phone?: string | null; message?: string; error?: string };
    if (r.res.ok) { setNote(j.phone ? `Saved. You can now sign in with ${j.phone} and your PIN.` : "Removed. Phone sign-in is off for you."); setPhone(""); }
    else setNote(r.res.status === 401 ? "That PIN is not right." : r.res.status === 409 ? "That number is already used by someone else." : j.message ?? "That is not saved. Check the number and your PIN.");
  }
  return (
    <>
      <h3>Phone sign-in</h3>
      <p className="muted">Sign in with your phone number and PIN instead of a staff code. Use the country code, like +65 8111 1111.</p>
      <div className="row">
        <label className="field">Phone number<input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+65 8111 1111" /></label>
        <label className="field">Your PIN<input type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} /></label>
        <button className="primary sm" disabled={!phone || pin.length < 4} onClick={() => void save(phone)}>Save number</button>
        <button className="secondary sm" disabled={pin.length < 4} onClick={() => void save(null)}>Remove my number</button>
      </div>
      {note && <p role="status" className="muted">{note}</p>}
    </>
  );
}

function Arrange({ title, help, pool, pref, onChange }: { title: string; help: string; pool: Array<{ id: string; label: string; note?: string; optional?: boolean }>; pref: ArrangePref; onChange: (p: ArrangePref) => void }) {
  const rows = arrangeAll(pool, pref);
  const move = (i: number, d: number) => { const ids = rows.map((r) => r.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; onChange({ ...pref, order: ids }); };
  // An optional item (a tender most shops do not use) is off until switched on; the rest are on until hidden.
  const toggle = (r: { id: string; optional?: boolean }) => {
    const order = rows.map((x) => x.id), shown = pref.shown ?? [];
    if (r.optional) onChange({ ...pref, order, hidden: pref.hidden.filter((x) => x !== r.id), shown: isHidden(r, pref) ? [...shown.filter((x) => x !== r.id), r.id] : shown.filter((x) => x !== r.id) });
    else onChange({ ...pref, order, hidden: pref.hidden.includes(r.id) ? pref.hidden.filter((x) => x !== r.id) : [...pref.hidden, r.id] });
  };
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>{title}</h3>
      <p className="muted">{help}</p>
      {rows.map((r, i) => (
        <div className="arr-row" key={r.id}>
          <label><input type="checkbox" aria-label={`Show ${r.label}`} checked={!isHidden(r, pref)} onChange={() => toggle(r)} /> {r.label}{r.note ? <span className="muted"> · {r.note}</span> : null}</label>
          <button className="secondary sm" aria-label={`Move ${r.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
          <button className="secondary sm" aria-label={`Move ${r.label} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</button>
        </div>
      ))}
    </section>
  );
}

/**
 * Settings as a full screen with a rail (Q18): Station (this person's own choices), Selling (what the shop's till shows and how it behaves),
 * Menu & prices, Training and About. Sections that change the shop's setup are for managers.
 */
/**
 * What cashiers and managers may do without a manager (handout 4.10: per-permission gates). The owner ticks; the server enforces it.
 * A change reaches a person the next time they sign in.
 */
function PermissionsCard() {
  type View = { roles: { cashier: string[]; manager: string[] }; options: Array<{ id: string; label: string; help: string; roles: Array<"cashier" | "manager"> }> };
  const [v, setV] = useState<View | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { void staffFetch("/api/settings/permissions").then(async (r) => { if ("res" in r && r.res.ok) setV((await r.res.json()) as View); }); }, []);
  if (!v) return null;
  const toggle = async (role: "cashier" | "manager", id: string) => {
    const next = v.roles[role].includes(id) ? v.roles[role].filter((x) => x !== id) : [...v.roles[role], id];
    const r = await staffFetch("/api/settings/permissions", { method: "PUT", body: { [role]: next } });
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg(r.res.status === 403 ? "Only the brand owner can change what staff may do." : "That was not saved.");
    setV((await r.res.json()) as View);
    setMsg("Saved. It applies the next time that person signs in.");
  };
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>What staff may do</h3>
      <p className="muted">Tick what a cashier or a manager may do on their own. Where a box is empty, the till asks for the code and PIN of someone who may. The owner may always do everything.</p>
      {msg && <p className="flash" role="status">{msg}</p>}
      <table className="perm-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={{ textAlign: "left" }}>Permission</th><th>Cashier</th><th>Manager</th></tr></thead>
        <tbody>
          {v.options.map((o) => (
            <tr key={o.id} style={{ borderTop: "1px solid var(--line)" }}>
              <td style={{ padding: "8px 0" }}>{o.label}{o.help ? <div className="muted" style={{ fontSize: ".85em" }}>{o.help}</div> : null}</td>
              {(["cashier", "manager"] as const).map((role) => <td key={role} style={{ textAlign: "center" }}>{o.roles.includes(role) ? <input type="checkbox" aria-label={`${role === "cashier" ? "Cashier" : "Manager"}: ${o.label}`} checked={v.roles[role].includes(o.id)} onChange={() => void toggle(role, o.id)} /> : <span className="muted" title="Not offered for this role">—</span>}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <OnePerson options={v.options} roles={v.roles} />
    </section>
  );
}

/** One person who differs from their role: for each permission, follow the role, always allow, or never allow. */
function OnePerson({ options, roles }: { options: Array<{ id: string; label: string }>; roles: { cashier: string[]; manager: string[] } }) {
  type Person = { id: string; name: string; role: string; active: boolean; allow: string[]; deny: string[] };
  const [people, setPeople] = useState<Person[]>([]);
  const [id, setId] = useState("");
  const [msg, setMsg] = useState("");
  const load = async () => { const r = await staffFetch("/api/staff"); if ("res" in r && r.res.ok) setPeople(((await r.res.json()) as { staff: Person[] }).staff.filter((p) => p.active && (p.role === "cashier" || p.role === "manager"))); };
  useEffect(() => { void load(); }, []);
  const who = people.find((p) => p.id === id);
  const set = async (perm: string, how: "role" | "allow" | "deny") => {
    if (!who) return;
    const allow = who.allow.filter((x) => x !== perm), deny = who.deny.filter((x) => x !== perm);
    if (how === "allow") allow.push(perm);
    if (how === "deny") deny.push(perm);
    const r = await staffFetch(`/api/staff/${who.id}/permissions`, { method: "PUT", body: { allow, deny } });
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg(r.res.status === 403 ? "Only the owner can change what a person may do." : "That was not saved.");
    setMsg(`Saved for ${who.name}. It applies the next time they sign in.`);
    void load();
  };
  const changed = (p: Person) => p.allow.length + p.deny.length;
  return (
    <div style={{ marginTop: 18 }}>
      <h3>One person different from their role</h3>
      <p className="muted">For a senior cashier who may refund, or a new manager who may not yet change prices. Everything not set here follows the person's role above.</p>
      <label className="field">Person
        <select aria-label="Person" value={id} onChange={(e) => { setId(e.target.value); setMsg(""); }}>
          <option value="">Choose a person…</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.role}{changed(p) ? ` · ${changed(p)} of their own` : ""}</option>)}
        </select>
      </label>
      {msg && <p className="flash" role="status">{msg}</p>}
      {who && options.map((o) => {
        const how = who.deny.includes(o.id) ? "deny" : who.allow.includes(o.id) ? "allow" : "role";
        const byRole = (roles[who.role as "cashier" | "manager"] ?? []).includes(o.id);
        return (
          <div className="arr-row" key={o.id}>
            <label style={{ flex: 1 }}>{o.label}</label>
            <select aria-label={`${who.name}: ${o.label}`} value={how} onChange={(e) => void set(o.id, e.target.value as "role" | "allow" | "deny")}>
              <option value="role">As their role ({byRole ? "yes" : "no"})</option>
              <option value="allow">Always yes</option>
              <option value="deny">Always no</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}

/** The shop's own ways to pay: a delivery platform, a gift certificate, a house account. Each is recorded under its name, like Card. */
function CustomTendersEditor({ tenders, onSave }: { tenders: CustomTender[]; onSave: (t: CustomTender[]) => void }) {
  const [name, setName] = useState("");
  const taken = tenders.some((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>Your own payment types</h3>
      <p className="muted">For money that reaches you another way: a delivery platform (GrabFood, foodpanda), a gift certificate, a house account. The till records the payment under this name and does not charge anything. Each one appears under Payment options below, where it can be hidden or moved.</p>
      {tenders.map((t) => <div className="arr-row" key={t.id}><label style={{ flex: 1 }}>{t.name}</label><button className="secondary sm" aria-label={`Remove payment type ${t.name}`} onClick={() => onSave(tenders.filter((x) => x.id !== t.id))}>Remove</button></div>)}
      {tenders.length < 12 && (
        <div className="row" style={{ marginTop: 8 }}>
          <input aria-label="New payment type name" placeholder="e.g. GrabFood" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="secondary sm" disabled={!name.trim() || taken} onClick={() => { onSave([...tenders, { id: `ct-${Date.now().toString(36)}`, name: name.trim() }]); setName(""); }}>Add payment type</button>
        </div>
      )}
      <p className="muted">Removing one does not change past sales: each payment keeps the name it was taken under.</p>
    </section>
  );
}

/** The shop's own buttons (handout 4.11): a name, a colour, an icon and a web address, shown on the action strip, the dashboard, or both. */
function CustomActionsEditor({ actions, onSave }: { actions: CustomAction[]; onSave: (a: CustomAction[]) => void }) {
  const blank = { label: "", icon: "↗", color: "#1b9bd8", url: "https://", where: "dashboard" as CustomAction["where"] };
  const [d, setD] = useState(blank);
  const okUrl = /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(d.url.trim());
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>Your own buttons</h3>
      <p className="muted">A button that opens a web page in a new tab: a supplier's ordering page, a delivery platform's merchant screen, a staff handbook. Only web addresses can be opened.</p>
      {actions.map((a) => (
        <div className="arr-row" key={a.id}>
          <label style={{ flex: 1 }}><span style={{ color: a.color, fontWeight: 700 }}>{a.icon}</span> {a.label} <span className="muted">· {a.where === "both" ? "Strip and dashboard" : a.where === "strip" ? "Action strip" : "Dashboard"} · {a.url.replace(/^https?:\/\//, "").slice(0, 40)}</span></label>
          <button className="secondary sm" aria-label={`Remove button ${a.label}`} onClick={() => onSave(actions.filter((x) => x.id !== a.id))}>Remove</button>
        </div>
      ))}
      {actions.length < 12 && (
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <input aria-label="Button name" placeholder="Name" maxLength={24} value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} />
          <input aria-label="Button icon" placeholder="Icon" maxLength={2} style={{ width: 60 }} value={d.icon} onChange={(e) => setD({ ...d, icon: e.target.value })} />
          <input aria-label="Button colour" type="color" value={d.color} onChange={(e) => setD({ ...d, color: e.target.value })} />
          <input aria-label="Button web address" placeholder="https://..." style={{ flex: 1, minWidth: 200 }} maxLength={500} value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} />
          <select aria-label="Where the button shows" value={d.where} onChange={(e) => setD({ ...d, where: e.target.value as CustomAction["where"] })}><option value="dashboard">Dashboard</option><option value="strip">Action strip</option><option value="both">Both</option></select>
          <button className="secondary sm" disabled={!d.label.trim() || !okUrl} onClick={() => { onSave([...actions, { id: `ca-${Date.now().toString(36)}`, label: d.label.trim(), icon: d.icon.trim() || "↗", color: d.color, url: d.url.trim(), where: d.where }]); setD(blank); }}>Add button</button>
        </div>
      )}
    </section>
  );
}

/** Link the signed-in person's own Telegram, so they can sign in at any till by scanning its QR (which also clocks them in). */
function TelegramLink() {
  const [code, setCode] = useState<{ code: string; bot: string | null; minutes: number } | null>(null);
  const [msg, setMsg] = useState("");
  const make = async () => {
    setMsg("");
    const r = await staffFetch("/api/telegram/link-code", { method: "POST" });
    if (!("res" in r)) return setMsg(r.problem);
    if (r.res.status === 404) return setMsg("Telegram is not set up for this shop yet.");
    if (!r.res.ok) return setMsg("A code could not be made just now.");
    setCode((await r.res.json()) as { code: string; bot: string | null; minutes: number });
  };
  return (
    <>
      <h3>Sign in with Telegram</h3>
      <p className="muted">Link your Telegram once. After that, scan the QR on any till's sign-in screen to sign in and clock in, with no PIN.</p>
      <div className="row"><button className="secondary sm" onClick={() => void make()}>Link my Telegram</button></div>
      {code && <p role="status">Open Telegram, find {code.bot ? <b>@{code.bot}</b> : "the shop's bot"} and send it: <b>/link {code.code}</b><span className="muted"> · works once, for {code.minutes} minutes</span></p>}
      {msg && <p className="muted" role="alert">{msg}</p>}
    </>
  );
}

/** How long member credit lasts, how long it can be brought back, and the smallest top-up (the owner's rules of 25 Nov 2026, as settings). */
/** Google and Microsoft sign-in for customers of the online shop and kiosk: one switch each, off until the owner turns it on. */
function SigninCard() {
  const [v, setV] = useState<{ google: boolean; microsoft: boolean; ready: { google: boolean; microsoft: boolean } } | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { void staffFetch("/api/settings/signin").then(async (x) => { if ("res" in x && x.res.ok) setV(await x.res.json()); }); }, []);
  if (!v) return null;
  const set = async (k: "google" | "microsoft", on: boolean) => {
    const x = await staffFetch("/api/settings/signin", { method: "PUT", body: { [k]: on } });
    if ("res" in x && x.res.ok) { setV(await x.res.json()); setMsg("Saved."); } else setMsg("res" in x && x.res.status === 403 ? "Only the brand owner can change sign-in." : "Could not save. Try again.");
  };
  const row = (k: "google" | "microsoft", name: string) => (
    <label className="row" style={{ gap: 8, alignItems: "center" }}>
      <input type="checkbox" aria-label={`${name} sign-in`} checked={v[k]} onChange={(e) => void set(k, e.target.checked)} />
      <span>{name}{v[k] && !v.ready[k] ? <span className="muted"> · switched on, but not showing yet: this server has no {name} app registration</span> : !v.ready[k] ? <span className="muted"> · needs a {name} app registration on the server first</span> : null}</span>
    </label>
  );
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>Customer sign-in</h3>
      <p className="muted">Customers sign in with their phone number. These add a "Continue with" button to the online shop. Both are off unless switched on here.</p>
      {msg && <p className="flash" role="status">{msg}</p>}
      {row("google", "Google")}
      {row("microsoft", "Microsoft")}
    </section>
  );
}
function CreditRulesCard() {
  const [r, setR] = useState<{ validityDays: string; reinstateDays: string; min: string } | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { void staffFetch("/api/settings/credit").then(async (x) => { if ("res" in x && x.res.ok) { const j = (await x.res.json()) as { validityDays: number; reinstateDays: number; minTopupCents: number }; setR({ validityDays: String(j.validityDays), reinstateDays: String(j.reinstateDays), min: (j.minTopupCents / 100).toFixed(2) }); } }); }, []);
  if (!r) return null;
  const save = async () => {
    const x = await staffFetch("/api/settings/credit", { method: "PUT", body: { validityDays: Math.round(Number(r.validityDays)), reinstateDays: Math.round(Number(r.reinstateDays)), minTopupCents: Math.round(Number(r.min) * 100) } });
    setMsg("res" in x && x.res.ok ? "Saved." : "res" in x && x.res.status === 403 ? "Only the brand owner can change the credit rules." : "Check the numbers: days are whole numbers, and the top-up is an amount.");
  };
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>Member credit</h3>
      <p className="muted">Credit is valid for a time counted from the member's last top-up. After that it cannot be spent, but a top-up within the reinstatement time brings the whole balance back. Past that, it is written off at their next top-up.</p>
      {msg && <p className="flash" role="status">{msg}</p>}
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
        <label className="field">Valid for (days after the last top-up; 0 = never expires)<input aria-label="Credit valid for days" inputMode="numeric" value={r.validityDays} onChange={(e) => setR({ ...r, validityDays: e.target.value.replace(/\D/g, "") })} /></label>
        <label className="field">Can be brought back for (days after expiry)<input aria-label="Credit reinstatement days" inputMode="numeric" value={r.reinstateDays} onChange={(e) => setR({ ...r, reinstateDays: e.target.value.replace(/\D/g, "") })} /></label>
        <label className="field">Smallest top-up (S$)<input aria-label="Smallest top-up" inputMode="decimal" value={r.min} onChange={(e) => setR({ ...r, min: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      </div>
      <div className="row"><button className="primary sm" onClick={() => void save()}>Save</button></div>
    </section>
  );
}

/** Kitchen stations: a name and the menu categories it makes. The kitchen display can then show one station's work. */
function StationsEditor({ stations, categories, onSave }: { stations: KitchenStation[]; categories: string[]; onSave: (s: KitchenStation[]) => void }) {
  const [name, setName] = useState("");
  const takenBy = (c: string, except: string) => stations.find((s) => s.id !== except && s.categories.includes(c))?.name;
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>Kitchen stations</h3>
      <p className="muted">Where each kind of item is made (hot kitchen, bar, pass). On the kitchen display, a station sees only its own items. With no stations, the display shows everything on one screen.</p>
      {stations.map((s) => (
        <div key={s.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
          <div className="row"><strong style={{ flex: 1 }}>{s.name}</strong><button className="secondary sm" aria-label={`Remove station ${s.name}`} onClick={() => onSave(stations.filter((x) => x.id !== s.id))}>Remove</button></div>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            {categories.map((c) => { const other = takenBy(c, s.id); return (
              <label key={c} title={other ? `Made at ${other}` : undefined}><input type="checkbox" aria-label={`${s.name} makes ${c}`} checked={s.categories.includes(c)} disabled={!!other} onChange={(e) => onSave(stations.map((x) => (x.id === s.id ? { ...x, categories: e.target.checked ? [...x.categories, c] : x.categories.filter((y) => y !== c) } : x)))} /> {c}{other ? <span className="muted"> ({other})</span> : null}</label>
            ); })}
          </div>
        </div>
      ))}
      {stations.length < 8 && (
        <div className="row" style={{ marginTop: 8 }}>
          <input aria-label="New station name" placeholder="e.g. Bar" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="secondary sm" disabled={!name.trim() || stations.some((s) => s.name.toLowerCase() === name.trim().toLowerCase())} onClick={() => { onSave([...stations, { id: `st-${Date.now().toString(36)}`, name: name.trim(), categories: [] }]); setName(""); }}>Add station</button>
        </div>
      )}
    </section>
  );
}

export function Settings({ catalog }: { catalog?: Catalog | null } = {}) {
  const staff = useStaff();
  const prefs = usePrefs();
  const till = useTillSettings();
  const updateReady = useUpdatePending();
  const [section, setSection] = useState<Section>("station");
  const [msg, setMsg] = useState("");
  const [checking, setChecking] = useState(false);
  const [letter, setLetter] = useState(getDeviceCode());
  const [role, setRole] = useState(deviceRole());
  /** Whether the action and payment lists being edited are the shop's or this till's own. */
  const [scope, setScope] = useState<"shop" | "till">("shop");
  const categories = useMemo(() => [...new Set((catalog?.products ?? []).map((p) => p.category))].sort(), [catalog]);
  useEffect(() => { void loadTillSettings(); }, [staff?.code]);
  if (!staff) return <div className="credit"><h2>Settings</h2><p className="muted">Sign in to change settings. <a href="/login">Sign in</a></p></div>;
  const manager = staff.role !== "cashier";
  // Each section opens for whoever the shop allows to do what it holds (the owner's choices under "What staff may do").
  const maySell = hasPerm(staff, "device.manage"), mayMenu = hasPerm(staff, "catalog.manage");
  const save = async (patch: Partial<TillSettings>) => { const e = await saveTill(patch); setMsg(e ?? "Saved."); };
  const sections: Array<[Section, string, boolean]> = [["station", "Station", true], ["selling", "Selling", maySell], ["menu", "Menu & prices", mayMenu], ["training", "Training", manager], ["about", "About", true]];

  return (
    <div className="settings">
      <nav className="settings-rail" aria-label="Settings sections">
        {sections.filter(([, , ok]) => ok).map(([k, l]) => <button key={k} className={section === k ? "on" : ""} aria-current={section === k ? "page" : undefined} onClick={() => { setSection(k); setMsg(""); }}>{l}</button>)}
      </nav>
      <div className="settings-body">
        {msg && <div className="flash" role="status">{msg}</div>}
        {section === "station" && (
          <>
            <h2>Station</h2>
            <p className="muted">Your own choices. They follow you to any till.</p>
            <h3>Text size</h3>
            <div className="row">{(["compact", "standard", "large", "xl"] as const).map((k) => <button key={k} className={prefs.textSize === k ? "primary sm" : "secondary sm"} aria-pressed={prefs.textSize === k} onClick={() => void setPref("textSize", k)}>{k === "xl" ? "Extra large" : k[0]!.toUpperCase() + k.slice(1)} · {Math.round(TEXT_SCALE[k] * 100)}%</button>)}</div>
            <h3>Menu panel</h3>
            <div className="row">{(["left", "right"] as const).map((s) => <button key={s} className={prefs.menuSide === s ? "primary sm" : "secondary sm"} aria-pressed={prefs.menuSide === s} onClick={() => void setPref("menuSide", s)}>{s === "left" ? "Left" : "Right"}</button>)}</div>
            {READY_LOOKS.length > 1 && (
              <>
                <h3>Look</h3>
                <p className="muted">The interface style you work in. It changes your screens only.</p>
                <div className="row">{READY_LOOKS.map((l) => <button key={l.id} className={lookOf(prefs.look) === l.id ? "primary sm" : "secondary sm"} aria-pressed={lookOf(prefs.look) === l.id} title={l.note} onClick={() => void setPref("look", l.id)}>{l.name}</button>)}</div>
              </>
            )}
            <TelegramLink />
            <h3>This device</h3>
            <p className="muted">A kitchen display is this same app on a screen in the kitchen: it opens on the kitchen's orders after sign-in.</p>
            <div className="row">{(["till", "kitchen"] as const).map((r) => <button key={r} className={role === r ? "primary sm" : "secondary sm"} aria-pressed={role === r} onClick={() => { setDeviceRole(r); setRole(r); setMsg(r === "kitchen" ? "This device is now a kitchen display." : "This device is now a till."); }}>{r === "till" ? "Till" : "Kitchen display"}</button>)}{role === "kitchen" && <button className="secondary sm" onClick={() => go("/kitchen")}>Open the kitchen display</button>}</div>
            <h3>This till's letter</h3>
            <p className="muted">Each till has its own letter so queue numbers never clash when tills are offline.</p>
            <div className="row">{["A", "B", "C", "D"].map((c) => <button key={c} className={letter === c ? "primary sm" : "secondary sm"} aria-pressed={letter === c} onClick={() => { setDeviceCode(c); setLetter(c); }}>{c}</button>)}</div>
            <PhoneSignIn />
            <h3>Menu layout</h3>
            <p className="muted">{prefs.layout ? "You are using your own layout." : till.layout ? "You are using the shop's layout." : "The menu is laid out automatically."} Edit it on the till: press and hold a tile, or tap the pencil.</p>
            <div className="row"><button className="secondary sm" onClick={() => go("/pos")}>Go to the till</button>{prefs.layout && <button className="secondary sm" onClick={() => void setLayout(null).then((e) => setMsg(e ?? "Back to the shop's layout."))}>Use the shop's layout</button>}</div>
          </>
        )}
        {section === "selling" && maySell && (
          <>
            <h2>Selling</h2>
            <section className="e2e-card">
              <h3>After sign-in</h3>
              <label className="row"><input type="checkbox" checked={till.dashboard} onChange={(e) => void save({ dashboard: e.target.checked })} /> Show the Dashboard after sign-in (otherwise go straight to the till)</label>
              <label className="field">Removing a ticket item by sliding
                <select value={till.lineRemove} onChange={(e) => void save({ lineRemove: e.target.value as "bin" | "swipe" })}>
                  <option value="bin">Show a bin button · tap it to remove</option>
                  <option value="swipe">Slide all the way · removes at once</option>
                </select>
              </label>
            </section>
            <section className="e2e-card" style={{ marginTop: 16 }}>
              <h3>Lists for every till, or this till only</h3>
              <p className="muted">The two lists marked below (Order actions and Payment options) are the shop's. A till can keep its own: for example a bar till without Table Map, or a delivery counter with only GrabFood and Card.</p>
              <div className="row">
                <button className={scope === "shop" ? "primary sm" : "secondary sm"} aria-pressed={scope === "shop"} onClick={() => setScope("shop")}>Every till</button>
                <button className={scope === "till" ? "primary sm" : "secondary sm"} aria-pressed={scope === "till"} onClick={() => setScope("till")}>This till only</button>
                {till.thisTill && <button className="secondary sm" onClick={() => { void save({ thisTill: null }); setScope("shop"); }}>Use the shop's lists on this till</button>}
              </div>
              <p className="muted">{till.thisTill ? `This till has its own ${[till.thisTill.actions ? "order actions" : "", till.thisTill.tenders ? "payment options" : ""].filter(Boolean).join(" and ")}.` : "This till uses the shop's lists."}{scope === "till" ? " Changes below are for this till only." : " Changes below are for every till that has no list of its own."}</p>
            </section>
            <CustomActionsEditor actions={till.customActions ?? []} onSave={(a) => void save({ customActions: a })} />
            <Arrange title={scope === "till" ? "Order actions · this till" : "Order actions · every till"} help="Which buttons show on the till's action strip, and in what order. Pay is always there." pool={[...ACTION_POOL, ...(till.customActions ?? []).filter((a) => a.where !== "dashboard").map((a) => ({ id: a.id, label: a.label, note: "Your own button" }))]} pref={scope === "till" ? actionsPref(till) : till.actions} onChange={(p) => void save(scope === "till" ? { thisTill: { ...(till.thisTill ?? {}), actions: p } } : { actions: p })} />
            <CustomTendersEditor tenders={till.customTenders ?? []} onSave={(t) => void save({ customTenders: t })} />
            {staff.role === "owner" && <PermissionsCard />}
            {staff.role === "owner" && <CreditRulesCard />}
            {staff.role === "owner" && <SigninCard />}
            <StationsEditor stations={till.stations ?? []} categories={categories} onSave={(s) => void save({ stations: s })} />
            <Arrange title={scope === "till" ? "Payment options · this till" : "Payment options · every till"} help="Which ways to pay show on the payment panel, and in what order." pool={[...TENDER_POOL, ...(till.customTenders ?? []).map((t) => ({ id: t.id, label: t.name, note: "Your own payment type" }))]} pref={scope === "till" ? tendersPref(till) : till.tenders} onChange={(p) => void save(scope === "till" ? { thisTill: { ...(till.thisTill ?? {}), tenders: p } } : { tenders: p })} />
            <FloorPanel />
            <ShiftsPanel />
            <DiscountPolicyPanel />
            <PaynowPanel />
          </>
        )}
        {section === "menu" && mayMenu && (
          <>
            <h2>Menu & prices</h2>
            <p className="muted">Items, prices, dining options and the printers that take the orders.</p>
            <div className="row"><button className="secondary" onClick={() => go("/prices")}>Prices and menu</button><button className="secondary" onClick={() => go("/printers")}>Printers</button><button className="secondary" onClick={() => go("/devices")}>Devices</button></div>
            {till.layout && <section className="e2e-card" style={{ marginTop: 16 }}><h3>Shop menu layout</h3><p className="muted">The shop has its own standard layout. People who have not made their own see it.</p><button className="secondary sm" onClick={() => { if (window.confirm("Go back to the automatic layout for everyone who has no layout of their own?")) void save({ layout: null }); }}>Reset to automatic</button></section>}
          </>
        )}
        {section === "training" && manager && <><h2>Training</h2><TrainingPanel /></>}
        {section === "about" && (
          <>
            <h2>About</h2>
            <p><b>Rezein POS</b> · version {appVersion()}</p>
            {isTraining() && <p className="muted">This till is in practice mode.</p>}
            <p className="muted">A new version never installs by itself. When one is ready a notice appears at the top of the screen and you choose when to update.</p>
            <div className="row">
              <button className="secondary sm" disabled={checking} onClick={async () => { setChecking(true); const ready = await checkForUpdate(); setChecking(false); setMsg(ready ? "A new version is ready. Use the notice at the top." : "You are on the latest version."); }}>{checking ? "Checking…" : "Check for updates"}</button>
              {updateReady && <b>A new version is ready.</b>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
