import { deviceRole } from "../device";
import { go } from "../nav";
import { useState } from "react";
import { currentStaff, signIn, signOut, useStaff } from "../auth";
import { useShift } from "../shift";
import { takeAfterTraining } from "../training";
import { takeLockNote } from "../lock";
import { loadTillSettings, tillSettings } from "../till/tillSettings";
import { appVersion } from "../pwaUpdate";
import "../till/till.css";
import "../proto/proto.css";

/** Country codes for the phone sign-in: Singapore first, then the neighbours. */
const COUNTRIES: Array<[string, string]> = [["+65", "Singapore"], ["+60", "Malaysia"], ["+62", "Indonesia"], ["+66", "Thailand"], ["+86", "China"], ["+852", "Hong Kong"], ["+886", "Taiwan"], ["+63", "Philippines"], ["+84", "Vietnam"], ["+91", "India"], ["+81", "Japan"], ["+82", "South Korea"], ["+61", "Australia"], ["+64", "New Zealand"], ["+971", "UAE"], ["+44", "United Kingdom"], ["+1", "United States"]];

/** Staff who have signed in on this device, newest first. Kept so they can tap their name and only type a PIN. */
interface Recent { code: string; name: string; role: string; hint?: string | null }
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
      if (me) remember({ code: me.code, name: me.name, role: me.role, hint: me.phoneHint ?? null });
      // Home (the Dashboard) after practice, and after every sign-in unless the shop switched it off.
      const afterTraining = takeAfterTraining();
      await loadTillSettings();
      go(!afterTraining && deviceRole() === "kitchen" ? "/kitchen" : afterTraining || tillSettings().dashboard ? "/dashboard" : "/pos"); // a device set up as the kitchen display opens there
    } else {
      setMsg(r.reason === "locked" ? "Too many wrong PINs. This account is locked for a few minutes." : r.reason === "invalid" ? "Wrong name or PIN." : "Could not reach the server. Sign-in needs a connection.");
    }
  }
  const top = list.slice(0, 5);
  const rest = list.slice(5);
  const pick = (r: Recent) => { setPicked(r); setMode("list"); setTarget("pin"); setMsg(null); };
  const label = picked ? `${picked.name} · ${picked.hint || picked.role}` : showPhone ? "Enter your PIN" : showCode ? "Staff code, then PIN" : "Choose your name, then enter your PIN";
  const key = (k: string) => (k === "" ? <span key="sp" className="padspacer" /> : <button type="button" key={k} onClick={() => press(k)}>{k}</button>);

  // The markup and class names are the prototype's own (proto-reference/index.html, showLogin), styled by its stylesheet.
  return (
    <div className="proto">
      <section className="login">
        <div className="loginheader"><img className="brandlogo loginlogo" src="/assets/rezein-logo.png" alt="Rezein" /></div>
        <div className="loginbox">
          <h2>Sign in to your counter</h2>
          <form onSubmit={(e) => void submit(e)}>
            {lockNote && <div className="error" role="status">{lockNote}</div>}
            <div className="logincols">
              <div className="loginmain">
                {mode === "list" && (
                  <>
                    <div className="pickerlabel">Recent staff · tap your name</div>
                    <div className="remembered">
                      {top.map((r) => <button type="button" key={r.code} className={picked?.code === r.code ? "selected" : ""} onClick={() => pick(r)}>{r.name}<small>{r.hint || r.role}</small></button>)}
                    </div>
                    {rest.length > 0 && (
                      <select className="morestaff" aria-label="More staff" value="" onChange={(e) => { const r = list.find((x) => x.code === e.target.value); if (r) pick(r); }}>
                        <option value="">More staff…</option>
                        {rest.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                      </select>
                    )}
                    <button type="button" className="phonepath" onClick={() => { setMode("phone"); setPicked(null); setTarget("phone"); }}>Use phone number</button>
                  </>
                )}
                {showPhone && (
                  <>
                    {list.length > 0 && <button type="button" className="phonepath" onClick={() => { setMode("list"); setTarget("pin"); }}>← Back to staff list</button>}
                    <label className="field">Phone number</label>
                    <div className="phonerow">
                      <select aria-label="Country code" value={cc} onChange={(e) => setCc(e.target.value)}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{c} {n}</option>)}</select>
                      <input type="tel" inputMode={kbd ? "numeric" : "none"} readOnly={!kbd} autoComplete="tel-national" placeholder="8111 1111" aria-label="Phone number" className={target === "phone" ? "padactive" : ""} value={phone} onFocus={() => setTarget("phone")} onClick={() => setTarget("phone")} onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, ""))} />
                    </div>
                  </>
                )}
                {showCode && (
                  <>
                    <button type="button" className="phonepath" onClick={() => { setMode("phone"); setTarget("phone"); }}>← Use phone number</button>
                    {list.length > 0 && <button type="button" className="phonepath" onClick={() => { setMode("list"); setTarget("pin"); }}>← Back to staff list</button>}
                    <label className="field">Staff code</label>
                    <input className={target === "code" ? "padactive" : ""} value={code} autoCapitalize="characters" autoComplete="username" aria-label="Staff code" readOnly={!kbd} onFocus={() => setTarget("code")} onClick={() => setTarget("code")} onChange={(e) => setCode(e.target.value)} />
                  </>
                )}
                <button type="button" className="telegrammini" onClick={() => setMsg("Telegram sign-in is not set up for this shop yet. Use your phone number or staff code.")}>Scan QR with Telegram</button>
              </div>
              <div className="loginpad">
                <label className="pinlabel" htmlFor="pin">{label}</label>
                <div className="pinrow">
                  <button type="button" className="wordkey pinrowbtn" onClick={() => (target === "phone" && showPhone ? setPhone("") : target === "code" && showCode ? setCode("") : setPin(""))}>Clear</button>
                  <input id="pin" className={`pin ${target === "pin" ? "padactive" : ""}`} type="password" inputMode={kbd ? "numeric" : "none"} readOnly={!kbd} maxLength={8} autoComplete="current-password" aria-label="PIN" placeholder="••••" value={pin} onFocus={() => setTarget("pin")} onClick={() => setTarget("pin")} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
                  <button type="submit" className="primary pinrowbtn" disabled={busy}>Login</button>
                </div>
                <div className="error" role="alert">{msg ?? ""}</div>
                <div className="pad">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", ""].map(key)}</div>
                <button type="button" className="kbdbtn" onClick={() => { const n = !kbd; setKbd(n); localStorage.setItem("pos.kbd", n ? "1" : "0"); }}>{kbd ? "⌨ Hide device keyboard" : "⌨ Use device keyboard"}</button>
              </div>
            </div>
          </form>
          <p className="sync">Local storage ready · This device is {online ? "connected" : "not connected"} to the shop server{!online && problem ? ` (${problem})` : ""}.</p>
          <details className="testaccounts"><summary>Other ways to sign in</summary><p>{!showCode ? <button type="button" className="phonepath" onClick={() => { setMode("code"); setPicked(null); setTarget("code"); }}>Use staff code</button> : "You are using a staff code."}</p></details>
          <p className="sync verline">Rezein {appVersion()}</p>
        </div>
      </section>
    </div>
  );
}
