import { useState } from "react";
import { formatMoney } from "@pos/core";
import { Modal } from "./Modal";
import { staffFetch } from "../auth";
import { setPref, usePrefs } from "../prefs";
import type { HeldOrder } from "./types";

export function DiningDialog({ channels, current, onPick, onClose }: { channels: Array<{ id: string; name: string }>; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const [sel, setSel] = useState(current);
  return (
    <Modal title="Dining" onClose={onClose}>
      {channels.map((c) => <button key={c.id} className={`t-radio ${sel === c.id ? "on" : ""}`} onClick={() => setSel(c.id)}><i>{sel === c.id ? "◉" : "○"}</i> {c.name}</button>)}
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" onClick={() => { onPick(sel); onClose(); }}>OK</button></div>
    </Modal>
  );
}

export function GuestsDialog({ current, onSave, onClose }: { current: number; onSave: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState(current);
  const ok = Number.isInteger(n) && n >= 1 && n <= 99;
  return (
    <Modal title="Enter Guest Count" onClose={onClose}>
      {[1, 2, 3, 4, 5, 6].map((k) => <button key={k} className={`t-radio ${n === k ? "on" : ""}`} onClick={() => setN(k)}><i>{n === k ? "◉" : "○"}</i> {k} guest{k === 1 ? "" : "s"}</button>)}
      <label className="t-field">Guest count<input type="number" inputMode="numeric" min={1} max={99} value={n} onChange={(e) => setN(Number(e.target.value))} /></label>
      {!ok && <p className="t-err" role="alert">Enter a guest count from 1 to 99.</p>}
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" disabled={!ok} onClick={() => { onSave(n); onClose(); }}>OK</button></div>
    </Modal>
  );
}

export function QuantityDialog({ current, onSave, onClose }: { current: number; onSave: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState(current);
  return (
    <Modal title="Quantity" onClose={onClose}>
      <p className="t-muted">Applies to the next item added, then goes back to 1.</p>
      <div className="t-stepper"><button onClick={() => setN(Math.max(1, n - 1))}>−</button><strong>{n}</strong><button onClick={() => setN(Math.min(99, n + 1))}>+</button></div>
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" onClick={() => { onSave(n); onClose(); }}>Set</button></div>
    </Modal>
  );
}

export function HeldDialog({ held, onRecall, onDrop, onClose, formatTotal }: { held: HeldOrder[]; onRecall: (id: string) => void; onDrop: (id: string) => void; onClose: () => void; formatTotal: (h: HeldOrder) => number }) {
  return (
    <Modal title="Held orders" onClose={onClose}>
      {held.length === 0 ? <p className="t-muted">No held orders.</p> : held.map((h) => (
        <div key={h.id} className="t-heldrow">
          <button onClick={() => { onRecall(h.id); onClose(); }}>
            <b>{h.bag.reduce((n, l) => n + l.qty, 0)} items · {formatMoney(formatTotal(h))}</b>
            <small>{new Date(h.savedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}{h.spot ? ` · ${h.spot}` : ""}{h.pax > 1 ? ` · ${h.pax} guests` : ""}</small>
          </button>
          <button className="t-ghost" onClick={() => onDrop(h.id)}>Discard</button>
        </div>
      ))}
    </Modal>
  );
}

/** A member as the till shows them: who they are, what they hold, and their last orders. */
export interface MemberSummary {
  member: { id: string; name: string | null; phone: string | null; email: string | null; points: number; creditCents: number };
  rewards: { pointsEnabled: boolean; minPointsRedeem: number };
  recent: Array<{ orderId: string; at: number; totalCents: number; status: string; items: string; where: string }>;
}
const isMemberId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);
export async function loadMember(id: string): Promise<MemberSummary | null> {
  if (!isMemberId(id)) return null;
  const r = await staffFetch(`/api/members/${id}/summary`);
  return "res" in r && r.res.ok ? ((await r.res.json()) as MemberSummary) : null;
}
const maskPhone = (p: string | null) => (p ? `···· ${p.replace(/\D/g, "").slice(-4)}` : "");
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
      <Modal title="Member" onClose={onClose}>
        <p style={{ margin: "0 0 .3em" }}><b>{m.name || "Member"}</b> <span className="t-muted">{maskPhone(m.phone)}</span></p>
        <div className="t-row2"><span>Credit</span><b>{formatMoney(m.creditCents)}</b></div>
        {info.rewards.pointsEnabled && <div className="t-row2"><span>Points</span><b>{m.points.toLocaleString()}</b></div>}
        {info.rewards.pointsEnabled && m.points > 0 && (
          <label className="t-row2" style={{ cursor: "pointer" }}><span>Use points on this order{pointsWorthCents > 0 ? ` (${formatMoney(pointsWorthCents)} off)` : ""}</span><input type="checkbox" aria-label="Use points on this order" checked={usePoints} disabled={m.points < info.rewards.minPointsRedeem} onChange={(e) => onUsePoints(e.target.checked)} /></label>
        )}
        {info.rewards.pointsEnabled && m.points > 0 && m.points < info.rewards.minPointsRedeem && <p className="t-muted">Points can be used from {info.rewards.minPointsRedeem} points.</p>}
        <h3 className="t-h3">Last orders</h3>
        <div aria-label="Last orders">
          {info.recent.length === 0 && <p className="t-muted">No orders yet.</p>}
          {info.recent.map((o) => <div className="t-row2" key={o.orderId}><span>{memberWhen(o.at)} · {o.items}{o.status !== "paid" ? ` · ${o.status}` : ""}</span><span>{formatMoney(o.totalCents)}</span></div>)}
        </div>
        <div className="t-dact"><button className="t-ghost" onClick={() => { onSave(""); onClose(); }}>Remove</button><button className="t-primary" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }
  return (
    <Modal title="Member" onClose={onClose}>
      {current && <p className="t-muted">On this order: {current} <button className="t-ghost" onClick={() => { onSave(""); onClose(); }}>Remove</button></p>}
      {!adding ? (
        <>
          <label className="t-field">Name or phone<input value={q} inputMode="search" autoFocus aria-label="Find a member" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} /></label>
          <div className="t-dact" style={{ justifyContent: "flex-start" }}><button className="t-primary" disabled={busy} onClick={() => void search()}>Find</button><button className="t-ghost" onClick={() => { setAdding(true); setPhone(/^[+\d\s]+$/.test(q) ? q : ""); setName(/^[+\d\s]+$/.test(q) ? "" : q); setMsg(""); }}>Add a new member</button></div>
          {found && found.length === 0 && <p className="t-muted">Nobody found. Check the spelling, or add them as a new member.</p>}
          {found && found.length === 0 && q.trim() && <button className="t-ghost" onClick={() => { onSave(q.trim()); onClose(); }}>Use "{q.trim()}" as a credit code only</button>}
          {found?.map((m) => <button key={m.id} className="t-radio" onClick={() => { onSave(m.id); onClose(); }}><i>○</i> {m.name || "Member"} {maskPhone(m.phone)} <span className="t-muted">· {formatMoney(m.creditCents)} credit{m.points ? ` · ${m.points} pts` : ""}</span></button>)}
        </>
      ) : (
        <>
          <label className="t-field">Name<input value={name} maxLength={60} aria-label="New member name" onChange={(e) => setName(e.target.value)} /></label>
          <label className="t-field">Phone, with country code<input value={phone} inputMode="tel" aria-label="New member phone" placeholder="+65 8111 1111" onChange={(e) => setPhone(e.target.value)} /></label>
          <div className="t-dact"><button className="t-ghost" onClick={() => setAdding(false)}>Back</button><button className="t-primary" disabled={busy || phone.replace(/\D/g, "").length < 8} onClick={() => void add()}>Add and attach</button></div>
        </>
      )}
      {msg && <p className="t-muted" role="alert">{msg}</p>}
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

export function TillSettings({ onClose, onEditLayout }: { onClose: () => void; onEditLayout?: () => void }) {
  const prefs = usePrefs();
  return (
    <Modal title="My till settings" onClose={onClose}>
      <h3 className="t-h3">Menu panel</h3>
      <p className="t-muted">Which side the menu sits on. Yours alone: it follows you to any till.</p>
      <div className="t-seg">{(["left", "right"] as const).map((s) => <button key={s} className={prefs.menuSide === s ? "on" : ""} onClick={() => void setPref("menuSide", s)}>{s === "left" ? "Left" : "Right"}</button>)}</div>
      <h3 className="t-h3">Text size</h3>
      <p className="t-muted">Standard is 20% bigger than the original size.</p>
      <div className="t-seg">{([["compact", "Compact"], ["standard", "Standard"], ["large", "Large"], ["xl", "Extra large"]] as const).map(([k, l]) => <button key={k} className={prefs.textSize === k ? "on" : ""} onClick={() => void setPref("textSize", k)}>{l}</button>)}</div>
      {onEditLayout && (
        <>
          <h3 className="t-h3">Menu layout</h3>
          <p className="t-muted">Arrange the tiles and pages your way. You can also press and hold any tile.</p>
          <button className="t-ghost" onClick={onEditLayout}>Edit my menu layout</button>
        </>
      )}
      <p className="t-muted" style={{ marginTop: ".8em" }}><a href="/settings">All settings</a></p>
      <div className="t-dact"><button className="t-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

export function DoneDialog({ queue, changeCents, totalCents, onClose }: { queue?: string; changeCents: number; totalCents: number; onClose: () => void }) {
  return (
    <Modal title="Payment complete" onClose={onClose}>
      <div className="t-donebox">
        {queue && <><small>QUEUE NUMBER</small><div className="t-queue">{queue}</div></>}
        <p>Paid <b>{formatMoney(totalCents)}</b></p>
        {changeCents > 0 && <p className="t-change">Change due <b>{formatMoney(changeCents)}</b></p>}
      </div>
      <div className="t-dact"><button className="t-primary" autoFocus onClick={onClose}>New order</button></div>
    </Modal>
  );
}

/** A fee on the whole order: a preset percentage of the items, or your own percentage or amount. Added fees are listed and can be taken off. */
export function FeeDialog({ fees, onAdd, onRemove, onClose }: { fees: Array<{ id: string; kind: "percent" | "amount"; value: number; label: string }>; onAdd: (kind: "percent" | "amount", value: number, label: string) => void; onRemove: (id: string) => void; onClose: () => void }) {
  const [label, setLabel] = useState("Service fee");
  const [custom, setCustom] = useState("");
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const n = Number(custom);
  const ok = custom !== "" && n > 0 && (mode === "amount" ? n <= 10000 : n <= 100);
  return (
    <Modal title="Service Fee" onClose={onClose}>
      <p className="t-muted">A fee on the whole order, on top of the items. It is recorded with who added it.</p>
      <label className="t-field">Name on the receipt<input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="t-chiprow"><span>Quick</span>{[5, 10, 15].map((p) => <button key={p} onClick={() => { onAdd("percent", p, label.trim() || "Service fee"); onClose(); }}>{p}%</button>)}</div>
      <div className="t-chiprow"><span>Your own</span>
        <button className={mode === "percent" ? "on" : ""} onClick={() => setMode("percent")}>%</button>
        <button className={mode === "amount" ? "on" : ""} onClick={() => setMode("amount")}>S$</button>
        <input inputMode="decimal" aria-label="Fee amount" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))} placeholder={mode === "percent" ? "e.g. 7.5" : "e.g. 3.00"} style={{ width: "7em" }} />
        <button className="t-primary" disabled={!ok} onClick={() => { onAdd(mode, mode === "amount" ? Math.round(n * 100) : n, label.trim() || "Service fee"); onClose(); }}>Add</button>
      </div>
      {fees.length > 0 && <><h3 className="t-h3">On this order</h3>{fees.map((f) => <div className="t-heldrow" key={f.id}><span style={{ flex: 1 }}>{f.label} · {f.kind === "percent" ? `${f.value}%` : formatMoney(f.value)}</span><button className="t-ghost" onClick={() => onRemove(f.id)}>Remove</button></div>)}</>}
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Close</button></div>
    </Modal>
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
    <Modal title="Add Extra Item" onClose={onClose}>
      <p className="t-muted">An item that is not on the menu. It goes on the order like any other and is sent to the kitchen.</p>
      <label className="t-field">Name<input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
      <label className="t-field">Price (S$)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" /></label>
      <div className="t-stepper"><button onClick={() => setQty(Math.max(1, qty - 1))}>−</button><strong>{qty}</strong><button onClick={() => setQty(Math.min(99, qty + 1))}>+</button></div>
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" disabled={!ok} onClick={() => { onAdd(name.trim(), cents, qty); onClose(); }}>Add to order</button></div>
    </Modal>
  );
}

/** Add/Remove Tax: take the tax off the whole order, with a reason, or put it back. It is written to the order with who did it. */
export function TaxDialog({ name, current, onSet, onClose }: { name: string; current: { reason: string } | null; onSet: (t: { reason: string } | null) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  if (current) {
    return (
      <Modal title={`Add ${name}`} onClose={onClose}>
        <p className="t-muted">{name} was taken off this order: {current.reason}</p>
        <div className="t-dact"><button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" onClick={() => { onSet(null); onClose(); }}>Put {name} back</button></div>
      </Modal>
    );
  }
  return (
    <Modal title={`Remove ${name}`} onClose={onClose}>
      <p className="t-muted">Takes {name} off the whole order. It is recorded on the order with your name and the reason.</p>
      <label className="t-field">Reason<input value={reason} maxLength={120} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Why is this sale not taxed?" /></label>
      <div className="t-dact"><button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" disabled={reason.trim().length < 3} onClick={() => { onSet({ reason: reason.trim() }); onClose(); }}>Remove {name}</button></div>
    </Modal>
  );
}
