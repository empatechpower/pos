import { useState } from "react";
import { approveThisDevice, enrollDevice, useDevice, type EnrollFailure } from "../device";

/** "+65 9123 4567" or an 8-digit Singapore number is a phone number; anything else is a staff code. */
function who(raw: string): { phone?: string; code?: string } {
  const t = raw.replace(/[\s\-().]/g, "");
  if (t.startsWith("+")) return { phone: t };
  if (/^\d{8}$/.test(t)) return { phone: `+65${t}` };
  return { code: raw.trim().toUpperCase() };
}

const failText = (r: EnrollFailure, limit?: number, by: "code" | "approval" = "code") =>
  r === "full" ? `This shop's licence allows ${limit ?? "a set number of"} devices and all of them are connected. Disconnect one under Devices, or ask Rezein for more.`
  : r === "not_allowed" ? "Only an owner or a manager can approve a device. Ask one of them to sign in here."
  : r === "locked" ? "Too many wrong PINs for that person. Wait a few minutes and try again."
  : r === "limited" ? "Too many wrong tries from here. Wait a few minutes and try again."
  : r === "invalid" ? (by === "code" ? "That code isn't valid. It may have been used or expired. Ask a manager for a new one." : "That phone number or staff code and PIN don't match.")
  : "Could not reach the server. Setting up a device needs a connection.";

/** First start (or after a manager removed this device): an owner or manager approves it by signing in here, or a one-time code is typed. */
export function Enroll({ online }: { online: boolean }) {
  const device = useDevice();
  const [name, setName] = useState(localStorage.getItem("pos.deviceName") ?? "");
  const [id, setId] = useState("");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    localStorage.setItem("pos.deviceName", name);
    const r = useCode ? await enrollDevice(code.trim(), name.trim()) : await approveThisDevice(who(id), pin, name.trim());
    setBusy(false);
    if (!r.ok) {
      if (useCode) setCode(""); else setPin("");
      setMsg(failText(r.reason, r.limit, useCode ? "code" : "approval"));
    }
  }

  const ready = !!name.trim() && online && !busy && (useCode ? code.length >= 8 : !!id.trim() && pin.length >= 4);
  return (
    <div className="shell">
      <main>
        <form className="credit" onSubmit={submit}>
          <h2>{device.rejected ? "This device was disconnected" : "Set up this device"}</h2>
          <p className="muted">
            {device.rejected
              ? "An owner or manager disconnected this device, or its access ended. Orders already taken here are kept and will sync once it is set up again."
              : "A new device has to be approved once before staff can sign in on it."}
            {" "}
            {useCode ? "Type the one-time code made under Devices on a device that is already set up." : "An owner or manager approves it by signing in here."}
          </p>
          <label className="field">
            Name this device (e.g. Front till, Kitchen screen)
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          {useCode ? (
            <label className="field">
              Enrollment code
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" maxLength={8} aria-label="Enrollment code" />
            </label>
          ) : (
            <>
              <label className="field">
                Owner or manager: phone number or staff code
                <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" placeholder="+65 9123 4567" aria-label="Phone number or staff code" />
              </label>
              <label className="field">
                PIN
                <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} type="password" inputMode="numeric" autoComplete="off" maxLength={8} aria-label="PIN" />
              </label>
            </>
          )}
          {!online && <div className="flash">No connection. Setting up a device needs the server.</div>}
          {msg && <div className="flash" role="status">{msg}</div>}
          <button className="primary" disabled={!ready}>
            {busy ? "Setting up…" : useCode ? "Enrol this device" : "Approve this device"}
          </button>
          <p style={{ marginTop: 14 }}>
            <button type="button" className="secondary sm" onClick={() => { setUseCode(!useCode); setMsg(null); }}>
              {useCode ? "Approve by signing in instead" : "Use an enrollment code instead"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
