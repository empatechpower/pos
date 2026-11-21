import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch, useStaff } from "../auth";

interface TabRow { id: string; spot: string | null; code: string; outletId: string; people: number; released: boolean; billRequested: boolean; waiterPaged: boolean; pagedKind: string | null; totalCents: number; paidCents: number; remainingCents: number; locked: boolean }
interface TabDetail { payments: Array<{ id: string; payer: { name: string | null }; for: { name: string | null } | null; amountCents: number; status: string; method: string; staffRecorded: boolean }>; people: Array<{ id: string; name: string }>; rounds: Array<{ round: number; locked: boolean }> }

/**
 * The waiter's view of the open tabs (Spec 13.2): who has paged, who asked for the bill, and the controls that matter: release payment, reset the
 * page, confirm a counter payment, take cash at the counter. Closing a tab that is not fully paid needs a reason.
 */
export function Tabs() {
  const staff = useStaff();
  const [tabs, setTabs] = useState<TabRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<TabDetail | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await staffFetch("/api/tabs");
    if ("res" in r && r.res.ok) setTabs(((await r.res.json()) as { tabs: TabRow[] }).tabs);
    if (open) { const d = await staffFetch(`/api/tabs/${open}`); if ("res" in d && d.res.ok) setDetail((await d.res.json()) as TabDetail); }
  }, [open]);
  useEffect(() => { if (!staff) return; void load(); const t = window.setInterval(() => void load(), 4000); return () => window.clearInterval(t); }, [staff, load]);
  if (!staff) return <div className="credit"><h2>Tables</h2><p className="muted">Sign in to see the tables. <a href="/login">Sign in</a></p></div>;

  const act = async (path: string, body: object = {}, ok = "Done.") => {
    const r = await staffFetch(path, { method: "POST", body });
    setMsg("res" in r && r.res.ok ? ok : "problem" in r ? r.problem : "That did not work.");
    void load();
  };

  return (
    <div className="credit">
      <h2>Tables</h2>
      <p className="muted">Open tabs. Release payment when the table is ready to pay; a round ordered afterwards is locked until you release again.</p>
      {msg && <div className="flash">{msg}</div>}
      {tabs.length === 0 && <p className="muted">No open tabs.</p>}
      {tabs.map((t) => (
        <div className="e2e-card" key={t.id} style={{ marginBottom: 10 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <b style={{ flex: 1 }}>{t.spot ?? "Bar tab"} <span className="muted">· {t.code} · {t.people} {t.people === 1 ? "person" : "people"}</span></b>
            <span>{formatMoney(t.remainingCents)} <span className="muted">of {formatMoney(t.totalCents)}</span></span>
          </div>
          {(t.waiterPaged || t.billRequested) && <div className="flash warn">{t.billRequested ? "Asked for the bill." : "Called for help."} <button className="secondary sm" onClick={() => void act(`/api/tabs/${t.id}/reset-page`, {}, "Page reset.")}>Reset page</button></div>}
          <div className="row">
            <button className={t.locked ? "primary sm" : "secondary sm"} onClick={() => void act(`/api/tabs/${t.id}/release`, {}, "Payment released.")}>{t.locked ? "Release payment" : "Release new rounds"}</button>
            <button className="secondary sm" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? "Hide payments" : "Payments"}</button>
            <button className="secondary sm" onClick={() => { const reason = window.prompt("Close this tab without it being fully paid. Why?"); if (reason) void act(`/api/tabs/${t.id}/close`, { reason }, "Tab closed."); }}>Close tab</button>
          </div>
          {open === t.id && detail && (
            <div style={{ marginTop: 8 }}>
              {detail.payments.length === 0 && <p className="muted">No payments yet.</p>}
              {detail.payments.map((p) => (
                <div className="row" key={p.id} style={{ alignItems: "center" }}>
                  <span style={{ flex: 1 }}>{p.payer.name}{p.for ? ` for ${p.for.name}` : ""} · {p.method}{p.staffRecorded ? " · staff" : ""} · {p.status}</span>
                  <b>{formatMoney(p.amountCents)}</b>
                  {p.status === "reserved" && <button className="primary sm" onClick={() => void act(`/api/tabs/payments/${p.id}/confirm`, {}, "Payment confirmed.")}>Confirm paid</button>}
                </div>
              ))}
              {t.remainingCents > 0 && !t.locked && detail.people.length > 0 && (
                <div className="row">
                  <span className="muted">Cash at the counter:</span>
                  {detail.people.map((p) => <button key={p.id} className="secondary sm" onClick={() => void act(`/api/tabs/${t.id}/payments`, { participantId: p.id, mode: "mine" }, `${p.name}'s share recorded as cash.`)}>{p.name}'s share</button>)}
                  <button className="secondary sm" onClick={() => void act(`/api/tabs/${t.id}/payments`, { mode: "all" }, "The whole bill recorded as cash.")}>The whole bill</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
