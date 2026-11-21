import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@pos/core";
import { staffFetch, useStaff } from "../auth";

interface TabRow { id: string; spot: string | null; code: string; outletId: string; people: number; released: boolean; billRequested: boolean; waiterPaged: boolean; pagedKind: string | null; pageAcknowledged?: boolean; totalCents: number; paidCents: number; remainingCents: number; locked: boolean }
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
  const [exceptions, setExceptions] = useState<Array<{ id: string; kind: string; table: string | null; amountCents: number; detail: string }>>([]);
  const [products, setProducts] = useState<Array<{ id: string; name: string }>>([]);
  const [addFor, setAddFor] = useState<string | null>(null);
  const [pick, setPick] = useState({ productId: "", qty: "1" });
  const load = useCallback(async () => {
    const r = await staffFetch("/api/tabs");
    if ("res" in r && r.res.ok) setTabs(((await r.res.json()) as { tabs: TabRow[] }).tabs);
    const ex = await staffFetch("/api/tabs/exceptions");
    if ("res" in ex && ex.res.ok) setExceptions(((await ex.res.json()) as { exceptions: typeof exceptions }).exceptions);
    if (open) { const d = await staffFetch(`/api/tabs/${open}`); if ("res" in d && d.res.ok) setDetail((await d.res.json()) as TabDetail); }
  }, [open]);
  useEffect(() => { void fetch("/api/catalog").then((r) => (r.ok ? r.json() : null)).then((c: { products?: Array<{ id: string; name: string }> } | null) => setProducts((c?.products ?? []).map((p) => ({ id: p.id, name: p.name })))).catch(() => undefined); }, []);
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
      <div className="row"><button className="secondary sm" onClick={() => void (async () => { const r = await staffFetch("/api/tabs", { method: "POST", body: {} }); if ("res" in r && r.res.ok) { const j = (await r.res.json()) as { code: string }; setMsg(`Bar tab opened. Tell the customers the code: ${j.code}`); void load(); } else setMsg("problem" in r ? r.problem : "Could not open a bar tab. Is the tab switched on for this outlet?"); })()}>Open a bar tab</button></div>
      {exceptions.map((e) => (
        <div className="flash warn" key={e.id} role="alert">{e.kind === "duplicate_payment" ? "Possible double payment" : "A payment succeeded that the tab had released"}{e.table ? ` · ${e.table}` : ""} · {formatMoney(e.amountCents)}. {e.detail}
          <button className="secondary sm" style={{ marginLeft: 8 }} onClick={() => { const resolution = window.prompt("How was it resolved (for example, refunded on the provider dashboard)?"); if (resolution) void act(`/api/tabs/exceptions/${e.id}/resolve`, { resolution }, "Resolved."); }}>Resolve</button></div>
      ))}
      {tabs.length === 0 && <p className="muted">No open tabs.</p>}
      {tabs.map((t) => (
        <div className="e2e-card" key={t.id} style={{ marginBottom: 10 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <b style={{ flex: 1 }}>{t.spot ?? "Bar tab"} <span className="muted">· {t.code} · {t.people} {t.people === 1 ? "person" : "people"}</span></b>
            <span>{formatMoney(t.remainingCents)} <span className="muted">of {formatMoney(t.totalCents)}</span></span>
          </div>
          {(t.waiterPaged || t.billRequested) && <div className="flash warn">{t.billRequested ? "Asked for the bill." : "Called for help."} {t.waiterPaged && !t.pageAcknowledged && <button className="primary sm" onClick={() => void act(`/api/tabs/${t.id}/ack-page`, {}, "Page acknowledged.")}>On my way</button>} {t.pageAcknowledged && <span className="muted">Someone is on the way. </span>}<button className="secondary sm" onClick={() => void act(`/api/tabs/${t.id}/reset-page`, {}, "Page reset.")}>Reset page</button></div>}
          <div className="row">
            <button className={t.locked ? "primary sm" : "secondary sm"} onClick={() => void act(`/api/tabs/${t.id}/release`, {}, "Payment released.")}>{t.locked ? "Release payment" : "Release new rounds"}</button>
            <button className="secondary sm" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? "Hide payments" : "Payments"}</button>
            <button className="secondary sm" onClick={() => setAddFor(addFor === t.id ? null : t.id)}>Add items</button>
            <button className="secondary sm" onClick={() => { const reason = window.prompt("Close this tab without it being fully paid. Why?"); if (reason) void act(`/api/tabs/${t.id}/close`, { reason }, "Tab closed."); }}>Close tab</button>
          </div>
          {addFor === t.id && (
            <div className="row" style={{ marginTop: 6 }}>
              <select value={pick.productId} onChange={(e) => setPick({ ...pick, productId: e.target.value })} aria-label="Item"><option value="">Choose an item…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <input style={{ width: 60 }} inputMode="numeric" value={pick.qty} onChange={(e) => setPick({ ...pick, qty: e.target.value.replace(/\D/g, "") })} aria-label="How many" />
              <button className="primary sm" disabled={!pick.productId || !Number(pick.qty)} onClick={() => void act(`/api/tabs/${t.id}/items`, { items: [{ productId: pick.productId, qty: Number(pick.qty) }] }, "Added to the tab as a Staff round.").then(() => setPick({ productId: "", qty: "1" }))}>Add to the tab</button>
            </div>
          )}
          {open === t.id && detail && (
            <div style={{ marginTop: 8 }}>
              {detail.payments.length === 0 && <p className="muted">No payments yet.</p>}
              {detail.payments.map((p) => (
                <div className="row" key={p.id} style={{ alignItems: "center" }}>
                  <span style={{ flex: 1 }}>{p.payer.name}{p.for ? ` for ${p.for.name}` : ""} · {p.method}{p.staffRecorded ? " · staff" : ""} · {p.status}</span>
                  <b>{formatMoney(p.amountCents)}</b>
                  {p.status === "reserved" && <button className="primary sm" onClick={() => void act(`/api/tabs/payments/${p.id}/confirm`, {}, "Payment confirmed.")}>Confirm paid</button>}
                  {p.status === "unknown" && <button className="secondary sm" onClick={() => { const reference = window.prompt("Record the manual payment's trace or reference number. If the card payment later succeeds, you will be told so it can be refunded."); if (reference) void act(`/api/tabs/payments/${p.id}/manual`, { reference }, "Recorded as a manual payment."); }}>Record manually</button>}
                  {p.status === "completed" && <button className="secondary sm" onClick={() => { const amount = window.prompt(`Refund how much (S$, up to ${formatMoney(p.amountCents)})?`); const reason = amount ? window.prompt("Why?") : null; if (amount && reason) void act(`/api/tabs/payments/${p.id}/refund`, { amountCents: Math.round(Number(amount) * 100), reason }, "Refund recorded. Rewards it earned were reversed."); }}>Refund</button>}
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
