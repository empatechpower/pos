import { useState } from "react";
import { formatMoney } from "@pos/core";
import { Modal } from "./Modal";
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

export function CustomerDialog({ current, balance, onSave, onClose }: { current: string; balance: number | null; onSave: (id: string) => void; onClose: () => void }) {
  const [v, setV] = useState(current);
  return (
    <Modal title="Member" onClose={onClose}>
      <label className="t-field">Phone or member code<input value={v} inputMode="tel" autoFocus onChange={(e) => setV(e.target.value.trim())} /></label>
      {current && balance !== null && <p className="t-muted">Credit balance: <b>{formatMoney(balance)}</b></p>}
      <div className="t-dact">{current && <button className="t-ghost" onClick={() => { onSave(""); onClose(); }}>Remove</button>}<button className="t-ghost" onClick={onClose}>Cancel</button><button className="t-primary" onClick={() => { onSave(v); onClose(); }}>OK</button></div>
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
