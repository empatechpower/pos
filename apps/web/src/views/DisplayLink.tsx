import { useCallback, useEffect, useState } from "react";
import { linkDisplay, linkedScreens, unlinkScreen } from "../customerDisplayBus";

/**
 * Pair a customer display (a separate tablet or monitor opened on /display) with THIS device. Open it on the till itself: the till is what
 * publishes the order, so it is the till that must type the code.
 */
export function DisplayLink() {
  const [code, setCode] = useState("");
  const [screens, setScreens] = useState<Array<{ id: string; lastSeen: string | null }>>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => setScreens(await linkedScreens()), []);
  useEffect(() => { void load(); }, [load]);
  const ago = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))}s ago` : "never");

  return (
    <div className="e2e-card" style={{ marginBottom: 14 }}>
      <h3>Customer display (this device)</h3>
      <p className="muted">Open <b>/display</b> on the screen that faces the customer. It shows a 6-character code. Type it here, on the till.</p>
      <div className="row">
        <input value={code} maxLength={7} placeholder="ABC 123" onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ textTransform: "uppercase", letterSpacing: ".15em" }} aria-label="Display code" />
        <button className="primary sm" disabled={code.replace(/[^A-Z0-9]/g, "").length !== 6} onClick={() => void (async () => {
          const r = await linkDisplay(code);
          setMsg(r === "ok" ? "Linked. The screen now follows this till." : r === "wrong" ? "That code was not found. It may have expired: check the screen for a new one." : "Could not reach the server. Try again.");
          if (r === "ok") { setCode(""); void load(); }
        })()}>Link screen</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {screens.map((s) => (
        <div className="row" key={s.id}>
          <span>Linked screen · seen {ago(s.lastSeen)}</span>
          <button className="secondary sm" onClick={() => void unlinkScreen(s.id).then(load)}>Unlink</button>
        </div>
      ))}
    </div>
  );
}
