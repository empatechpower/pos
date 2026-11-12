import { useCallback, useEffect, useRef, useState } from "react";
import { confirmedPaid, formatMoney, isFullyPaid, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";
import { staffFetch, useStaff } from "../auth";
import { useOrders } from "../hooks";
import { PrintBadge, usePrintStatus } from "./PrintBadge";

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
  const [tab, setTab] = useState<"orders" | "members" | "telegram" | "books">("orders");
  return (
    <div className="credit prices">
      <h2>Manager</h2>
      {!staff ? (
        <div className="flash">Sign in to see orders and manage members. <a href="#/login">Sign in</a></div>
      ) : (
        <>
          <div className="seg" style={{ margin: "4px 0 12px" }}>
            <button className={tab === "orders" ? "on" : ""} aria-pressed={tab === "orders"} onClick={() => setTab("orders")}>Transactions</button>
            <button className={tab === "members" ? "on" : ""} aria-pressed={tab === "members"} onClick={() => setTab("members")}>Members</button>
            {staff.role !== "cashier" && <button className={tab === "books" ? "on" : ""} aria-pressed={tab === "books"} onClick={() => setTab("books")}>Books</button>}
            {staff.role !== "cashier" && <button className={tab === "telegram" ? "on" : ""} aria-pressed={tab === "telegram"} onClick={() => setTab("telegram")}>Telegram</button>}
          </div>
          {tab === "orders" ? <Transactions config={config} /> : tab === "books" ? <Books /> : tab === "telegram" ? <TelegramPanel /> : <Members canAdjustPoints={staff.role !== "cashier"} canImport={staff.role !== "cashier"} rewardsOn={config.rewards.pointsEnabled} />}
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

  const printState = usePrintStatus(shown.map((o) => o.orderId), true);

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
              <PrintBadge s={printState[o.orderId]} onReprint={() => void kitchen(o)} />
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

function Members({ canAdjustPoints, canImport, rewardsOn }: { canAdjustPoints: boolean; canImport: boolean; rewardsOn: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<{ id: string; kind: "credit" | "points" } | null>(null);
  const [panel, setPanel] = useState<null | "add" | "upload">(null);
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <button className={panel === "add" ? "primary sm" : "secondary sm"} onClick={() => setPanel(panel === "add" ? null : "add")}>Add a member</button>
        {canImport && <button className={panel === "upload" ? "primary sm" : "secondary sm"} onClick={() => setPanel(panel === "upload" ? null : "upload")}>Upload a list</button>}
      </div>
      {panel === "add" && <AddMember onDone={(text) => { setMsg(text); setPanel(null); void load(q.trim()); }} />}
      {panel === "upload" && canImport && <UploadMembers onDone={() => void load(q.trim())} />}
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
              {rewardsOn && <div>Points <b>{m.points.toLocaleString()}</b></div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="secondary sm" onClick={() => setOpen(open?.id === m.id && open.kind === "credit" ? null : { id: m.id, kind: "credit" })}>Add credit</button>
            {rewardsOn && canAdjustPoints && <button className="secondary sm" onClick={() => setOpen(open?.id === m.id && open.kind === "points" ? null : { id: m.id, kind: "points" })}>Adjust points</button>}
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

// ---- adding and importing members -------------------------------------------------------------

const WHY: Record<string, string> = { need_phone_or_email: "Add an email or a phone number so they can sign in.", bad_email: "That email looks wrong.", bad_phone: "That phone number looks wrong. Use 8 digits, or include the country code." };

function AddMember({ onDone }: { onDone: (message: string) => void }) {
  const [f, setF] = useState({ name: "", phone: "", email: "", credit: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cents = f.credit.trim() === "" ? 0 : Math.round(Number(f.credit.replace(/^s?\$/i, "")) * 100);
  const bad = !Number.isFinite(cents) || cents < 0;

  async function add() {
    if (busy || bad) return;
    setBusy(true);
    setErr(null);
    const r = await staffFetch("/api/members", { body: { name: f.name, phone: f.phone, email: f.email, creditCents: cents } });
    setBusy(false);
    if ("problem" in r) return setErr(r.problem);
    const j = (await r.res.json().catch(() => ({}))) as { error?: string; created?: boolean; member?: { name: string | null; phone: string | null; email: string | null }; creditCents?: number };
    if (r.res.status === 403) return setErr("Cashiers can add up to S$200 of opening credit. Ask a manager for more.");
    if (!r.res.ok) return setErr(WHY[j.error ?? ""] ?? "Could not add that member. Nothing was changed.");
    const who = j.member?.name || j.member?.email || j.member?.phone || "the member";
    onDone(j.created ? `Added ${who}${cents > 0 ? ` with ${formatMoney(cents)} credit` : ""}.` : `${who} is already a member (credit ${formatMoney(j.creditCents ?? 0)}). Nothing was changed. Use "Add credit" on their row to top up.`);
  }
  return (
    <div className="tab" style={{ display: "block", marginBottom: 10 }}>
      <b>New member</b>
      {err && <div className="flash warn">{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" maxLength={40} style={{ flex: 1, minWidth: 140 }} />
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="Phone, e.g. 9123 4567" inputMode="tel" style={{ flex: 1, minWidth: 140 }} />
        <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="Email" inputMode="email" style={{ flex: 1, minWidth: 160 }} />
        <input value={f.credit} onChange={(e) => setF({ ...f, credit: e.target.value })} placeholder="Opening credit S$" inputMode="decimal" style={{ width: 130 }} />
        <button className="primary sm" disabled={busy || bad || (!f.phone.trim() && !f.email.trim())} onClick={() => void add()}>Add</button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>An email or a phone number is needed. The member signs in with it and finds their credit waiting.</p>
    </div>
  );
}

/** A small CSV reader: quoted fields, commas inside quotes, and the byte-order mark Excel adds. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === ";" || c === "\t") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const HEADS: Record<string, string> = { name: "name", membername: "name", customername: "name", phonenumber: "phone", mobilenumber: "phone", contactnumber: "phone", memberphone: "phone", creditamount: "credit", credits: "credit", fullname: "name", customer: "name", phone: "phone", mobile: "phone", contact: "phone", tel: "phone", email: "email", mail: "email", credit: "credit", balance: "credit", amount: "credit", topup: "credit" };

function UploadMembers({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<Array<{ name: string; phone: string; email: string; credit: string }> | null>(null);
  const [file, setFile] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; existed: number; invalid: number; creditedCents: number; bad: Array<{ row: number; why: string }> } | null>(null);

  async function pick(f: File | undefined) {
    setRows(null); setResult(null); setProblem(null);
    if (!f) return;
    setFile(f.name);
    const parsed = parseCsv(await f.text());
    if (parsed.length < 2) return setProblem("That file has no members in it. The first row must be the column names: name, phone, email, credit.");
    const cols = parsed[0]!.map((h) => HEADS[h.trim().toLowerCase().replace(/[^a-z]/g, "")]);
    if (!cols.includes("email") && !cols.includes("phone")) return setProblem("I can't find an email or phone column. The first row must be the column names: name, phone, email, credit.");
    const out = parsed.slice(1).map((r) => {
      const o = { name: "", phone: "", email: "", credit: "" };
      cols.forEach((k, i) => { if (k) (o as Record<string, string>)[k] = (r[i] ?? "").trim(); });
      return o;
    });
    if (out.length > 5000) return setProblem("That's more than 5,000 rows. Please split the file.");
    setRows(out);
  }

  async function send() {
    if (!rows || busy) return;
    setBusy(true); setProblem(null);
    const total = { created: 0, existed: 0, invalid: 0, creditedCents: 0, bad: [] as Array<{ row: number; why: string }> };
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const r = await staffFetch("/api/members/import", { body: { rows: chunk, source: file } });
      if ("problem" in r) { setBusy(false); setResult(total); return setProblem(`${r.problem} ${i} of ${rows.length} rows were done; sending the file again is safe, people already added are skipped.`); }
      if (!r.res.ok) { setBusy(false); setResult(total); return setProblem(`The server refused part of the file (error ${r.res.status}). ${i} of ${rows.length} rows were done; sending it again is safe.`); }
      const j = (await r.res.json()) as { created: number; existed: number; invalid: number; creditedCents: number; results: Array<{ row: number; status: string; why?: string }> };
      total.created += j.created; total.existed += j.existed; total.invalid += j.invalid; total.creditedCents += j.creditedCents;
      for (const x of j.results) if (x.status === "invalid") total.bad.push({ row: i + x.row + 1, why: x.why ?? "invalid" }); // +1: the header row
    }
    setBusy(false);
    setResult(total);
    setRows(null);
    onDone();
  }

  function template() {
    const blob = new Blob(["name,phone,email,credit\nMei Lin,9123 4567,mei@example.com,50\nAlex Tan,8123 4567,,20.50\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "members-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="tab" style={{ display: "block", marginBottom: 10 }}>
      <b>Upload a list of members</b>
      <p className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>A CSV file (save from Excel or Google Sheets as CSV) with the columns <b>name, phone, email, credit</b>. Each person needs a phone or an email. Credit is in dollars. People who are already members are skipped, so uploading the same file twice is safe.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label className="secondary sm filebtn">Choose a file<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <button className="secondary sm" onClick={template}>Download a template</button>
        {file && <span className="muted">{file}</span>}
      </div>
      {problem && <div className="flash warn" style={{ marginTop: 8 }}>{problem}</div>}
      {rows && (
        <div style={{ marginTop: 8 }}>
          <div>{rows.length} row{rows.length === 1 ? "" : "s"} found. First: {rows.slice(0, 3).map((r) => r.name || r.email || r.phone).join(", ")}{rows.length > 3 ? "…" : ""}</div>
          <button className="primary sm" disabled={busy} onClick={() => void send()} style={{ marginTop: 6 }}>{busy ? "Adding…" : `Add ${rows.length} member${rows.length === 1 ? "" : "s"}`}</button>
        </div>
      )}
      {result && (
        <div className="flash" style={{ marginTop: 8 }}>
          Added <b>{result.created}</b> ({formatMoney(result.creditedCents)} credit given) · already members <b>{result.existed}</b> · not added <b>{result.invalid}</b>
          {result.bad.length > 0 && <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{result.bad.slice(0, 20).map((b) => <li key={b.row}>Row {b.row}: {b.why}</li>)}{result.bad.length > 20 && <li>…and {result.bad.length - 20} more</li>}</ul>}
        </div>
      )}
    </div>
  );
}

type TgStatus = { configured: boolean; bot?: string | null; linked: { telegramId: string; name: string | null; staffName: string; role: string; since: string }[] };

/** Connect a person's Telegram to their staff sign-in, so they can run the shop's prices by chatting with the bot. */
function TelegramPanel() {
  const [st, setSt] = useState<TgStatus | null>(null);
  const [code, setCode] = useState<{ code: string; minutes: number; bot: string | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await staffFetch("/api/telegram/status");
    if ("problem" in r) return setMsg(r.problem);
    if (r.res.ok) setSt((await r.res.json()) as TgStatus);
  }, []);
  useEffect(() => void load(), [load]);

  async function makeCode() {
    setMsg(null);
    const r = await staffFetch("/api/telegram/link-code", { method: "POST", body: {} });
    if ("problem" in r) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("Could not make a code.");
    setCode((await r.res.json()) as { code: string; minutes: number; bot: string | null });
  }
  async function unlink(id: string) {
    if (!confirm("Disconnect this Telegram account? It will no longer be able to change prices.")) return;
    const r = await staffFetch(`/api/telegram/links/${id}`, { method: "DELETE" });
    if ("problem" in r) return setMsg(r.problem);
    void load();
  }

  if (!st) return <p className="muted">{msg ?? "Loading…"}</p>;
  if (!st.configured)
    return (
      <div className="tab" style={{ display: "block" }}>
        <b>The Telegram bot isn't switched on yet.</b>
        <p className="muted">Create a bot with @BotFather in Telegram, then put its token in the server settings as TELEGRAM_BOT_TOKEN (and a long random TELEGRAM_WEBHOOK_SECRET). See docs/telegram-bot.md.</p>
      </div>
    );
  return (
    <div>
      {msg && <div className="flash warn">{msg}</div>}
      <div className="tab" style={{ display: "block", marginBottom: 10 }}>
        <b>Connect your Telegram</b>
        <p className="muted">Press the button, then open {st.bot ? <b>@{st.bot}</b> : "the bot"} in Telegram and send it: <b>/link CODE</b>. Then try /help, /newpricebook Grab, /price latte 5.50, /off cheesecake or /edit.</p>
        <button className="primary sm" onClick={() => void makeCode()}>Make a code</button>
        {code && (
          <p>
            Send <b style={{ fontSize: "1.2em" }}>/link {code.code}</b> to the bot within {code.minutes} minutes. It works once.
          </p>
        )}
      </div>
      <b>Connected</b>
      {st.linked.length === 0 && <p className="muted">Nobody yet.</p>}
      {st.linked.map((l) => (
        <div className="tab" key={l.telegramId} style={{ display: "block" }}>
          <b>{l.staffName}</b> <span className="muted">({l.role}) · Telegram {l.name ?? l.telegramId}</span>{" "}
          <button className="secondary sm" onClick={() => void unlink(l.telegramId)}>Disconnect</button>
        </div>
      ))}
    </div>
  );
}

type Recon = { openingCents: number; creditsCents: number; debitsCents: number; reversalsCents: number; adjustmentsCents: number; closingCents: number; wallets: number; entries: number; balanced: boolean; mismatchedWallets: Array<{ customerId: string; storedCents: number; rebuiltCents: number }> };

/** The credit books: opening + credits - debits + reversals must equal what the wallets hold now. */
function Books() {
  const [r, setR] = useState<Recon | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    setMsg(null);
    const x = await staffFetch("/api/wallet/reconciliation");
    if ("problem" in x) return setMsg(x.problem);
    if (!x.res.ok) return setMsg("Could not load the books.");
    setR((await x.res.json()) as Recon);
  }, []);
  useEffect(() => void load(), [load]);
  if (!r) return <p className="muted">{msg ?? "Loading…"}</p>;
  const row = (label: string, cents: number, note?: string) => (
    <div className="sum-row"><span className="k">{label}{note && <span className="muted"> {note}</span>}</span><span className="v">{formatMoney(cents)}</span></div>
  );
  return (
    <div className="tab" style={{ display: "block" }}>
      <div className={`flash ${r.balanced ? "" : "warn"}`}>{r.balanced ? "The books balance." : "The books do NOT balance. Stop and do not correct anything by hand. Send this screen to the developer."}</div>
      {row("Opening balances", r.openingCents, "(imported once)")}
      {row("Other credits added", r.creditsCents, "(top-ups)")}
      {row("Debits", r.debitsCents, "(orders paid with credit)")}
      {row("Reversals", r.reversalsCents, "(refunds)")}
      {r.adjustmentsCents !== 0 && row("Adjustments", r.adjustmentsCents)}
      <div className="sum-row grand"><span className="k">Closing (what members hold now)</span><span className="v">{formatMoney(r.closingCents)}</span></div>
      <p className="muted" style={{ fontSize: 13 }}>{r.wallets} wallets · {r.entries} entries. Opening + credits + debits + reversals = closing. Debits are shown as negative amounts.</p>
      {r.mismatchedWallets.length > 0 && <div className="flash warn">{r.mismatchedWallets.length} wallet(s) do not match their own entries.</div>}
      <button className="secondary sm" onClick={() => void load()}>Check again</button>
    </div>
  );
}
