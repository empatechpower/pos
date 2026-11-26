import { useEffect, useState, type ReactNode } from "react";
import { formatMoney } from "@pos/core";
import { ProtoDialog } from "../proto/ProtoDialog";
import { staffFetch } from "../auth";
import type { HeldOrder } from "./types";

/** A dialog in the prototype's own markup, placed over whichever till screen is showing. */
const Proto = ({ title, extra, onClose, children }: { title: string; extra?: string; onClose: () => void; children: ReactNode }) => <div className="proto protohead"><ProtoDialog title={title} extra={extra} onClose={onClose}>{children}</ProtoDialog></div>;

/** Dining (prototype: drawDining): one row per dining option, OK to apply. */
export function DiningDialog({ channels, current, onPick, onClose }: { channels: Array<{ id: string; name: string }>; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const [sel, setSel] = useState(current);
  return (
    <Proto title="Dining" onClose={onClose}>
      {channels.map((c) => <button key={c.id} className={`guestrow ${sel === c.id ? "selected" : ""}`} aria-pressed={sel === c.id} onClick={() => setSel(c.id)}>{sel === c.id ? "◉" : "○"} {c.name}</button>)}
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => { onPick(sel); onClose(); }}>OK</button></div>
    </Proto>
  );
}

/** Enter Guest Count (prototype: drawGuests): one to six as rows, or any number up to 99. */
export function GuestsDialog({ current, onSave, onClose }: { current: number; onSave: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState(current);
  const [err, setErr] = useState("");
  const save = () => (Number.isInteger(n) && n >= 1 && n <= 99 ? (onSave(n), onClose()) : setErr("Enter a guest count from 1 to 99."));
  return (
    <Proto title="Enter Guest Count" onClose={onClose}>
      {[1, 2, 3, 4, 5, 6].map((k) => <button key={k} className={`guestrow ${n === k ? "selected" : ""}`} aria-pressed={n === k} onClick={() => { setN(k); setErr(""); }}>{n === k ? "◉" : "○"} {k} Guest{k === 1 ? "" : "s"}</button>)}
      <label className="field">Guest count<input type="number" inputMode="numeric" min={1} max={99} step={1} aria-label="Guest count" value={Number.isFinite(n) ? n : ""} onChange={(e) => { setN(Number(e.target.value)); setErr(""); }} /></label>
      <div className="error" role="alert">{err}</div>
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>OK</button></div>
    </Proto>
  );
}

/** Quantity (prototype: qtyDialog): for the next item added. */
export function QuantityDialog({ current, onSave, onClose }: { current: number; onSave: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState(current);
  return (
    <Proto title="Quantity" onClose={onClose}>
      <p className="muted">Applies to the next item added, then returns to 1.</p>
      <div className="row"><span>Quantity</span><div className="stepper"><button aria-label="Fewer" onClick={() => setN(Math.max(1, n - 1))}>−</button><strong>{n}</strong><button aria-label="More" onClick={() => setN(Math.min(99, n + 1))}>+</button></div></div>
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => { onSave(n); onClose(); }}>Set</button></div>
    </Proto>
  );
}

/** Held orders (prototype: showHeld): tap one to bring it back. Discard is ours: the prototype has no way to drop a held order. */
export function HeldDialog({ held, onRecall, onDrop, onClose, formatTotal }: { held: HeldOrder[]; onRecall: (id: string) => void; onDrop: (id: string) => void; onClose: () => void; formatTotal: (h: HeldOrder) => number }) {
  return (
    <Proto title="Held orders" onClose={onClose}>
      {held.length === 0 ? <p className="muted">No held orders yet.</p> : held.map((h) => (
        <div key={h.id} className="heldline">
          <button className="heldrow" onClick={() => { onRecall(h.id); onClose(); }}>
            <div className="row"><strong>{h.spot || "Order"}{h.pax > 1 ? ` · ${h.pax} guests` : ""}</strong><span>{formatMoney(formatTotal(h))}</span></div>
            <small>{h.bag.reduce((n, l) => n + l.qty, 0)} items · held {new Date(h.savedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</small>
          </button>
          <button className="helddrop" aria-label="Discard this held order" onClick={() => onDrop(h.id)}>Discard</button>
        </div>
      ))}
    </Proto>
  );
}

/** Cancel current order? (prototype: newOrder). Also asks before taking unsent items off an order that was already sent. */
export function CancelOrderDialog({ items, sent, onConfirm, onClose }: { items: number; /** The order was already sent: only its unsent items can go. */ sent: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Proto title={sent ? "Remove unsent items?" : "Cancel current order?"} onClose={onClose}>
      <p>{sent ? `${items} item${items === 1 ? " has" : "s have"} not been sent yet. Remove ${items === 1 ? "it" : "them"} from this order? What was already sent stays.` : `The current ticket has ${items} item${items === 1 ? "" : "s"}. Cancel it and start a new order?`}</p>
      <div className="actions"><button onClick={onClose}>Keep order</button><button className="primary" onClick={() => { onConfirm(); onClose(); }}>{sent ? "Remove items" : "Cancel Order"}</button></div>
    </Proto>
  );
}

/** A member as the till shows them: who they are, what they hold, and their last orders. */
export interface MemberSummary {
  member: { id: string; name: string | null; phone: string | null; email: string | null; points: number; creditCents: number };
  rewards: { pointsEnabled: boolean; minPointsRedeem: number };
  /** Where their credit stands under the shop's validity rules. */
  credit?: { state: "none" | "active" | "expired" | "lapsed"; expiresAt: number | null; reinstateBy: number | null };
  recent: Array<{ orderId: string; at: number; totalCents: number; status: string; items: string; where: string }>;
}
const isMemberId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
export async function loadMember(id: string): Promise<MemberSummary | null> {
  if (!isMemberId(id)) return null;
  const r = await staffFetch(`/api/members/${id}/summary`);
  return "res" in r && r.res.ok ? ((await r.res.json()) as MemberSummary) : null;
}
const maskPhone = (p: string | null) => (p ? `···· ${p.replace(/\D/g, "").slice(-4)}` : "");
const creditDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Singapore" });
const memberWhen = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Singapore" });

/**
 * The member on this order (handout 4.6): find one by name or phone, or add a new one, and attach them. Once attached the till shows their
 * credit, their points and their last orders, and the order becomes theirs: it earns points when paid and shows in their history.
 */
export function CustomerDialog({ current, info, usePoints, pointsWorthCents, onUsePoints, onSave, onClose }: { current: string; info: MemberSummary | null; usePoints: boolean; /** What the points would take off this order. */ pointsWorthCents: number; onUsePoints: (on: boolean) => void; onSave: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Array<{ id: string; name: string | null; phone: string | null; points: number; creditCents: number }> | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (q.trim().length < 2) return setMsg("Type at least two letters or digits.");
    setBusy(true); setMsg("");
    const r = await staffFetch(`/api/members?q=${encodeURIComponent(q.trim())}`);
    setBusy(false);
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("Members could not be searched. Check the connection.");
    setFound(((await r.res.json()) as { members: Array<{ id: string; name: string | null; phone: string | null; points: number; creditCents: number }> }).members.slice(0, 8));
  };
  const add = async () => {
    setBusy(true); setMsg("");
    const r = await staffFetch("/api/members", { body: { name: name.trim() || undefined, phone: phone.trim() } });
    setBusy(false);
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("That member could not be added. Give a phone number with the country code, like +65 8111 1111.");
    const j = (await r.res.json()) as { created: boolean; member: { id: string } };
    onSave(j.member.id); onClose();
  };
  if (current && info) {
    const m = info.member;
    return (
      <Proto title="Member" onClose={onClose}>
        <p style={{ margin: "0 0 .3em" }}><b>{m.name || "Member"}</b> <span className="muted">{maskPhone(m.phone)}</span></p>
        <div className="row"><span>Credit</span><b>{formatMoney(m.creditCents)}</b></div>
        {m.creditCents > 0 && info.credit?.state === "active" && info.credit.expiresAt && <p className="muted">Valid until {creditDay(info.credit.expiresAt)}. Each top-up starts the time again.</p>}
        {m.creditCents > 0 && info.credit?.state === "expired" && <p className="error warn" role="alert">This credit expired on {creditDay(info.credit.expiresAt!)}. A top-up by {creditDay(info.credit.reinstateBy!)} brings it back.</p>}
        {m.creditCents > 0 && info.credit?.state === "lapsed" && <p className="error warn" role="alert">This credit expired on {creditDay(info.credit.expiresAt!)} and was not topped up in time. It can no longer be used.</p>}
        {info.rewards.pointsEnabled && <div className="row"><span>Points</span><b>{m.points.toLocaleString()}</b></div>}
        {info.rewards.pointsEnabled && m.points > 0 && (
          <label className="row" style={{ cursor: "pointer" }}><span>Use points on this order{pointsWorthCents > 0 ? ` (${formatMoney(pointsWorthCents)} off)` : ""}</span><input type="checkbox" aria-label="Use points on this order" checked={usePoints} disabled={m.points < info.rewards.minPointsRedeem} onChange={(e) => onUsePoints(e.target.checked)} /></label>
        )}
        {info.rewards.pointsEnabled && m.points > 0 && m.points < info.rewards.minPointsRedeem && <p className="muted">Points can be used from {info.rewards.minPointsRedeem} points.</p>}
        <h3>Last orders</h3>
        <div aria-label="Last orders">
          {info.recent.length === 0 && <p className="muted">No orders yet.</p>}
          {info.recent.map((o) => <div className="row" key={o.orderId}><span>{memberWhen(o.at)} · {o.items}{o.status !== "paid" ? ` · ${o.status}` : ""}</span><span>{formatMoney(o.totalCents)}</span></div>)}
        </div>
        <div className="actions"><button onClick={() => { onSave(""); onClose(); }}>Remove</button><button className="primary" onClick={onClose}>Done</button></div>
      </Proto>
    );
  }
  return (
    <Proto title="Member" onClose={onClose}>
      {current && <p className="muted">On this order: {current} <button className="helddrop" onClick={() => { onSave(""); onClose(); }}>Remove</button></p>}
      {!adding ? (
        <>
          <label className="field">Name or phone<input value={q} inputMode="search" autoFocus aria-label="Find a member" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} /></label>
          <div className="actions" style={{ justifyContent: "flex-start" }}><button className="primary" disabled={busy} onClick={() => void search()}>Find</button><button onClick={() => { setAdding(true); setPhone(/^[+\d\s]+$/.test(q) ? q : ""); setName(/^[+\d\s]+$/.test(q) ? "" : q); setMsg(""); }}>Add a new member</button></div>
          {found && found.length === 0 && <p className="muted">Nobody found. Check the spelling, or add them as a new member.</p>}
          {found && found.length === 0 && q.trim() && <button onClick={() => { onSave(q.trim()); onClose(); }}>Use "{q.trim()}" as a credit code only</button>}
          {found?.map((m) => <button key={m.id} className="guestrow" onClick={() => { onSave(m.id); onClose(); }}>○ {m.name || "Member"} {maskPhone(m.phone)} <span className="muted">· {formatMoney(m.creditCents)} credit{m.points ? ` · ${m.points} pts` : ""}</span></button>)}
        </>
      ) : (
        <>
          <label className="field">Name<input value={name} maxLength={60} aria-label="New member name" onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">Phone, with country code<input value={phone} inputMode="tel" aria-label="New member phone" placeholder="+65 8111 1111" onChange={(e) => setPhone(e.target.value)} /></label>
          <div className="actions"><button onClick={() => setAdding(false)}>Back</button><button className="primary" disabled={busy || phone.replace(/\D/g, "").length < 8} onClick={() => void add()}>Add and attach</button></div>
        </>
      )}
      {msg && <p className="muted" role="alert">{msg}</p>}
      <div className="actions"><button onClick={onClose}>Close</button></div>
    </Proto>
  );
}

/**
 * Payment complete, in the prototype's own markup (proto-reference/index.html, showReceipt): the receipt as it prints, with "Print modifiers",
 * Print and New Order under it. The receipt is the server's own (the same text the printer gets); until the order has reached the server, or
 * with no connection, the queue number and the figures stand in for it. Change due stays above the receipt so it is never below the fold.
 */
export function DoneDialog({ orderId, queue, changeCents, totalCents, onClose }: { orderId?: string; queue?: string; changeCents: number; totalCents: number; onClose: () => void }) {
  const [mods, setMods] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!orderId) return;
    let live = true, tries = 0, fresh = 0;
    // The order is pushed to the server in the background: ask a few times before giving up.
    const ask = async () => {
      const r = await staffFetch(`/api/orders/${orderId}/receipt${mods ? "?modifiers=1" : ""}`);
      if (!live) return;
      if ("res" in r && r.res.ok) {
        setText(((await r.res.json()) as { text: string }).text);
        // The last payment may reach the server a moment after the order did (a split bill's final check, a table settled later):
        // look again twice, so the receipt shown is the finished one.
        if (++fresh <= 2) setTimeout(() => void ask(), fresh === 1 ? 2500 : 5000);
        return;
      }
      if (++tries < 5) setTimeout(() => void ask(), 1200);
    };
    void ask();
    return () => { live = false; };
  }, [orderId, mods]);
  const print = async () => {
    if (!orderId) return;
    const r = await staffFetch("/api/print/reprint", { body: { orderId, docType: "receipt", ...(mods ? { modifiers: true } : {}) } });
    if ("problem" in r) return setMsg(r.problem);
    if (r.res.ok) return setMsg("Receipt sent to the printer.");
    const code = ((await r.res.json().catch(() => ({}))) as { error?: string }).error;
    setMsg(code === "order_not_found" ? "The server doesn't have this order yet. Wait a moment, then try again." : code === "no_printer_for_this" ? "No printer is set up for receipts. Ask a manager." : r.res.status === 403 ? "This account is not allowed to print receipts again." : "Could not print.");
  };
  return (
    <div className="proto protohead">
      <ProtoDialog title="Payment complete" onClose={onClose}>
        {changeCents > 0 && <div className="row donechange"><span>Change due</span><strong>{formatMoney(changeCents)}</strong></div>}
        <div id="rcptbox">
          {text ? <pre className="receipt r7" style={{ whiteSpace: "pre-wrap" }}>{text}</pre> : (
            <div className="receipt r7">
              {queue && <><div className="rcent">QUEUE NUMBER</div><div className="rcent rstore donequeue">{queue}</div></>}
              <div className="rrow rtotal"><span>Paid</span><span>{formatMoney(totalCents)}</span></div>
              {changeCents > 0 && <div className="rrow"><span>Change</span><span>{formatMoney(changeCents)}</span></div>}
            </div>
          )}
        </div>
        {msg && <div className="error" role="status">{msg}</div>}
        <div className="actions">
          <button disabled={!orderId} onClick={() => setMods((m) => !m)}>Print modifiers: {mods ? "On" : "Off"}</button>
          <button disabled={!orderId} onClick={() => void print()}>Print</button>
          <button className="primary" autoFocus onClick={onClose}>New Order</button>
        </div>
      </ProtoDialog>
    </div>
  );
}

/** A fee on the whole order: a preset percentage of the items, or your own percentage or amount. Added fees are listed and can be taken off. */
export function FeeDialog({ fees, subtotalCents, onAdd, onRemove, onClose }: { fees: Array<{ id: string; kind: "percent" | "amount"; value: number; label: string }>; /** What a percentage is taken of, to show each quick choice's amount. */ subtotalCents?: number; onAdd: (kind: "percent" | "amount", value: number, label: string) => void; onRemove: (id: string) => void; onClose: () => void }) {
  const [label, setLabel] = useState("Service fee");
  const [pct, setPct] = useState("");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState("");
  const name = () => label.trim() || "Service fee";
  const set = () => {
    const a = Number(amount), p = Number(pct);
    if (amount !== "" && a > 0 && a <= 10000) { onAdd("amount", Math.round(a * 100), name()); return onClose(); }
    if (pct !== "" && p > 0 && p <= 100) { onAdd("percent", p, name()); return onClose(); }
    setErr("Enter an amount, or a percentage from 0 to 100.");
  };
  return (
    <Proto title="Service Fee" onClose={onClose}>
      {fees.length === 0 ? <div className="row"><span>Current fee</span><strong>{formatMoney(0)}</strong></div>
        : fees.map((f) => <div className="row" key={f.id}><span>{f.label}</span><span><strong>{f.kind === "percent" ? `${f.value}%` : formatMoney(f.value)}</strong> <button className="helddrop" onClick={() => onRemove(f.id)}>Remove fee</button></span></div>)}
      <h3>Add as % of subtotal</h3>
      <div className="choices">{[5, 10, 15].map((p) => <button key={p} onClick={() => { onAdd("percent", p, name()); onClose(); }}>{p}%{subtotalCents !== undefined ? ` · ${formatMoney(Math.round((subtotalCents * p) / 100))}` : ""}</button>)}</div>
      <label className="field">Or your own %<input type="number" min={0} max={100} step="0.1" aria-label="Fee percentage" placeholder="e.g. 7.5" value={pct} onChange={(e) => { setPct(e.target.value); setErr(""); }} /></label>
      <label className="field">Or amount $<input type="number" min={0} step="0.01" aria-label="Fee amount" placeholder="0.00" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(""); }} /></label>
      <label className="field">Name on the receipt<input type="text" maxLength={40} aria-label="Fee name" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="error" role="alert">{err}</div>
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={set}>Set fee</button></div>
    </Proto>
  );
}

/** An item that is not on the menu: a name and a price. Only managers add one, because the price is set by hand. */
export function ExtraItemDialog({ onAdd, onClose }: { onAdd: (name: string, cents: number, qty: number) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(1);
  const cents = Math.round(Number(price) * 100);
  const ok = name.trim().length > 0 && Number.isFinite(cents) && cents > 0 && cents <= 99_999_00;
  return (
    <Proto title="Add Extra Item" onClose={onClose}>
      <p className="muted">An item that is not on the menu. It goes on the order like any other and is sent to the kitchen.</p>
      <label className="field">Name<input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Price (S$)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>
      <div className="row"><span>Quantity</span><div className="stepper"><button aria-label="Fewer" onClick={() => setQty(Math.max(1, qty - 1))}>−</button><strong>{qty}</strong><button aria-label="More" onClick={() => setQty(Math.min(99, qty + 1))}>+</button></div></div>
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ok} onClick={() => { onAdd(name.trim(), cents, qty); onClose(); }}>Add to order</button></div>
    </Proto>
  );
}

/** Add/Remove Tax: take the tax off the whole order, with a reason, or put it back. It is written to the order with who did it. */
export function TaxDialog({ name, current, onSet, onClose }: { name: string; current: { reason: string } | null; onSet: (t: { reason: string } | null) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  if (current) {
    return (
      <Proto title={`Add ${name}`} onClose={onClose}>
        <p className="muted">{name} was taken off this order: {current.reason}</p>
        <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => { onSet(null); onClose(); }}>Put {name} back</button></div>
      </Proto>
    );
  }
  return (
    <Proto title={`Remove ${name}`} onClose={onClose}>
      <p className="muted">Takes {name} off the whole order. It is recorded on the order with your name and the reason.</p>
      <label className="field">Reason<input value={reason} maxLength={120} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Why is this sale not taxed?" /></label>
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={reason.trim().length < 3} onClick={() => { onSet({ reason: reason.trim() }); onClose(); }}>Remove {name}</button></div>
    </Proto>
  );
}

/** A promo code on the order as the till holds it (Scan Coupon). The amount follows the order as items change. */
export interface TillCoupon { code: string; title: string; kind: "percent" | "amount"; value: number; minSpendCents: number }
/** What a code takes off an items subtotal: the same sum the server does. */
export const couponCents = (c: Pick<TillCoupon, "kind" | "value">, subtotalCents: number): number => Math.max(0, Math.min(subtotalCents, c.kind === "percent" ? Math.floor((subtotalCents * c.value) / 100) : c.value));

/** Scan Coupon: type or scan a promo code. The server says whether it is good for this order, and why not when it is not. */
export function CouponDialog({ current, subtotalCents, memberId, onSet, onClose }: { current: TillCoupon | null; subtotalCents: number; memberId: string | null; onSet: (c: TillCoupon | null) => void; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (!code.trim()) return;
    setBusy(true); setMsg("");
    const r = await staffFetch("/api/promos/check", { body: { code: code.trim(), subtotalCents, memberId } });
    setBusy(false);
    if (!("res" in r)) return setMsg(r.problem);
    const j = (await r.res.json().catch(() => ({}))) as Partial<TillCoupon> & { message?: string; shortfallCents?: number };
    if (!r.res.ok) return setMsg(`${j.message ?? "That code could not be used."}${j.shortfallCents ? ` Add ${formatMoney(j.shortfallCents)} more.` : ""}`);
    onSet({ code: j.code!, title: j.title ?? j.code!, kind: j.kind!, value: j.value!, minSpendCents: j.minSpendCents ?? 0 });
    onClose();
  };
  return (
    <Proto title="Scan Coupon" onClose={onClose}>
      {current && <p className="muted">On this order: <b>{current.code}</b> · {current.title} · {formatMoney(couponCents(current, subtotalCents))} off <button className="helddrop" onClick={() => { onSet(null); onClose(); }}>Remove</button></p>}
      <label className="field">Coupon code<input value={code} autoFocus autoCapitalize="characters" autoComplete="off" aria-label="Coupon code" onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") void apply(); }} /></label>
      {msg && <p className="muted" role="alert">{msg}</p>}
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !code.trim()} onClick={() => void apply()}>Apply</button></div>
    </Proto>
  );
}

/** Enter Barcode: scan (a scanner types the code and presses Enter) or type an item's barcode or SKU. It stays open for the next scan. */
export function BarcodeDialog({ find, onClose }: { /** Adds the item with that code; says what happened. */ find: (code: string) => string; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const go = () => { const c = code.trim(); if (!c) return; setMsg(find(c)); setCode(""); };
  return (
    <Proto title="Enter Barcode" onClose={onClose}>
      <label className="field">Barcode or SKU<input value={code} autoFocus autoComplete="off" aria-label="Barcode" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(); }} /></label>
      {msg && <p className="muted" role="status">{msg}</p>}
      <div className="actions"><button onClick={onClose}>Done</button><button className="primary" disabled={!code.trim()} onClick={go}>Add</button></div>
    </Proto>
  );
}

/** Print Invoice: the order as it stands, before payment, for the customer to take. Printed through the browser's print window. */
export function InvoiceDialog({ title, lines, onClose }: { title: string; lines: string[]; onClose: () => void }) {
  const print = () => { document.body.classList.add("print-invoice"); const done = () => { document.body.classList.remove("print-invoice"); window.removeEventListener("afterprint", done); }; window.addEventListener("afterprint", done); window.print(); };
  return (
    <Proto title={title} onClose={onClose}>
      <pre className="receipt r7 invoice-print" aria-label="Invoice" style={{ whiteSpace: "pre-wrap", margin: "0 auto .6em" }}>{lines.join("\n")}</pre>
      <div className="actions"><button onClick={onClose}>Close</button><button className="primary" onClick={print}>Print</button></div>
    </Proto>
  );
}

/**
 * Handing an order to whoever came for it (a delivery rider, or the customer). Scan the bag's receipt barcode or type the order number:
 * the till shows that order, so the bag can be checked against it before it leaves, and warns when it is not paid, not ready, cancelled,
 * or already gone. Then it records who took it. A rider's card held to the reader fills in the rider box.
 */
export function HandoverDialog({ find, onHandOver, onClose }: { find: (code: string) => HandoverOrder | null; onHandOver: (orderId: string, to: string, ref: string) => Promise<void>; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [order, setOrder] = useState<HandoverOrder | null>(null);
  const [to, setTo] = useState("");
  const [ref, setRef] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const look = () => { const c = code.trim(); if (!c) return; const o = find(c); setMsg(o ? "" : `No order matches ${c}. Check the number on the bag.`); setOrder(o); setCode(""); setTo(""); setRef(""); };
  const blocked = order ? order.cancelled || !!order.handedTo : true;
  const hand = async () => {
    if (!order || blocked || !to.trim() || busy) return;
    setBusy(true);
    await onHandOver(order.orderId, to.trim(), ref.trim());
    setBusy(false);
    setMsg(`Order ${order.number} handed to ${to.trim()}.`);
    setOrder(null);
  };
  return (
    <Proto title="Hand over an order" extra="splitdialog" onClose={onClose}>
      {!order && (
        <>
          <label className="field">Scan the bag, or type the order number<input value={code} autoFocus autoComplete="off" aria-label="Order code" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") look(); }} /></label>
          {msg && <p className="muted" role="status">{msg}</p>}
          <div className="actions"><button onClick={onClose}>Close</button><button className="primary" disabled={!code.trim()} onClick={look}>Find</button></div>
        </>
      )}
      {order && (
        <>
          <p style={{ margin: "0 0 .3em" }}><b style={{ fontSize: "1.5em" }}>Order {order.number}</b> <span className="muted">· {order.where}{order.customer ? ` · ${order.customer}` : ""} · {order.when}</span></p>
          <div aria-label="Items in this order">{order.items.map((l, i) => <div className="row" key={i}><span><b>{l.qty}×</b> {l.name}{l.detail ? <small className="muted"> · {l.detail}</small> : null}</span></div>)}</div>
          <p className="muted">{order.itemCount} item{order.itemCount === 1 ? "" : "s"} in the bag · {order.total}</p>
          {order.cancelled && <p className="error warn" role="alert">This order was cancelled. Do not hand it over.</p>}
          {order.handedTo && <p className="error warn" role="alert">Already handed to {order.handedTo}. Do not hand it over again.</p>}
          {!order.cancelled && !order.handedTo && !order.paid && <p className="error warn" role="alert">This order is not paid yet ({order.owing} to collect).</p>}
          {!order.cancelled && !order.handedTo && order.paid && !order.ready && <p className="error warn" role="alert">The kitchen has not marked this order ready. Check the bag is complete.</p>}
          {!blocked && (
            <>
              <label className="field">Who is taking it (name, or hold the rider's card to the reader)<input value={to} autoFocus maxLength={60} aria-label="Taken by" onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void hand(); }} /></label>
              <label className="field">Their order number or reference, if they gave one<input value={ref} maxLength={60} aria-label="Rider reference" onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void hand(); }} /></label>
            </>
          )}
          <div className="actions"><button onClick={() => { setOrder(null); setMsg(""); }}>Another order</button>{!blocked && <button className="primary" disabled={!to.trim() || busy} onClick={() => void hand()}>Hand over</button>}</div>
        </>
      )}
    </Proto>
  );
}
/** An order as the handover dialog shows it. */
export interface HandoverOrder { orderId: string; number: string; where: string; customer: string; when: string; items: Array<{ qty: number; name: string; detail: string }>; itemCount: number; total: string; owing: string; paid: boolean; ready: boolean; cancelled: boolean; handedTo: string }

/** A gift card as the server keeps it. */
interface GiftCardView { card: { code: string; balanceCents: number; active: boolean; createdAt: number }; entries: Array<{ id: string; kind: string; amountCents: number; balanceAfter: number; orderId: string | null; tender: string | null; at: number }> }
const giftCode = (c: string) => c.replace(/(.{4})(?=.)/g, "$1 ");
const GIFT_KIND: Record<string, string> = { load: "Loaded", redeem: "Spent", refund: "Refund returned", adjust: "Adjusted" };
const GIFT_ERR: Record<string, string> = {
  unknown_card: "No gift card has that code. Check it and try again.",
  bad_code: "A code is 4 to 24 letters and digits.",
  code_taken: "That code is already a card. To add money to it, use Check a card, then Load more.",
  card_inactive: "This gift card has been switched off. Ask a manager.",
  over_cashier_limit: "A cashier can load up to S$200 at a time. Ask a manager for more.",
};

/**
 * Gift cards at the till (developer handout 4.11): sell a new card for an amount, check what a card holds and what happened to it, and load
 * more onto it. The balance lives on the server, so this needs a connection. Cash taken for a card is counted in the cashier's drawer.
 */
export function GiftCardDialog({ canSwitch, onClose }: { /** Managers may switch a card off (lost or cancelled) and back on. */ canSwitch: boolean; onClose: () => void }) {
  const [step, setStep] = useState<"menu" | "sell" | "sold" | "check" | "card" | "load">("menu");
  const [amount, setAmount] = useState("");
  const [tender, setTender] = useState<"cash" | "card" | "paynow">("cash");
  const [code, setCode] = useState("");
  const [view, setView] = useState<GiftCardView | null>(null);
  const [sold, setSold] = useState<null | { code: string; balanceCents: number; loadedCents: number; inDrawer: boolean; tender: string }>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // One key for one press of Sell or Load: pressing it again (a slow connection, a double tap) finds the first and loads once.
  const [key, setKey] = useState(() => `gc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const freshKey = () => setKey(`gc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const cents = Math.round(Number(amount || 0) * 100);
  const go = (to: typeof step) => { setMsg(""); setStep(to); };
  const fail = async (res: Response) => { const j = (await res.json().catch(() => ({}))) as { error?: string }; setMsg(GIFT_ERR[j.error ?? ""] ?? "That did not go through. Check the connection and try again."); };

  async function load(existing: boolean) {
    if (!(cents > 0)) return setMsg("Enter an amount above zero.");
    setBusy(true); setMsg("");
    const r = await staffFetch("/api/giftcards/load", { body: { amountCents: cents, tender, idempotencyKey: key, ...(existing ? { code: view!.card.code, existing: true } : code.trim() ? { code: code.trim() } : {}) } });
    setBusy(false);
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return void fail(r.res);
    const j = (await r.res.json()) as { card: GiftCardView["card"]; inDrawer: boolean };
    setSold({ code: j.card.code, balanceCents: j.card.balanceCents, loadedCents: cents, inDrawer: j.inDrawer, tender });
    setAmount(""); setCode(""); freshKey(); go("sold");
  }
  async function check(c = code) {
    if (!c.trim()) return setMsg("Scan or type the card's code.");
    setBusy(true); setMsg("");
    const r = await staffFetch(`/api/giftcards/${encodeURIComponent(c.trim())}`);
    setBusy(false);
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return void fail(r.res);
    setView((await r.res.json()) as GiftCardView); go("card");
  }
  async function switchCard(active: boolean) {
    const r = await staffFetch(`/api/giftcards/${encodeURIComponent(view!.card.code)}`, { method: "PUT", body: { active } });
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg(r.res.status === 403 ? "Only a manager can switch a card off or on." : "That did not go through.");
    void check(view!.card.code);
  }
  const amountField = <label className="field">Amount $<input type="number" step="0.01" min={0} autoFocus aria-label="Gift card amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>;
  const paidBy = <><h3>Paid by</h3><div className="choices">{([["cash", "Cash"], ["card", "Card"], ["paynow", "PayNow"]] as const).map(([k, l]) => <button type="button" key={k} className={tender === k ? "selected" : ""} aria-pressed={tender === k} onClick={() => setTender(k)}>{l}</button>)}</div></>;
  const error = <div className="error" role="alert">{msg}</div>;

  if (step === "sell") return (
    <Proto title="Sell a gift card" onClose={onClose}>
      {amountField}
      {paidBy}
      <label className="field">Card code (leave empty to make one)<input type="text" autoComplete="off" autoCapitalize="characters" maxLength={30} aria-label="Gift card code" placeholder="For a pre-printed card: scan or type its code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
      {error}
      <div className="actions"><button onClick={() => go("menu")}>Back</button><button className="primary" disabled={busy || !(cents > 0)} onClick={() => void load(false)}>Sell card{cents > 0 ? ` · ${formatMoney(cents)}` : ""}</button></div>
    </Proto>
  );
  if (step === "sold" && sold) return (
    <Proto title="Gift card" onClose={onClose}>
      <div className="receipt r7" style={{ textAlign: "center" }}>
        <div className="rcent">GIFT CARD</div>
        <div className="rcent rstore giftcode" aria-label="Gift card code">{giftCode(sold.code)}</div>
        <div className="rrow rtotal"><span>Balance</span><span>{formatMoney(sold.balanceCents)}</span></div>
        <div className="rrow"><span>Loaded now</span><span>{formatMoney(sold.loadedCents)}</span></div>
      </div>
      <p className="muted">{sold.tender === "cash" ? (sold.inDrawer ? `Take ${formatMoney(sold.loadedCents)} in cash. It is counted in your drawer.` : `Take ${formatMoney(sold.loadedCents)} in cash. You have no shift open, so it is not counted in a drawer.`) : `Take ${formatMoney(sold.loadedCents)} by ${sold.tender === "card" ? "card" : "PayNow"} before handing the card over.`} Write the code on the card, or give it to the customer: the code is the card.</p>
      <div className="actions"><button onClick={() => go("sell")}>Sell another</button><button className="primary" autoFocus onClick={onClose}>Done</button></div>
    </Proto>
  );
  if (step === "check") return (
    <Proto title="Check a gift card" onClose={onClose}>
      <label className="field">Card code<input type="text" autoFocus autoComplete="off" autoCapitalize="characters" maxLength={30} aria-label="Gift card code" placeholder="Scan or type the card's code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void check(); }} /></label>
      {error}
      <div className="actions"><button onClick={() => go("menu")}>Back</button><button className="primary" disabled={busy || !code.trim()} onClick={() => void check()}>Check</button></div>
    </Proto>
  );
  if (step === "card" && view) return (
    <Proto title={`Gift card · ${giftCode(view.card.code)}`} extra="splitdialog" onClose={onClose}>
      <div className="row"><span>Balance</span><strong style={{ fontSize: "1.25em" }}>{formatMoney(view.card.balanceCents)}</strong></div>
      {!view.card.active && <div className="error warn" role="alert">This card is switched off. It cannot be spent or loaded.</div>}
      <h3>What happened to it</h3>
      <table className="rep" aria-label="Gift card history"><tbody>
        {view.entries.map((e) => <tr key={e.id}><td>{new Date(e.at).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" })} · {GIFT_KIND[e.kind] ?? e.kind}{e.kind === "load" && e.tender ? ` (${e.tender})` : ""}</td><td>{e.amountCents < 0 ? "−" : "+"}{formatMoney(Math.abs(e.amountCents))}</td><td>{formatMoney(e.balanceAfter)}</td></tr>)}
      </tbody></table>
      {error}
      <div className="actions">
        {canSwitch && <button onClick={() => void switchCard(!view.card.active)}>{view.card.active ? "Switch card off" : "Switch card on"}</button>}
        <button onClick={() => { setCode(""); go("check"); }}>Another card</button>
        <button className="primary" disabled={!view.card.active} onClick={() => go("load")}>Load more</button>
      </div>
    </Proto>
  );
  if (step === "load" && view) return (
    <Proto title={`Load · ${giftCode(view.card.code)}`} onClose={onClose}>
      <div className="row"><span>On the card now</span><strong>{formatMoney(view.card.balanceCents)}</strong></div>
      {amountField}
      {paidBy}
      {error}
      <div className="actions"><button onClick={() => go("card")}>Back</button><button className="primary" disabled={busy || !(cents > 0)} onClick={() => void load(true)}>Load{cents > 0 ? ` · ${formatMoney(cents)}` : ""}</button></div>
    </Proto>
  );
  return (
    <Proto title="Gift Cards" onClose={onClose}>
      <p className="muted">A gift card is a code with a balance. Sell one here; take it as payment by choosing Gift Card on the payment screen and entering its code.</p>
      <div className="settingsgroup">
        <button className="primary" onClick={() => { freshKey(); go("sell"); }}>Sell a new card</button>
        <button onClick={() => go("check")}>Check a card · balance and history</button>
      </div>
      <div className="actions"><button onClick={onClose}>Close</button></div>
    </Proto>
  );
}
