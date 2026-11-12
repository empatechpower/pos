import { useCallback, useEffect, useRef, useState } from "react";
import { confirmedPaid, formatMoney, isFullyPaid, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { useOrders } from "../hooks";

const TZ = "Asia/Singapore";
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: TZ });
const STAGE: Record<string, string> = { open: "New", preparing: "Preparing", ready: "Ready", completed: "Collected", cancelled: "Cancelled" };
const METHOD: Record<string, string> = { cash: "Cash", card: "Card", paynow: "PayNow", credit: "Credit" };
const methodName = (m: string) => METHOD[m] ?? m;
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** Staff page for the shop: every order and payment, and the members' points and prepaid credit. No till. */
export function Manager({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const [tab, setTab] = useState<"orders" | "members">("orders");
  return (
    <div className="credit prices">
      <h2>Manager</h2>
      {!staff ? (
        <div className="flash">Sign in to see orders and manage members. <a href="#/login">Sign in</a></div>
      ) : (
        <>
          <div className="seg" style={{ display: "flex", gap: 8, margin: "4px 0 12px" }}>
            <button className={tab === "orders" ? "primary sm" : "secondary sm"} onClick={() => setTab("orders")}>Transactions</button>
            <button className={tab === "members" ? "primary sm" : "secondary sm"} onClick={() => setTab("members")}>Members</button>
          </div>
          {tab === "orders" ? <Transactions config={config} /> : <Members canAdjustPoints={staff.role !== "cashier"} />}
        </>
      )}
    </div>
  );
}

// ---- transactions -----------------------------------------------------------------------------

function Transactions({ config }: { config: BusinessConfig }) {
  const orders = useOrders();
  const [range, setRange] = useState<"today" | "yesterday" | "week" | "all">("today");
  const [find, setFind] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const now = Date.now();
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const weekAgo = now - 7 * 86_400_000;
  const needle = find.trim().toLowerCase();
  const shown = orders
    .filter((o) => o.lines.length)
    .filter((o) => (range === "today" ? dayKey(o.openedAt) === today : range === "yesterday" ? dayKey(o.openedAt) === yesterday : range === "week" ? o.openedAt >= weekAgo : true))
    .filter((o) => !needle || `${o.queueNumber ?? ""} ${o.customerPhone ?? ""} ${o.customerName ?? ""} ${o.spot ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => b.openedAt - a.openedAt);

  const live = shown.filter((o) => o.stage !== "cancelled");
  const totalOf = (o: OrderState) => orderTotals(o, config).total;
  const sales = live.reduce((n, o) => n + confirmedPaid(o), 0);
  const unpaid = live.filter((o) => !isFullyPaid(o, config));
  const owed = unpaid.reduce((n, o) => n + Math.max(0, totalOf(o) - confirmedPaid(o)), 0);
  const byMethod = new Map<string, number>();
  for (const o of live) for (const p of o.payments) if (p.confirmed) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountCents);
  const cancelled = shown.length - live.length;

  async function kitchen(o: OrderState) {
    setMsg(null);
    const r = await staffFetch("/api/print/reprint", { body: { orderId: o.orderId, docType: "kitchen" } });
    if ("problem" in r) return setMsg(r.problem);
    if (r.res.ok) return setMsg(`Kitchen ticket for ${o.queueNumber ?? "that order"} sent to the printer.`);
    const code = ((await r.res.json().catch(() => ({}))) as { error?: string }).error;
    setMsg(code === "no_printer_for_this" ? "No kitchen printer is set up for that order. Add one under Printers." : "Could not send that ticket. Try again.");
  }

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="Which days">
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">Last 7 days</option>
          <option value="all">Everything</option>
        </select>
        <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find by number, name or phone" style={{ flex: 1, minWidth: 180 }} />
      </div>
      {msg && <div className="flash">{msg}</div>}
      <div className="tab" style={{ display: "block" }}>
        <div><b>{live.length}</b> order{live.length === 1 ? "" : "s"}{cancelled > 0 && <span className="muted"> · {cancelled} cancelled</span>}</div>
        <div>Paid in: <b>{formatMoney(sales)}</b>{[...byMethod].length > 0 && <span className="muted"> ({[...byMethod].map(([m, c]) => `${methodName(m)} ${formatMoney(c)}`).join(" · ")})</span>}</div>
        <div>Not yet paid: <b>{formatMoney(owed)}</b> <span className="muted">on {unpaid.length} order{unpaid.length === 1 ? "" : "s"}</span></div>
      </div>
      {shown.length === 0 && <p className="muted">No orders for this selection yet.</p>}
      {shown.map((o) => {
        const total = totalOf(o);
        const paid = confirmedPaid(o);
        const state = o.stage === "cancelled" ? "Cancelled" : isFullyPaid(o, config) ? "Paid" : paid > 0 ? `Part paid ${formatMoney(paid)}` : "Unpaid";
        const methods = [...new Set(o.payments.filter((p) => p.confirmed).map((p) => methodName(p.method)))].join(" + ");
        const items = o.lines.filter((l) => l.qty > 0).reduce((n, l) => n + l.qty, 0);
        return (
          <div className="tab" key={o.orderId}>
            <div>
              <b>{o.queueNumber ?? "—"}</b> <span className="muted">· {range === "today" ? "" : `${dateOf(o.openedAt)} `}{timeOf(o.openedAt)} · {o.channelName ?? o.fulfilment}{o.spot ? ` · ${o.spot}` : ""} · {o.source === "online" ? "online" : "till"}</span>
              <div className="muted" style={{ fontSize: 13 }}>
                {items} item{items === 1 ? "" : "s"} · {STAGE[o.stage] ?? o.stage} · <b style={{ color: state === "Paid" ? "inherit" : undefined }}>{state}</b>{methods && ` (${methods})`}
                {(o.customerName || o.customerPhone) && ` · ${[o.customerName, o.customerPhone].filter(Boolean).join(" ")}`}
              </div>
            </div>
            <div className="tabr">
              <b>{formatMoney(total)}</b>
              <button className="secondary sm" onClick={() => void kitchen(o)}>Kitchen ticket</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---- members ----------------------------------------------------------------------------------

interface MemberRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  points: number;
  creditCents: number;
  joinedAt: string;
}

function Members({ canAdjustPoints }: { canAdjustPoints: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<{ id: string; kind: "credit" | "points" } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (query: string) => {
    const my = ++seq.current;
    const r = await staffFetch(`/api/members${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    if (my !== seq.current) return; // a newer search has started
    if ("problem" in r) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("Could not load members.");
    const j = (await r.res.json()) as { total: number; members: MemberRow[] };
    setRows(j.members);
    setTotal(j.total);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void load(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q, load]);

  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or phone" style={{ width: "100%", marginBottom: 10 }} />
      {msg && <div className="flash">{msg}</div>}
      <p className="muted">{rows === null ? "Loading…" : q ? `${rows.length} found` : `${total} member${total === 1 ? "" : "s"}${total > rows.length ? ` (newest ${rows.length} shown; search to find others)` : ""}`}</p>
      {rows?.length === 0 && <p className="muted">No members match.</p>}
      {rows?.map((m) => (
        <div className="tab" key={m.id} style={{ display: "block" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div>
              <b>{m.name || "(no name)"}</b>
              <div className="muted" style={{ fontSize: 13 }}>{[m.email, m.phone].filter(Boolean).join(" · ") || "no contact details"}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div>Credit <b>{formatMoney(m.creditCents)}</b></div>
              <div>Points <b>{m.points.toLocaleString()}</b></div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="secondary sm" onClick={() => setOpen(open?.id === m.id && open.kind === "credit" ? null : { id: m.id, kind: "credit" })}>Add credit</button>
            {canAdjustPoints && <button className="secondary sm" onClick={() => setOpen(open?.id === m.id && open.kind === "points" ? null : { id: m.id, kind: "points" })}>Adjust points</button>}
          </div>
          {open?.id === m.id && open.kind === "credit" && <CreditForm member={m} onDone={(t) => { setMsg(t); setOpen(null); void load(q.trim()); }} />}
          {open?.id === m.id && open.kind === "points" && <PointsForm member={m} onDone={(t) => { setMsg(t); setOpen(null); void load(q.trim()); }} />}
        </div>
      ))}
    </>
  );
}

function CreditForm({ member, onDone }: { member: MemberRow; onDone: (message: string) => void }) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey()); // the same key until it works, so a double tap or retry adds credit once

  async function add(cents: number) {
    if (busy || !(cents > 0)) return;
    setBusy(true);
    setErr(null);
    const r = await staffFetch("/api/wallet/topup", { body: { customerId: member.id, amountCents: cents, idempotencyKey: key.current } });
    setBusy(false);
    if ("problem" in r) return setErr(r.problem);
    if (r.res.status === 403) return setErr("Cashiers can add up to S$200 at a time. Ask a manager for more.");
    if (!r.res.ok) return setErr("Could not add credit. Nothing was changed.");
    onDone(`Added ${formatMoney(cents)} credit for ${member.name || member.email || "the member"}.`);
  }
  const cents = Math.round(Number(custom) * 100);
  return (
    <div style={{ marginTop: 8 }}>
      {err && <div className="flash warn">{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[1000, 2000, 5000, 10000].map((c) => <button key={c} className="secondary sm" disabled={busy} onClick={() => void add(c)}>+{formatMoney(c)}</button>)}
        <input value={custom} onChange={(e) => setCustom(e.target.value)} inputMode="decimal" placeholder="Other S$" style={{ width: 90 }} />
        <button className="primary sm" disabled={busy || !(cents > 0)} onClick={() => void add(cents)}>Add</button>
      </div>
    </div>
  );
}

function PointsForm({ member, onDone }: { member: MemberRow; onDone: (message: string) => void }) {
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey());
  const n = Math.trunc(Number(points));
  const ok = Number.isFinite(n) && n !== 0 && note.trim().length > 0;

  async function save() {
    if (busy || !ok) return;
    setBusy(true);
    setErr(null);
    const r = await staffFetch(`/api/members/${member.id}/points`, { body: { points: n, note: note.trim(), idempotencyKey: key.current } });
    setBusy(false);
    if ("problem" in r) return setErr(r.problem);
    if (r.res.status === 409) return setErr("That would take them below zero points.");
    if (!r.res.ok) return setErr("Could not change the points. Nothing was changed.");
    const j = (await r.res.json()) as { balance: number };
    onDone(`${member.name || member.email || "Member"} now has ${j.balance.toLocaleString()} points.`);
  }
  return (
    <div style={{ marginTop: 8 }}>
      {err && <div className="flash warn">{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input value={points} onChange={(e) => setPoints(e.target.value)} inputMode="numeric" placeholder="+100 or -100" style={{ width: 110 }} />
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Reason (required)" style={{ flex: 1, minWidth: 160 }} />
        <button className="primary sm" disabled={busy || !ok} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
