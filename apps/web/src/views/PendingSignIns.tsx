import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch } from "../auth";

type Pending = { id: string; phone: string; name: string | null; creditCents: number | null; secondsLeft: number };

/**
 * Customers waiting to sign in. Normally their text arrives and they are in within seconds. When it does not (the hub
 * phone is off, bad signal), a staff member can approve them here after checking the person matches the number.
 */
export function PendingSignIns({ signedIn }: { signedIn: boolean }) {
  const [rows, setRows] = useState<Pending[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await staffFetch("/api/members/pending-signins");
    if ("res" in r && r.res.ok) setRows(((await r.res.json()) as { pending: Pending[] }).pending);
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    void load();
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [signedIn, load]);

  async function act(p: Pending, what: "approve" | "reject") {
    setMsg(null);
    const r = await staffFetch(`/api/members/pending-signins/${p.id}/${what}`, { method: "POST", body: {} });
    if ("problem" in r) return setMsg(r.problem);
    setMsg(r.res.ok ? (what === "approve" ? `Approved +${p.phone}. They are signed in.` : `Turned down +${p.phone}.`) : "That sign-in has already finished or expired.");
    void load();
  }

  if (!signedIn || rows.length === 0) return msg ? <div className="flash">{msg}</div> : null;
  return (
    <div className="tab" style={{ display: "block", marginBottom: 10 }}>
      <b>Customers signing in ({rows.length})</b>
      <p className="muted" style={{ fontSize: 13, margin: "2px 0 6px" }}>Their text normally signs them in by itself. If it has not arrived, check the person in front of you matches the name or number before you approve: approving gives them this member's credit.</p>
      {msg && <div className="flash">{msg}</div>}
      {rows.map((p) => (
        <div className="tab" key={p.id} style={{ alignItems: "center" }}>
          <div>
            <b>+{p.phone}</b>
            <div className="muted" style={{ fontSize: 13 }}>
              {p.name ? `${p.name}${p.creditCents !== null ? ` · credit ${formatMoney(p.creditCents)}` : ""}` : "New number (not on the member list, no credit)"} · {Math.floor(p.secondsLeft / 60)}:{String(p.secondsLeft % 60).padStart(2, "0")} left
            </div>
          </div>
          <div className="tabr">
            <button className="primary sm" onClick={() => void act(p, "approve")}>Approve</button>{" "}
            <button className="secondary sm" onClick={() => void act(p, "reject")}>Turn down</button>
          </div>
        </div>
      ))}
    </div>
  );
}
