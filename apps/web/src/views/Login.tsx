import { go } from "../nav";
import { useState } from "react";
import { currentStaff, signIn, signOut, useStaff } from "../auth";
import { useShift } from "../shift";
import { takeAfterTraining } from "../training";
import { takeLockNote } from "../lock";
import { loadTillSettings, tillSettings } from "../till/tillSettings";
import { appVersion } from "../pwaUpdate";
import "../till/till.css";

/** Country codes for the phone sign-in: Singapore first, then the neighbours. */
const COUNTRIES: Array<[string, string]> = [["+65", "Singapore"], ["+60", "Malaysia"], ["+62", "Indonesia"], ["+66", "Thailand"], ["+63", "Philippines"], ["+84", "Vietnam"], ["+852", "Hong Kong"], ["+86", "China"], ["+91", "India"], ["+61", "Australia"], ["+44", "United Kingdom"], ["+1", "United States"]];

/** Staff who have signed in on this device, newest first. Kept so they can tap their name and only type a PIN. */
interface Recent { code: string; name: string; role: string }
const LS_RECENT = "pos.recentStaff";
const recents = (): Recent[] => { try { return (JSON.parse(localStorage.getItem(LS_RECENT) ?? "[]") as Recent[]).filter((r) => r?.code); } catch { return []; } };
const remember = (r: Recent) => localStorage.setItem(LS_RECENT, JSON.stringify([r, ...recents().filter((x) => x.code !== r.code)].slice(0, 200)));

/**
 * Sign-in: the names of recent staff on the left (the five latest, the rest in a drop-down), the PIN pad on the right. Nobody is chosen until they
 * tap their own name. The pad shows 1-2-3 on top; the device keyboard stays shut unless asked for.
 */
export function Login({ online, problem }: { online: boolean; problem?: string | null }) {
  const staff = useStaff();
  const [list] = useState(recents);
  const [picked, setPicked] = useState<Recent | null>(null);
  const [mode, setMode] = useState<"list" | "phone" | "code">(() => (recents().length ? "list" : "phone"));
  const [cc, setCc] = useState(() => localStorage.getItem("pos.cc") ?? "+65");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kbd, setKbd] = useState(() => localStorage.getItem("pos.kbd") === "1");
  const [target, setTarget] = useState<"pin" | "code" | "phone">(() => (recents().length ? "pin" : "phone"));
  const [lockNote] = useState(() => takeLockNote());
  const shift = useShift();
  const [blocked, setBlocked] = useState(false);

  if (staff) {
    return (
      <div className="credit">
        <h2>Signed in</h2>
        <p className="bal"><b>{staff.name}</b> <span className="muted">· {staff.role}</span></p>
        <button className="secondary" onClick={() => { if (shift) setBlocked(true); else void signOut(); }}>Sign out</button>{blocked && <p className="flash" role="alert">Close your shift first (Drawer {shift?.drawer}), then sign out.</p>}
      </div>
    );
  }

  const showCode = mode === "code";
  const showPhone = mode === "phone";
  const press = (k: string) => {
    if (target === "phone" && showPhone) return setPhone((c) => (k === "⌫" ? c.slice(0, -1) : (c + k).slice(0, 12)));
    if (target === "code" && showCode) return setCode((c) => (k === "⌫" ? c.slice(0, -1) : (c + k).slice(0, 12)));
    setPin((p) => (k === "⌫" ? p.slice(0, -1) : p.length < 8 ? p + k : p));
  };
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const digits = phone.replace(/\D/g, "");
    const who: string | { phone: string } | undefined = showPhone ? (digits ? { phone: `${cc}${digits}` } : undefined) : showCode ? code.trim() || undefined : picked?.code;
    if (!who) { setMsg(showPhone ? "Enter your phone number, then your PIN." : showCode ? "Enter your staff code, then your PIN." : "Tap your name first, then enter your PIN."); return; }
    if (showPhone) localStorage.setItem("pos.cc", cc);
    setBusy(true);
    setMsg(null);
    const r = await signIn(who, pin);
    setBusy(false);
    setPin("");
    if (r.ok) {
      const me = currentStaff();
      if (me) remember({ code: me.code, name: me.name, role: me.role });
      // Home (the Dashboard) after practice, and after every sign-in unless the shop switched it off.
      const afterTraining = takeAfterTraining();
      await loadTillSettings();
      go(afterTraining || tillSettings().dashboard ? "/dashboard" : "/pos");
    } else {
      setMsg(r.reason === "locked" ? "Too many wrong PINs. This account is locked for a few minutes." : r.reason === "invalid" ? "Wrong name or PIN." : "Could not reach the server. Sign-in needs a connection.");
    }
  }
  const top = list.slice(0, 5);
  const rest = list.slice(5);
  const pick = (r: Recent) => { setPicked(r); setMode("list"); setTarget("pin"); setMsg(null); };
  const label = showPhone ? "Enter your PIN" : showCode ? "Staff code, then PIN" : picked ? `Enter your PIN · ${picked.name}` : list.length ? "Tap your name, then enter your PIN" : "Use your staff code, then enter your PIN";

  return (
    <form className="signin" onSubmit={(e) => void submit(e)}>
      <h2>Sign in to your counter</h2>
      {lockNote && <div className="t-flash" role="status">{lockNote}</div>}
      {!online && <div className="t-flash">The app is not in sync with the shop server right now{problem ? ` (${problem})` : ""}. You can still try to sign in.</div>}
      <div className="signin-cols">
        <div className="signin-who">
          {mode === "list" && (
            <>
              <div className="signin-label">Recent staff · tap your name</div>
              <div className="signin-names">
                {top.map((r) => <button type="button" key={r.code} className={picked?.code === r.code ? "on" : ""} onClick={() => pick(r)}>{r.name}<small>{r.role}</small></button>)}
              </div>
              {rest.length > 0 && (
                <select className="signin-more" aria-label="More staff" value="" onChange={(e) => { const r = list.find((x) => x.code === e.target.value); if (r) pick(r); }}>
                  <option value="">More staff…</option>
                  {rest.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                </select>
              )}
              <button type="button" className="t-ghost" onClick={() => { setMode("phone"); setPicked(null); setTarget("phone"); }}>Use phone number</button>
              <button type="button" className="t-ghost" onClick={() => { setMode("code"); setPicked(null); setTarget("code"); }}>Use staff code</button>
            </>
          )}
          {showPhone && (
            <>
              <div className="signin-label">Phone number</div>
              <div className="signin-phone">
                <select aria-label="Country code" value={cc} onChange={(e) => setCc(e.target.value)}>
                  {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{c} {n}</option>)}
                </select>
                <input type="tel" inputMode="numeric" placeholder="8111 1111" aria-label="Phone number" autoComplete="tel-national" readOnly={!kbd} value={phone} onFocus={() => setTarget("phone")} onClick={() => setTarget("phone")} onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, ""))} />
              </div>
              {list.length > 0 && <button type="button" className="t-ghost" onClick={() => { setMode("list"); setTarget("pin"); }}>← Back to staff list</button>}
              <button type="button" className="t-ghost" onClick={() => { setMode("code"); setTarget("code"); }}>Use staff code</button>
            </>
          )}
          {showCode && (
            <>
              <button type="button" className="t-ghost" onClick={() => { setMode("phone"); setTarget("phone"); }}>← Use phone number</button>
              {list.length > 0 && <button type="button" className="t-ghost" onClick={() => { setMode("list"); setTarget("pin"); }}>← Back to staff list</button>}
              <label className="t-field">Staff code<input value={code} autoCapitalize="characters" autoComplete="username" readOnly={!kbd} onFocus={() => setTarget("code")} onClick={() => setTarget("code")} onChange={(e) => setCode(e.target.value)} /></label>
            </>
          )}
        </div>
        <div className="signin-pad">
          <div className="signin-label">{label}</div>
          <div className="signin-pinrow">
            <button type="button" className="t-ghost" onClick={() => (target === "phone" && showPhone ? setPhone("") : target === "code" && showCode ? setCode("") : setPin(""))}>Clear</button>
            <input className="signin-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={8} aria-label="PIN" placeholder="••••" readOnly={!kbd} value={pin} onFocus={() => setTarget("pin")} onClick={() => setTarget("pin")} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            <button type="submit" className="t-primary" disabled={busy}>Login</button>
          </div>
          {msg && <div className="t-err" role="alert">{msg}</div>}
          <div className="signin-keys">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", ""].map((k, i) => (k === "" ? <span key={i} /> : <button type="button" key={i} onClick={() => press(k)}>{k}</button>))}
          </div>
          <button type="button" className="t-ghost" onClick={() => { const n = !kbd; setKbd(n); localStorage.setItem("pos.kbd", n ? "1" : "0"); }}>{kbd ? "⌨ Hide device keyboard" : "⌨ Use device keyboard"}</button>
        </div>
      </div>
      <p className="t-muted signin-version">Version {appVersion()}</p>
    </form>
  );
}
