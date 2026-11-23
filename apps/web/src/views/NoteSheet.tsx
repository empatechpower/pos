import { useState } from "react";

const QUICK = ["No spicy", "Less spicy", "Less sweet", "No ice", "No onion", "Allergy: nuts", "Pack separately"];

/** A short note for the kitchen: on one item, or on the whole order. Quick phrases add to it with a tap. */
export function NoteSheet({ title, initial, max, onSave, onClose }: { title: string; initial: string; max: number; onSave: (note: string) => void; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const add = (q: string) => setText((t) => (t.includes(q) ? t : (t ? `${t}; ${q}` : q).slice(0, max)));
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", zIndex: 60 }}>
      <div style={{ background: "var(--bg, #fff)", color: "var(--fg, #111)", borderRadius: 14, padding: 20, width: "min(94vw, 440px)" }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {QUICK.map((q) => <button key={q} type="button" className="secondary sm" onClick={() => add(q)}>{q}</button>)}
        </div>
        <label className="field">Note for the kitchen
          <textarea autoFocus rows={3} maxLength={max} value={text} onChange={(e) => setText(e.target.value)} style={{ width: "100%" }} />
        </label>
        <p className="muted">{text.length}/{max}</p>
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          {initial && <button className="secondary sm" onClick={() => onSave("")}>Remove note</button>}
          <button className="secondary sm" onClick={onClose}>Cancel</button>
          <button className="primary sm" disabled={text.trim() === initial.trim()} onClick={() => onSave(text.trim())}>Save</button>
        </div>
      </div>
    </div>
  );
}
