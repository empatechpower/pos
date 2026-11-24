import { useEffect, useState } from "react";
import { go } from "../nav";
import { staffFetch, useStaff } from "../auth";
import { TEXT_SCALE, setPref, usePrefs } from "../prefs";
import { ACTION_POOL, TENDER_POOL, arrangeAll, loadTillSettings, saveTill, useTillSettings, type TillSettings } from "../till/tillSettings";
import { appVersion, checkForUpdate, useUpdatePending } from "../pwaUpdate";
import { FloorPanel } from "./FloorPanel";
import { ShiftsPanel } from "./ShiftsPanel";
import { TrainingPanel } from "./TrainingPanel";
import { DiscountPolicyPanel } from "./DiscountPolicyPanel";
import { PaynowPanel } from "./PaynowPanel";
import { isTraining } from "../training";
import { getDeviceCode, setDeviceCode } from "../db";
import { setLayout } from "../prefs";

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

function Arrange({ title, help, pool, pref, onChange }: { title: string; help: string; pool: Array<{ id: string; label: string; note?: string }>; pref: TillSettings["actions"]; onChange: (p: TillSettings["actions"]) => void }) {
  const rows = arrangeAll(pool, pref);
  const move = (i: number, d: number) => { const ids = rows.map((r) => r.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; onChange({ order: ids, hidden: pref.hidden }); };
  const toggle = (id: string) => onChange({ order: rows.map((r) => r.id), hidden: pref.hidden.includes(id) ? pref.hidden.filter((x) => x !== id) : [...pref.hidden, id] });
  return (
    <section className="e2e-card" style={{ marginTop: 16 }}>
      <h3>{title}</h3>
      <p className="muted">{help}</p>
      {rows.map((r, i) => (
        <div className="arr-row" key={r.id}>
          <label><input type="checkbox" aria-label={`Show ${r.label}`} checked={!pref.hidden.includes(r.id)} onChange={() => toggle(r.id)} /> {r.label}{r.note ? <span className="muted"> · {r.note}</span> : null}</label>
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
export function Settings() {
  const staff = useStaff();
  const prefs = usePrefs();
  const till = useTillSettings();
  const updateReady = useUpdatePending();
  const [section, setSection] = useState<Section>("station");
  const [msg, setMsg] = useState("");
  const [checking, setChecking] = useState(false);
  const [letter, setLetter] = useState(getDeviceCode());
  useEffect(() => { void loadTillSettings(); }, [staff?.code]);
  if (!staff) return <div className="credit"><h2>Settings</h2><p className="muted">Sign in to change settings. <a href="/login">Sign in</a></p></div>;
  const manager = staff.role !== "cashier";
  const save = async (patch: Partial<TillSettings>) => { const e = await saveTill(patch); setMsg(e ?? "Saved."); };
  const sections: Array<[Section, string, boolean]> = [["station", "Station", true], ["selling", "Selling", manager], ["menu", "Menu & prices", manager], ["training", "Training", manager], ["about", "About", true]];

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
            <h3>This till's letter</h3>
            <p className="muted">Each till has its own letter so queue numbers never clash when tills are offline.</p>
            <div className="row">{["A", "B", "C", "D"].map((c) => <button key={c} className={letter === c ? "primary sm" : "secondary sm"} aria-pressed={letter === c} onClick={() => { setDeviceCode(c); setLetter(c); }}>{c}</button>)}</div>
            <PhoneSignIn />
            <h3>Menu layout</h3>
            <p className="muted">{prefs.layout ? "You are using your own layout." : till.layout ? "You are using the shop's layout." : "The menu is laid out automatically."} Edit it on the till: press and hold a tile, or tap the pencil.</p>
            <div className="row"><button className="secondary sm" onClick={() => go("/pos")}>Go to the till</button>{prefs.layout && <button className="secondary sm" onClick={() => void setLayout(null).then((e) => setMsg(e ?? "Back to the shop's layout."))}>Use the shop's layout</button>}</div>
          </>
        )}
        {section === "selling" && manager && (
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
            <Arrange title="Order actions" help="Which buttons show on the till's action strip, and in what order. Pay is always there." pool={ACTION_POOL} pref={till.actions} onChange={(p) => void save({ actions: p })} />
            <Arrange title="Payment options" help="Which ways to pay show on the payment panel, and in what order." pool={TENDER_POOL} pref={till.tenders} onChange={(p) => void save({ tenders: p })} />
            <FloorPanel />
            <ShiftsPanel />
            <DiscountPolicyPanel />
            <PaynowPanel />
          </>
        )}
        {section === "menu" && manager && (
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
