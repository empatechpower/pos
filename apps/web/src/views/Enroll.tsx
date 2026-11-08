import { useState } from "react";
import { enrollDevice, useDevice } from "../device";

/** First start (or after a manager removed this device): trade a one-time code for access. */
export function Enroll({ online }: { online: boolean }) {
  const device = useDevice();
  const [code, setCode] = useState("");
  const [name, setName] = useState(localStorage.getItem("pos.deviceName") ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    localStorage.setItem("pos.deviceName", name);
    const r = await enrollDevice(code.trim(), name.trim());
    setBusy(false);
    if (!r.ok) {
      setCode("");
      setMsg(
        r.reason === "invalid"
          ? "That code isn't valid. It may have been used or expired. Ask a manager for a new one."
          : r.reason === "limited"
            ? "Too many wrong codes from here. Wait a few minutes and try again."
            : "Could not reach the server. Enrolling needs a connection.",
      );
    }
  }

  return (
    <div className="shell">
      <main>
        <form className="credit" onSubmit={submit}>
          <h2>{device.rejected ? "This device was removed" : "Set up this device"}</h2>
          <p className="muted">
            {device.rejected
              ? "A manager has removed this device, or its access ended. Orders already taken here are kept and will sync once it is enrolled again. Ask a manager for a re-enrollment code."
              : "Ask a manager for an enrollment code. They can create one under Devices on an enrolled device. Codes work once and expire in 15 minutes."}
          </p>
          <label className="field">
            Enrollment code
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" maxLength={8} />
          </label>
          <label className="field">
            Name this device (e.g. Front till, Kitchen screen)
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          {!online && <div className="flash">No connection. Enrolling needs the server.</div>}
          {msg && <div className="flash">{msg}</div>}
          <button className="primary" disabled={code.length < 8 || !name.trim() || !online || busy}>
            {busy ? "Enrolling…" : "Enrol this device"}
          </button>
        </form>
      </main>
    </div>
  );
}
