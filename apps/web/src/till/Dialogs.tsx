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

export function TillSettings({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  return (
    <Modal title="My till settings" onClose={onClose}>
      <h3 className="t-h3">Menu panel</h3>
      <p className="t-muted">Which side the menu sits on. Yours alone: it follows you to any till.</p>
      <div className="t-seg">{(["left", "right"] as const).map((s) => <button key={s} className={prefs.menuSide === s ? "on" : ""} onClick={() => void setPref("menuSide", s)}>{s === "left" ? "Left" : "Right"}</button>)}</div>
      <h3 className="t-h3">Text size</h3>
      <p className="t-muted">Standard is 20% bigger than the original size.</p>
      <div className="t-seg">{([["compact", "Compact"], ["standard", "Standard"], ["large", "Large"], ["xl", "Extra large"]] as const).map(([k, l]) => <button key={k} className={prefs.textSize === k ? "on" : ""} onClick={() => void setPref("textSize", k)}>{l}</button>)}</div>
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
