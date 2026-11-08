import { useState } from "react";
import { signIn, signOut, useStaff } from "../auth";

export function Login({ online }: { online: boolean }) {
  const staff = useStaff();
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (staff) {
    return (
      <div className="credit">
        <h2>Signed in</h2>
        <p className="bal"><b>{staff.name}</b> <span className="muted">· {staff.role}</span></p>
        <button className="secondary" onClick={() => void signOut()}>Sign out</button>
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
      location.hash = "#/pos";
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
      {!online && <div className="flash">No connection. Signing in needs the server.</div>}
      {msg && <div className="flash">{msg}</div>}
      <button className="primary" disabled={!code || pin.length < 4 || !online || busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
