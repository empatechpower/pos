import { go } from "../nav";
import { useState } from "react";
import { signIn, signOut, useStaff } from "../auth";
import { useShift } from "../shift";

export function Login({ online, problem }: { online: boolean; problem?: string | null }) {
  const staff = useStaff();
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await signIn(code.trim(), pin);
    setBusy(false);
    if (r.ok) {
      setPin("");
      go("/pos");
    } else {
      setPin("");
      setMsg(
        r.reason === "locked"
          ? "Too many wrong PINs. This account is locked for a few minutes."
          : r.reason === "invalid"
            ? "Wrong staff code or PIN."
            : "Could not reach the server. Sign-in needs a connection.",
      );
    }
  }

  return (
    <form className="credit" onSubmit={submit}>
      <h2>Staff sign in</h2>
      <p className="muted">Taking orders works without signing in. Credit top-ups, credit payments and refunds need it.</p>
      <label className="field">
        Staff code
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="username" autoCapitalize="characters" />
      </label>
      <label className="field">
        PIN
        <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} type="password" inputMode="numeric" autoComplete="current-password" maxLength={8} />
      </label>
      {!online && <div className="flash">The app is not in sync with the shop server right now{problem ? ` (${problem})` : ""}. You can still try to sign in.</div>}
      {msg && <div className="flash">{msg}</div>}
      <button className="primary" disabled={!code || pin.length < 4 || busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
