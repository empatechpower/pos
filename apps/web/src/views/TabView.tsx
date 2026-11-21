import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { formatMoney } from "@pos/core";
import { tx } from "../shopI18n";
import "../tab.css";

/**
 * Table service on the phone (Spec 12 and 13): the shared Tab, Split & Pay, and the logo-bell that pages the waiter. Everything that moves money is
 * decided by the shop's server; this only asks, shows the frozen quote, and shows what happened. Nobody can pay "as" someone else.
 */

export interface TabSession { tabId: string; participantId: string; token: string }

export interface TabView {
  id: string; spot: string | null; code: string; outletId: string; status: "open" | "closed"; version: number;
  host: { id: string; name: string | null };
  people: Array<{ id: string; name: string; isHost: boolean; isMe: boolean; left: boolean; member: boolean }>;
  coupons: Array<{ id: string; title: string; amountCents: number; owner: { id: string; name: string | null }; mine: boolean }>;
  couponOptions: Array<{ id: string; title: string; amountCents: number; eligible: boolean; reason: string | null }>;
  totals: { discountCents: number; totalCents: number; paidCents: number; remainingCents: number; itemsCents: number; serviceCents: number; taxCents: number; depositCents: number; taxIncludedCents: number };
  paymentLocked: boolean; lockNote: string; released: boolean;
  rounds: Array<{
    round: number; orderId: string; orderedBy: { id: string; name: string | null }; at: string; locked: boolean; kitchen: string; staffAdded?: boolean;
    lines: Array<{ lineId: string; productId: string; name: string; qty: number; unitCents: number; options: string[]; deposit: boolean; owner: { id: string; name: string | null }; sharedWith: Array<{ id: string; name: string | null }>; units: number; paidUnits: number; reservedUnits: number; paidBy: string[] }>;
  }>;
  payments: Array<{ id: string; pointsUsed: number; payer: { id: string; name: string | null }; for: { id: string; name: string | null } | null; amountCents: number; status: string; method: string; mode: string; staffRecorded: boolean; hostKeep: boolean; at: string }>;
  billRequested: boolean; waiterPaged: boolean; pagedKind: string | null; pageAcknowledged?: boolean;
  me: { id: string; name: string; memberId: string | null; owesCents: number; paidCents: number; pendingPoints: number; earnedPoints?: number; pointsBalance: number | null } | null;
  closed: boolean; pendingRewardsNote: string | null; customAllocation: "oldest_first" | "reduce_only";
}

const key = (outlet: string | undefined, spot: string) => `rezein.tab:${outlet ?? ""}:${spot}`;

export function loadTabSession(outlet: string | undefined, spot: string): TabSession | null {
  try { const j = JSON.parse(localStorage.getItem(key(outlet, spot)) ?? "null") as TabSession & { at?: number } | null; return j && j.participantId && j.token && j.tabId ? j : null; } catch { return null; }
}
const saveSession = (outlet: string | undefined, spot: string, s: TabSession | null) => { try { if (s) localStorage.setItem(key(outlet, spot), JSON.stringify({ ...s, at: Date.now() })); else localStorage.removeItem(key(outlet, spot)); } catch { /* storage may be blocked */ } };

/** Other tabs this phone is on (One active Tab per phone: joining a second table asks whether to leave the first). */
export function otherTabSessions(outlet: string | undefined, spot: string): Array<{ spot: string; session: TabSession; storageKey: string }> {
  const out: Array<{ spot: string; session: TabSession; storageKey: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? "";
      if (!k.startsWith("rezein.tab:") || k === key(outlet, spot)) continue;
      const j = JSON.parse(localStorage.getItem(k) ?? "null") as TabSession | null;
      if (j?.participantId && j.token) out.push({ spot: k.split(":").slice(2).join(":"), session: j, storageKey: k });
    }
  } catch { /* storage may be blocked */ }
  return out;
}

/** Leave every other tab (leaving never loses paid history) so this phone is on one tab only. */
export async function leaveOtherTabs(outlet: string | undefined, spot: string): Promise<void> {
  for (const o of otherTabSessions(outlet, spot)) {
    await tabCall(o.session, "/api/shop/tab/leave", { body: {} });
    try { localStorage.removeItem(o.storageKey); } catch { /* ignore */ }
  }
}

const headers = (s: TabSession): Record<string, string> => ({ "x-tab-participant": s.participantId, "x-tab-token": s.token });

export async function tabCall<T = Record<string, any>>(s: TabSession | null, path: string, init: { method?: string; body?: unknown; bearer?: string | null } = {}): Promise<{ status: number; json: T }> {
  const r = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(s ? headers(s) : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }).catch(() => null);
  if (!r) return { status: 0, json: {} as T };
  return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
}

/** The tab this phone is on at this table: its credential, and the live view (refreshed while the page is open). */
export function useTab(outletId: string | undefined, spot: string, enabled: boolean, bearer: string | null) {
  const [session, setSession] = useState<TabSession | null>(() => (enabled && spot ? loadTabSession(outletId, spot) : null));
  const [view, setView] = useState<TabView | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSession(enabled && spot ? loadTabSession(outletId, spot) : null); }, [outletId, spot, enabled]);

  const refresh = useCallback(async () => {
    if (!session) { setView(null); return; }
    const r = await tabCall<TabView & { error?: string }>(session, "/api/shop/tab", { bearer });
    if (!alive.current) return;
    if (r.status === 401) { saveSession(outletId, spot, null); setSession(null); setView(null); return; }
    if (r.status === 200) setView(r.json);
  }, [session, outletId, spot, bearer]);

  useEffect(() => {
    void refresh();
    if (!session) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 4000);
    return () => window.clearInterval(t);
  }, [session, refresh]);

  const join = useCallback(async (displayName: string): Promise<boolean> => {
    const prev = loadTabSession(outletId, spot);
    const r = await tabCall<{ tabId: string; participantId: string; token: string; tab: TabView }>(null, "/api/shop/tab/join", { body: { outletId, table: spot, displayName, ...(prev ? { participantId: prev.participantId, token: prev.token } : {}) }, bearer });
    if (r.status !== 200) return false;
    const s = { tabId: r.json.tabId, participantId: r.json.participantId, token: r.json.token };
    saveSession(outletId, spot, s);
    setSession(s);
    setView(r.json.tab);
    return true;
  }, [outletId, spot, bearer]);

  return { session, view, refresh, join };
}

// ---- joining -----------------------------------------------------------------------------------

/** Joining asks only a display name (a signed-in member's is already filled in). No login. */
export function JoinTabSheet({ spot, memberName, onJoin, busy, failed }: { spot: string; memberName?: string | null; onJoin: (name: string) => void; busy: boolean; failed: boolean }) {
  const [name, setName] = useState(memberName ?? "");
  return (
    <div className="tbl-back" role="dialog" aria-label={tx("Join the table")}>
      <div className="tbl-dlg">
        <h3>{tx("Join {t}", { t: spot })}</h3>
        <p className="muted">{tx("Everyone at the table shares one bill. What is your name? Leave it empty to join as a guest.")}</p>
        <input className="e2e-input" value={name} maxLength={30} placeholder={tx("Your name")} aria-label={tx("Your name")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) onJoin(name); }} />
        {failed && <p className="e2e-note" role="alert">{tx("Could not join the table. Please try again.")}</p>}
        <button className="shop-primary" disabled={busy} onClick={() => onJoin(name)}>{busy ? tx("Joining…") : tx("Join the table")}</button>
      </div>
    </div>
  );
}

// ---- the logo that is also a bell ----------------------------------------------------------------

/**
 * Table service only: the header logo flips to a bell every ~3 seconds, with a "Page the Waiter" pill. A tap pages the waiter ("Request the bill" or
 * "Call waiter for help"). Once paged it stays "Waiter paged" until staff reset it. No auto-timeout. Reduced-motion turns the animation off.
 */
export function PageBell({ logo, view, session, onPaged }: { logo: ReactNode; view: TabView | null; session: TabSession | null; onPaged: () => void }) {
  const [open, setOpen] = useState(false);
  const paged = !!view?.waiterPaged;
  async function page(kind: "bill" | "help") {
    setOpen(false);
    await tabCall(session, "/api/shop/tab/page", { body: { kind } });
    onPaged();
  }
  return (
    <>
      <button className={`pw ${paged ? "paged" : ""}`} onClick={() => !paged && setOpen(true)} aria-label={paged ? tx("Waiter paged") : tx("Page the Waiter")}>
        <span className="pw-logo">{logo}</span>
        <span className="pw-bell" aria-hidden="true">
          <span className="pw-badge"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg></span>
          <span className="pw-pill">{paged ? (view?.pageAcknowledged ? tx("Waiter is on the way") : tx("Waiter paged")) : tx("Page the Waiter")}</span>
        </span>
      </button>
      {open && (
        <div className="tbl-back" role="dialog" aria-label={tx("Page the waiter")} onClick={() => setOpen(false)}>
          <div className="tbl-dlg" onClick={(e) => e.stopPropagation()}>
            <h3>{tx("Page the waiter")}</h3>
            <button className="shop-primary" onClick={() => void page("bill")}>{tx("Request the bill")}</button>
            <button className="secondary" style={{ marginTop: 8 }} onClick={() => void page("help")}>{tx("Call waiter for help")}</button>
            <button className="shop-link" onClick={() => setOpen(false)}>{tx("Cancel")}</button>
          </div>
        </div>
      )}
    </>
  );
}

// ---- the Tab screen --------------------------------------------------------------------------------

export function TabScreen({ view, session, bearer, creditCents, rewardsOn, onBack, onAddMore, onChanged }: {
  view: TabView; session: TabSession; bearer: string | null; creditCents: number; rewardsOn: boolean;
  onBack: () => void; onAddMore: () => void; onChanged: () => void;
}) {
  const [splitOpen, setSplitOpen] = useState(false);
  const [sharing, setSharing] = useState<TabView["rounds"][number]["lines"][number] | null>(null);
  const [pageOpen, setPageOpen] = useState(false);
  const rem = view.totals.remainingCents;
  const open = view.status === "open" && rem > 0;
  const jump = () => document.getElementById("tab-pay-area")?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <div className="tab-screen">
      <div className="tab-top">
        <button className="e2e-back" onClick={onBack}>‹ {tx("Back")}</button>
        {open && <button className="tab-jump" onClick={jump}>{tx("Split & Pay")} ⌄</button>}
      </div>

      <div className="e2e-card">
        <h3>{view.spot ?? tx("Bar tab")} · {tx("Table service")}</h3>
        <div className="muted">{tx("Check-in code")}: <b className="tab-code">{view.code}</b></div>
        <div className="tab-people">
          {view.people.filter((p) => !p.left || p.isMe).map((p) => <span key={p.id} className={`tab-chip ${p.isMe ? "me" : ""}`}>{p.name}{p.isHost ? ` · ${tx("Host")}` : ""}{p.isMe ? ` · ${tx("you")}` : ""}</span>)}
        </div>
      </div>

      <div className="e2e-card tab-totals">
        <div className="tab-tot-row"><span>{tx("Tab total")}</span><b>{formatMoney(view.totals.totalCents)}</b></div>
        {view.totals.discountCents > 0 && <div className="tab-tot-row"><span>{tx("Includes coupon")}</span><b>−{formatMoney(view.totals.discountCents)}</b></div>}
        <div className="tab-tot-row"><span>{tx("Paid")}</span><b>{formatMoney(view.totals.paidCents)}</b></div>
        <div className="tab-tot-row tab-rem"><span>{tx("Remaining")}</span><b>{formatMoney(rem)}</b></div>
        {view.totals.serviceCents > 0 && <div className="muted tab-break">{tx("Items")} {formatMoney(view.totals.itemsCents)} · {tx("Service")} {formatMoney(view.totals.serviceCents)}{view.totals.taxCents > 0 ? ` · ${tx("Tax")} ${formatMoney(view.totals.taxCents)}` : ""}{view.totals.depositCents > 0 ? ` · ${tx("Deposit")} ${formatMoney(view.totals.depositCents)}` : ""}</div>}
      </div>

      <TabCoupons view={view} session={session} bearer={bearer} onChanged={onChanged} />

      {rewardsOn && view.pendingRewardsNote && (
        <div className="e2e-card tab-reward">
          <b>{tx("Pending reward")}: {view.me?.pendingPoints ?? 0} {tx("points")}</b>
          <div className="muted">{tx(view.pendingRewardsNote)}</div>
        </div>
      )}
      {view.closed && <div className="e2e-card tab-closed"><b>{tx("Fully paid ✓ — this tab is closed")}</b></div>}
      {rewardsOn && view.closed && (view.me?.earnedPoints ?? 0) > 0 && (
        <div className="e2e-card tab-reward" role="status">
          <b>{tx("Rewards earned")}: {(view.me?.earnedPoints ?? 0).toLocaleString()} {tx("points")}</b>
          <div className="muted">{tx(view.me?.memberId ? "Credited to your account." : "Sign up to keep these points.")}</div>
        </div>
      )}

      {view.rounds.map((r) => (
        <div className="e2e-card" key={r.orderId}>
          <h3>{tx("Round {n}", { n: r.round })} <span className="muted">· {r.staffAdded ? tx("Added by staff") : r.orderedBy.name} · {r.kitchen}{r.locked && view.released ? ` · ${tx("Locked until the waiter releases it")}` : ""}</span></h3>
          {r.staffAdded && view.people.find((p) => p.isMe)?.isHost && open && r.lines.every((l) => l.paidUnits + l.reservedUnits === 0) && <button className="secondary sm" onClick={() => void tabCall(session, "/api/shop/tab/claim-staff-items", { method: "POST", body: {} }).then(onChanged)}>{tx("Add these to my share")}</button>}
          {r.lines.map((l) => {
            const unpaid = l.units - l.paidUnits - l.reservedUnits;
            const state = l.paidUnits === l.units ? `${tx("Paid by")} ${l.paidBy.join(", ")}` : r.staffAdded && l.paidUnits + l.reservedUnits === 0 ? tx("Unclaimed") : l.reservedUnits > 0 ? tx("Locked (someone is paying)") : l.paidUnits > 0 ? `${l.paidUnits} ${tx("paid")}, ${unpaid} ${tx("unpaid")}` : tx("Unpaid");
            return (
              <div className="sum-row tab-line" key={l.lineId}>
                <span className="k">
                  {l.name} × {l.qty}
                  {l.options.length > 0 && <small className="muted" style={{ display: "block" }}>{l.options.join(" · ")}</small>}
                  <small className="muted" style={{ display: "block" }}><span className={`tab-chip ${r.staffAdded ? "staff" : ""}`}>{r.staffAdded ? tx("Staff") : l.owner.name}</span>{l.sharedWith.length > 1 ? ` ${tx("shared")}: ${l.sharedWith.map((x) => x.name).join(", ")}` : ""} · {state}</small>
                  {open && l.paidUnits + l.reservedUnits === 0 && <button className="shop-link tab-share" onClick={() => setSharing(l)}>{tx("Share this item")}</button>}
                </span>
                <span className="v">{formatMoney(l.unitCents * l.qty)}</span>
              </div>
            );
          })}
        </div>
      ))}

      {view.payments.length > 0 && (
        <div className="e2e-card">
          <h3>{tx("Payments")}</h3>
          {view.payments.map((p) => (
            <div className="sum-row" key={p.id}>
              <span className="k">{p.status === "completed" ? tx("Paid by {n}", { n: p.payer.name ?? "" }) : p.status === "unknown" ? tx("Checking…") : tx("Paying…")}{p.pointsUsed > 0 ? ` · ${p.pointsUsed.toLocaleString()} ${tx("points")}` : ""}{p.for ? ` ${tx("for {n}", { n: p.for.name ?? "" })}` : ""}{p.staffRecorded ? ` · ${tx("recorded by staff")}` : ""}{p.hostKeep ? ` · ${tx("reward to the host")}` : ""}</span>
              <span className="v">{formatMoney(p.amountCents)}</span>
            </div>
          ))}
        </div>
      )}

      {!view.closed && (
        <div className="tab-actions" id="tab-pay-area">
          <button className="secondary" onClick={onAddMore}>{tx("Add More")}</button>
          <button className="shop-primary" disabled={!open || view.paymentLocked} onClick={() => setSplitOpen(true)}>{tx("Split & Pay")}</button>
          <button className="secondary" onClick={() => setPageOpen(true)}>{tx("Call staff")}</button>
        </div>
      )}
      {view.paymentLocked && !view.closed && <p className="e2e-note tab-lock" role="status">{view.lockNote}</p>}

      {sharing && <ShareSheet line={sharing} view={view} session={session} onClose={() => setSharing(null)} onDone={() => { setSharing(null); onChanged(); }} />}
      {splitOpen && <SplitPaySheet view={view} session={session} bearer={bearer} creditCents={creditCents} rewardsOn={rewardsOn} onClose={() => { setSplitOpen(false); onChanged(); }} />}
      {pageOpen && (
        <div className="tbl-back" role="dialog" onClick={() => setPageOpen(false)}>
          <div className="tbl-dlg" onClick={(e) => e.stopPropagation()}>
            <h3>{tx("Call staff")}</h3>
            <button className="shop-primary" disabled={view.waiterPaged} onClick={() => void tabCall(session, "/api/shop/tab/page", { body: { kind: "help" } }).then(() => { setPageOpen(false); onChanged(); })}>{view.waiterPaged ? tx("Waiter paged") : tx("Call waiter for help")}</button>
            <button className="shop-link" onClick={() => setPageOpen(false)}>{tx("Close")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- coupons on the tab -----------------------------------------------------------------------------

/**
 * Any person on the tab can apply their own coupon to the shared bill (D3). The card says why one cannot be used, in its own row: the minimum is on
 * the items only, before service charge and tax, deposits excluded. Only its owner takes it off, and only before anyone has paid.
 */
function TabCoupons({ view, session, bearer, onChanged }: { view: TabView; session: TabSession; bearer: string | null; onChanged: () => void }) {
  const [err, setErr] = useState("");
  if (view.closed || (view.coupons.length === 0 && (!bearer || view.couponOptions.length === 0))) return null;
  return (
    <div className="e2e-card">
      <h3>{tx("Coupons")}</h3>
      {view.coupons.map((c) => (
        <div className="sum-row" key={c.id}>
          <span className="k">{c.title}<small className="muted" style={{ display: "block" }}>{tx("Applied by {n}. Shared between the payers.", { n: c.owner.name ?? "" })}</small></span>
          <span className="v">−{formatMoney(c.amountCents)}{c.mine && <> <button className="shop-link" onClick={() => void tabCall(session, `/api/shop/tab/coupons/${c.id}`, { method: "DELETE" }).then((r) => { setErr(r.status === 200 ? "" : tx("A coupon cannot come off once someone has paid.")); onChanged(); })}>{tx("Remove")}</button></>}</span>
        </div>
      ))}
      {bearer && view.couponOptions.map((o) => (
        <div className={`sum-row ${o.eligible ? "" : "tab-coupon-off"}`} key={o.id}>
          <span className="k">{o.title} · {formatMoney(o.amountCents)}{o.reason && <small className="muted" style={{ display: "block" }}>{o.reason}</small>}</span>
          <button className="secondary sm" disabled={!o.eligible} onClick={() => void tabCall(session, "/api/shop/tab/coupons", { body: { couponId: o.id }, bearer }).then((r) => { setErr(r.status === 200 ? "" : r.json.message ?? tx("That coupon cannot be used here.")); onChanged(); })}>{tx("Apply")}</button>
        </div>
      ))}
      {err && <p className="e2e-note" role="alert">{err}</p>}
    </div>
  );
}

// ---- share one line between people --------------------------------------------------------------------

function ShareSheet({ line, view, session, onClose, onDone }: { line: TabView["rounds"][number]["lines"][number]; view: TabView; session: TabSession; onClose: () => void; onDone: () => void }) {
  const here = view.people.filter((p) => !p.left);
  const [picked, setPicked] = useState<string[]>(line.sharedWith.length > 1 ? line.sharedWith.map((x) => x.id) : [line.owner.id]);
  const [err, setErr] = useState("");
  return (
    <div className="tbl-back" role="dialog" aria-label={tx("Share this item")} onClick={onClose}>
      <div className="tbl-dlg" onClick={(e) => e.stopPropagation()}>
        <h3>{tx("Share this item")}</h3>
        <p className="muted">{line.name} · {formatMoney(line.unitCents * line.qty)}. {tx("Choose who shares it. The cost is split between them.")}</p>
        {here.map((p) => (
          <label key={p.id} className="inline"><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /> {p.name}{p.isMe ? ` (${tx("you")})` : ""}</label>
        ))}
        {err && <p className="e2e-note" role="alert">{err}</p>}
        <button className="shop-primary" disabled={picked.length < 1} onClick={() => void (async () => {
          const r = await tabCall(session, `/api/shop/tab/lines/${encodeURIComponent(line.lineId)}/share`, { body: { with: picked.length > 1 ? picked : [] } });
          if (r.status === 200) onDone(); else setErr(tx("That item cannot be shared any more."));
        })()}>{picked.length > 1 ? tx("Share between {n}", { n: picked.length }) : tx("Not shared")}</button>
        <button className="shop-link" onClick={onClose}>{tx("Cancel")}</button>
      </div>
    </div>
  );
}

// ---- Split & Pay ---------------------------------------------------------------------------------------

interface Quote { quoteId: string; amountCents: number; lines: Array<{ lineId: string; name: string; units: number; items: number; deposit: number }>; itemsCents: number; serviceCents: number; taxCents: number; depositCents: number; creditAppliedCents: number; discountCents: number; pointsUsed: number; liabilityCents: number; tabTotalCents: number }
type Mode = "mine" | "equal" | "round" | "custom" | "all";

/**
 * The five ways to pay: Pay mine, Split equally, By round, Custom amount, Pay remaining. After choosing, the payer sees only their share's maths in
 * the standard Bag format, then pays against that frozen quote. If the tab changed meanwhile the server rejects it and a new quote is shown; the
 * payer confirms it. The payer is always whoever is on this phone: paying for someone else is attributed to the payer.
 */
function SplitPaySheet({ view, session, bearer, creditCents, rewardsOn, onClose }: { view: TabView; session: TabSession; bearer: string | null; creditCents: number; rewardsOn: boolean; onClose: () => void }) {
  const me = view.people.find((p) => p.isMe);
  const here = view.people.filter((p) => !p.left);
  const [mode, setMode] = useState<Mode | null>(null);
  const [forId, setForId] = useState<string | null>(null);
  const [people, setPeople] = useState(Math.max(1, here.length));
  const [round, setRound] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [method, setMethod] = useState<"counter" | "credit">("counter");
  const [hostKeep, setHostKeep] = useState(false);
  // Personal points against my own share (12.7): off, as many as possible, or an amount I type. One point is one cent; the minimum claim is 100.
  const [pts, setPts] = useState<"off" | "max" | "custom">("off");
  const [ptsAmount, setPtsAmount] = useState("");
  const balance = view.me?.pointsBalance ?? 0;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null); // a payment waiting for staff to confirm
  const reservedByMe = view.payments.some((p) => (p.status === "reserved" || p.status === "unknown") && (p.payer.id === me?.id));

  const params = (): Record<string, unknown> | null => {
    const points = rewardsOn && balance > 0 && pts !== "off" ? { usePoints: pts === "max" ? "max" : Math.floor(Number(ptsAmount)) || 0 } : {};
    if (mode === "mine") return { mode, ...(forId && forId !== me?.id ? { forParticipantId: forId } : {}), ...points };
    if (mode === "equal") return { mode, people, ...points };
    if (mode === "round") return round ? { mode, round, ...points } : null;
    if (mode === "custom") { const c = Math.round(Number(amount) * 100); return Number.isFinite(c) && c > 0 ? { mode, amountCents: c, ...points } : null; }
    if (mode === "all") return { mode, ...points };
    return null;
  };

  useEffect(() => {
    setQuote(null); setNotice("");
    const p = params();
    if (!p) return;
    let live = true;
    const t = window.setTimeout(() => void tabCall<Quote & { error?: string; message?: string }>(session, "/api/shop/tab/quote", { body: p, bearer }).then((r) => {
      if (!live) return;
      if (r.status === 200) setQuote(r.json); else setNotice(r.json.error === "nothing_to_pay_for_this" || r.json.error === "nothing_to_pay" ? tx("There is nothing left to pay for this.") : r.json.message ?? tx("Could not work that out. Please try again."));
    }), 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [mode, forId, people, round, amount, pts, ptsAmount]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pay() {
    if (!quote || busy) return;
    setBusy(true);
    const r = await tabCall<Record<string, any>>(session, "/api/shop/tab/pay", { body: { quoteId: quote.quoteId, method: quote.amountCents === 0 ? "counter" : method, idempotencyKey: `q-${quote.quoteId}`, hostKeep }, bearer });
    setBusy(false);
    if (r.status === 200) {
      if (r.json.status === "completed") { onClose(); return; }
      setWaiting(r.json.paymentId as string); // pay at the counter: staff confirm
      return;
    }
    if (r.status === 409 && (r.json.error === "quote_changed" || r.json.error === "quote_expired")) {
      if (r.json.quote) { setQuote(r.json.quote as Quote); setNotice(tx("The bill changed while you were choosing. The new amount is {amt}. Tap Pay to confirm it.", { amt: formatMoney((r.json.quote as Quote).amountCents) })); } else { setQuote(null); setNotice(tx("The bill changed and there is nothing left to pay for this.")); }
      return;
    }
    const e = r.json.error as string | undefined;
    setNotice(e === "not_enough_credit" ? tx("Your credit is not enough for this.") : e === "not_enough_points" ? tx("You do not have enough points for this any more.") : e === "payment_in_flight" || e === "already_being_paid" ? tx("Someone is already paying for this share.") : e === "provider_unavailable" ? tx("Card and PayNow are not available yet.") : e === "payment_locked" ? view.lockNote : tx("The payment could not be started. Please try again."));
  }

  async function cancelWaiting() {
    if (waiting) await tabCall(session, `/api/shop/tab/payments/${waiting}/cancel`, { method: "POST", body: {} });
    setWaiting(null); setQuote(null);
  }

  // A counter payment is done when staff confirm it: the tab view shows it paid.
  useEffect(() => {
    if (!waiting) return;
    const p = view.payments.find((x) => x.id === waiting);
    if (p?.status === "completed") onClose();
  }, [view.payments, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = here.filter((p) => !p.isMe).map((p) => {
    const pay = view.payments.find((x) => (x.for?.id ?? x.payer.id) === p.id && x.mode !== "equal" && (x.status === "reserved" || x.status === "unknown" || x.status === "completed"));
    return { p, state: pay ? (pay.status === "completed" ? `${tx("Paid by")} ${pay.payer.name}` : tx("Paying…")) : tx("Waiting") };
  });

  const modes: Array<[Mode, string, string]> = [["mine", tx("Pay mine"), tx("My items and my share")], ["equal", tx("Split equally"), tx("What is left, divided between us")], ["round", tx("By round"), tx("Pay one round")], ["custom", tx("Custom amount"), tx("Type an amount")], ["all", tx("Pay remaining"), tx("The whole bill")]];

  return (
    <div className="tbl-back" role="dialog" aria-label={tx("Split & Pay")}>
      <div className="tbl-dlg tab-split" style={{ maxHeight: "92dvh", overflow: "auto" }}>
        <h3>{tx("Split & Pay")}</h3>
        <p className="muted">{tx("Remaining")}: <b>{formatMoney(view.totals.remainingCents)}</b></p>

        {waiting ? (
          <>
            <p className="e2e-note" role="status">{tx("Please pay at the counter. Staff will confirm, and this closes on its own.")}</p>
            <button className="secondary" onClick={() => void cancelWaiting()}>{tx("Cancel this payment")}</button>
          </>
        ) : (
          <>
            {reservedByMe && <p className="e2e-note" role="status">{tx("Paying…")} {tx("A payment of yours is already in progress.")}</p>}
            <div className="tab-modes">
              {modes.map(([m, title, sub]) => <button key={m} className={`pay-opt ${mode === m ? "on" : ""}`} aria-pressed={mode === m} disabled={reservedByMe} onClick={() => { setMode(m); setForId(null); }}><span className="pt"><b>{title}</b><span>{sub}</span></span><span className="radio" /></button>)}
            </div>

            {mode === "mine" && rows.length > 0 && (
              <div className="e2e-card">
                <h4>{tx("Everyone's share")}</h4>
                {rows.map(({ p, state }) => (
                  <div className="sum-row" key={p.id}><span className="k">{p.name}<small className="muted" style={{ display: "block" }}>{state}</small></span>
                    {state === tx("Waiting") && <button className="secondary sm" disabled={reservedByMe} onClick={() => setForId(forId === p.id ? null : p.id)}>{forId === p.id ? tx("Back to mine") : tx("I pay {n}'s share myself", { n: p.name })}</button>}
                  </div>
                ))}
              </div>
            )}
            {mode === "equal" && (
              <div className="e2e-card"><span className="k">{tx("People splitting")}</span>
                <span className="opt-step"><button onClick={() => setPeople(Math.max(1, people - 1))} aria-label={tx("Fewer")}>−</button><b>{people}</b><button onClick={() => setPeople(Math.min(30, people + 1))} aria-label={tx("More")}>+</button></span>
              </div>
            )}
            {mode === "round" && (
              <div className="tab-rounds">{view.rounds.filter((r) => !r.locked).map((r) => <button key={r.round} className={`chip ${round === r.round ? "on" : ""}`} onClick={() => setRound(r.round)}>{tx("Round {n}", { n: r.round })}</button>)}</div>
            )}
            {mode === "custom" && (
              <div className="e2e-card"><input className="e2e-input" inputMode="decimal" placeholder={tx("Amount, e.g. 10.00")} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} aria-label={tx("Amount")} />
                <p className="muted" style={{ fontSize: 12 }}>{view.customAllocation === "oldest_first" ? tx("The amount pays off items, oldest round first.") : tx("The amount only reduces what remains.")}</p></div>
            )}

            {rewardsOn && balance > 0 && mode && !reservedByMe && (
              <div className="e2e-card">
                <b>{tx("Use my points")}</b> <span className="muted">· {balance.toLocaleString()} {tx("pts")}</span>
                <div className="tab-rounds">
                  <button className={`chip ${pts === "off" ? "on" : ""}`} onClick={() => setPts("off")}>{tx("Not now")}</button>
                  <button className={`chip ${pts === "max" ? "on" : ""}`} onClick={() => setPts("max")}>{tx("Redeem maximum")}</button>
                  <button className={`chip ${pts === "custom" ? "on" : ""}`} onClick={() => setPts("custom")}>{tx("Edit amount")}</button>
                </div>
                {pts === "custom" && <input className="e2e-input" inputMode="numeric" placeholder={tx("Points, 100 or more")} value={ptsAmount} onChange={(e) => setPtsAmount(e.target.value.replace(/\D/g, ""))} aria-label={tx("Points to use")} />}
                <p className="muted" style={{ fontSize: 12 }}>{tx("100 points = S$1. Points only pay your own share, and never anyone else's.")}</p>
              </div>
            )}

            {quote && (
              <div className="e2e-card tab-quote">
                <h4>{forId && forId !== me?.id ? tx("{n}'s share", { n: view.people.find((p) => p.id === forId)?.name ?? "" }) : tx("Your share")}</h4>
                {quote.lines.map((l) => <div className="sum-row" key={l.lineId}><span className="k">{l.name} × {l.units}</span><span className="v">{formatMoney(l.items)}</span></div>)}
                {quote.lines.length === 0 && <div className="sum-row"><span className="k">{tx("Toward the bill")}</span><span className="v">{formatMoney(quote.amountCents)}</span></div>}
                {quote.serviceCents > 0 && <div className="sum-row"><span className="k">{tx("Service charge")}</span><span className="v">{formatMoney(quote.serviceCents)}</span></div>}
                {quote.taxCents > 0 && <div className="sum-row"><span className="k">{tx("Tax")}</span><span className="v">{formatMoney(quote.taxCents)}</span></div>}
                {quote.depositCents > 0 && <div className="sum-row"><span className="k">{tx("Deposit")}</span><span className="v">{formatMoney(quote.depositCents)}</span></div>}
                {quote.discountCents > 0 && <div className="sum-row neg"><span className="k">{tx("Your part of the coupon")}</span><span className="v">−{formatMoney(quote.discountCents)}</span></div>}
                {quote.creditAppliedCents > 0 && <div className="sum-row neg"><span className="k">{tx("Already paid toward the bill")}</span><span className="v">−{formatMoney(quote.creditAppliedCents)}</span></div>}
                {quote.pointsUsed > 0 && <div className="sum-row neg"><span className="k">{tx("Points")} · {quote.pointsUsed.toLocaleString()} {tx("pts")}</span><span className="v">−{formatMoney(quote.pointsUsed)}</span></div>}
                <div className="sum-row grand"><span className="k">{tx("To pay")}</span><span className="v">{formatMoney(quote.amountCents)}{quote.amountCents === 0 && quote.pointsUsed > 0 && <span className="tab-pill">{formatMoney(quote.liabilityCents)}</span>}</span></div>
              </div>
            )}
            {notice && <p className="e2e-note" role="alert">{notice}</p>}

            {quote && (
              <>
                <button className="pay-opt" aria-pressed={method === "counter"} onClick={() => setMethod("counter")}><span className="pt"><b>{tx("Pay at the counter")}</b><span>{tx("Staff confirm your payment")}</span></span><span className="radio" /></button>
                {bearer && <button className="pay-opt" aria-pressed={method === "credit"} disabled={creditCents < quote.amountCents} onClick={() => setMethod("credit")}><span className="pt"><b>{tx("Member credit")}</b><span>{formatMoney(creditCents)}</span></span><span className="radio" /></button>}
                <button className="pay-opt" disabled style={{ opacity: 0.5 }}><span className="pt"><b>{tx("Card or PayNow")}</b><span>{tx("Not available yet")}</span></span></button>
                {rewardsOn && me && view.host.id !== me.id && (
                  <label className="inline"><input type="checkbox" checked={hostKeep} onChange={(e) => setHostKeep(e.target.checked)} /> {tx("Let the host keep the reward")}</label>
                )}
                <button className="e2e-cta" disabled={busy || reservedByMe} onClick={() => void pay()}>
                  <span>{busy ? tx("Paying…") : quote.amountCents === 0 ? tx("Pay with points") : tx("Pay")} · {formatMoney(quote.amountCents)}</span>
                </button>
              </>
            )}
          </>
        )}
        <button className="shop-link" onClick={onClose}>{tx("Close")}</button>
      </div>
    </div>
  );
}
