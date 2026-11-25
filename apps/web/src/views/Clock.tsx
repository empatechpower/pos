import { useEffect, useRef, useState } from "react";
import { deviceHeader } from "../device";
import { go } from "../nav";

interface Punch { name: string; action: "in" | "out"; at: number; workedMinutes?: number; repeated?: boolean }
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
const worked = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;

/**
 * Clock in and out at the till, without signing in to sell. A card reader types the card's number and presses Enter, so the box below
 * only has to stay ready; someone without a card uses their staff code and PIN. The same tap clocks in when you are out and out when
 * you are in. The answer stays on screen for a few seconds, then the screen is ready for the next person.
 */
export function Clock() {
  const [card, setCard] = useState("");
  const [mode, setMode] = useState<"card" | "pin">("card");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; title: string; text: string } | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(t); }, []);
  // The card box takes the reader's typing wherever the last tap on the screen landed.
  useEffect(() => { if (mode === "card" && !result) box.current?.focus(); });
  useEffect(() => { if (!result) return; const t = window.setTimeout(() => setResult(null), result.ok ? 5000 : 7000); return () => window.clearTimeout(t); }, [result]);

  async function send(body: object) {
    if (busy) return;
    setBusy(true);
    const res = await fetch("/api/time/punch", { method: "POST", headers: { "content-type": "application/json", ...deviceHeader() }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    setCard(""); setPin("");
    if (!res) return setResult({ ok: false, title: "No connection", text: "Clocking in and out needs a connection. Try again in a moment." });
    const j = (await res.json().catch(() => ({}))) as Partial<Punch> & { message?: string };
    if (!res.ok) return setResult({ ok: false, title: "Not clocked", text: j.message ?? "That did not work. Try again, or ask a manager." });
    setCode("");
    const p = j as Punch;
    setResult(p.repeated
      ? { ok: true, title: `${p.name}, you are already clocked ${p.action}`, text: `Since ${clock(p.at)}. Nothing was changed.` }
      : p.action === "in"
        ? { ok: true, title: `Welcome, ${p.name}`, text: `Clocked in at ${clock(p.at)}.` }
        : { ok: true, title: `Goodbye, ${p.name}`, text: `Clocked out at ${clock(p.at)}${p.workedMinutes !== undefined ? ` · ${worked(p.workedMinutes)} worked` : ""}.` });
  }

  return (
    <div className="clockscreen" onClick={() => { if (mode === "card") box.current?.focus(); }}>
      <div className="clockcard">
        <div className="clocktime" aria-hidden="true">{clock(now)}</div>
        <h2>Clock in / out</h2>
        {result ? (
          <div className={`clockresult ${result.ok ? "ok" : "bad"}`} role="status"><strong>{result.title}</strong><span>{result.text}</span></div>
        ) : mode === "card" ? (
          <>
            <p className="muted">Hold your card to the reader.</p>
            <form onSubmit={(e) => { e.preventDefault(); if (card.trim()) void send({ card: card.trim() }); }}>
              <input ref={box} className="clockinput" aria-label="Card number" autoComplete="off" value={card} onChange={(e) => setCard(e.target.value)} placeholder="Waiting for a card…" />
            </form>
            <button className="secondary" onClick={(e) => { e.stopPropagation(); setMode("pin"); }}>No card? Use your staff code and PIN</button>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (code.trim() && pin) void send({ code: code.trim(), pin }); }} onClick={(e) => e.stopPropagation()}>
            <label className="field">Staff code<input aria-label="Staff code" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label className="field">PIN<input aria-label="PIN" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} /></label>
            <div className="row"><button type="button" className="secondary" onClick={() => setMode("card")}>Use a card</button><button className="primary" disabled={busy || !code.trim() || !pin}>Clock in / out</button></div>
          </form>
        )}
        <button className="secondary sm clockback" onClick={(e) => { e.stopPropagation(); go("/login"); }}>Back to sign-in</button>
      </div>
    </div>
  );
}
