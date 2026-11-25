import { useState } from "react";
import { hasPerm, staffFetch, useStaff } from "../auth";
import { isTraining } from "../training";

interface Entry { at: number; kind: string; text: string; who: string }
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Singapore" });

/** For managers: everything that happened to this order, and everyone who opened it, in order. Reading it is itself logged. */
export function OrderTrail({ orderId }: { orderId: string }) {
  const staff = useStaff();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [msg, setMsg] = useState("");
  if (!hasPerm(staff, "audit.read") || isTraining()) return null;
  async function load() {
    setMsg("");
    const r = await staffFetch(`/api/orders/${encodeURIComponent(orderId)}/trail`);
    if (!("res" in r)) return setMsg(r.problem);
    if (r.res.ok) setEntries(((await r.res.json()) as { entries: Entry[] }).entries);
    else setMsg("The server does not have this order yet. Try again after it syncs.");
  }
  return (
    <div className="od-card">
      {!entries ? <button className="secondary sm" onClick={() => void load()}>Order history</button> : (
        <>
          <b>Order history</b>
          {entries.map((e, i) => (
            <div key={i} className="od-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0" }}>
              <span>{e.kind === "viewed" ? <i>{e.text}</i> : e.text}<small className="muted" style={{ display: "block" }}>{e.who}</small></span>
              <span className="muted" style={{ whiteSpace: "nowrap" }}>{when(e.at)}</span>
            </div>
          ))}
          <button className="secondary sm" onClick={() => setEntries(null)}>Hide</button>
        </>
      )}
      {msg && <div className="flash">{msg}</div>}
    </div>
  );
}
