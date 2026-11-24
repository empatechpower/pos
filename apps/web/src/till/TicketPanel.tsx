import { useRef, useState, type ReactNode } from "react";
import { COURSE_NAMES, formatMoney, optionLines } from "@pos/core";
import { effUnit, type BagLine } from "./types";

/** The details under a line: its choices, a price set by hand, discounts, and the kitchen note. */
function details(l: BagLine): Array<{ text: string; amount?: string; strong?: boolean }> {
  const out: Array<{ text: string; amount?: string; strong?: boolean }> = [];
  for (const o of l.options) out.push({ text: optionLines([o])[0]!, amount: o.priceCents ? `+${formatMoney(o.priceCents * (o.qty || 1))}` : undefined });
  if (l.override) out.push({ text: `Price ${formatMoney(l.unitCents)} → ${formatMoney(l.override.unitCents)} · ${l.override.reason}` });
  for (const d of l.discounts ?? []) out.push({ text: `${d.kind === "percent" ? `${d.value}% off` : `${formatMoney(d.value)} off`} · ${d.reason}` });
  if (l.note) out.push({ text: `Note: ${l.note}`, strong: true });
  return out;
}

function Line({ l, collapsed, onToggle, onEdit, onQty, onRemove, bin, setBin, swipeRemoves }: { l: BagLine; collapsed: boolean; onToggle: () => void; onEdit: () => void; onQty: (d: number) => void; onRemove: () => void; bin: boolean; setBin: (open: boolean) => void; swipeRemoves: boolean }) {
  const det = details(l);
  const more = det.length > 0;
  const open = more && !collapsed;
  const tap = useRef<{ at: number; timer: number | null }>({ at: 0, timer: null });
  const drag = useRef<{ x: number; y: number; moved: boolean; dx: number } | null>(null);
  const [slide, setSlide] = useState(0);

  function click() {
    if (drag.current?.moved) return;
    if (!more) return onEdit();
    // On a line with details a quick second tap folds or unfolds them; a single tap opens the line.
    const now = Date.now();
    if (tap.current.timer && now - tap.current.at < 320) { window.clearTimeout(tap.current.timer); tap.current.timer = null; return onToggle(); }
    tap.current.at = now;
    tap.current.timer = window.setTimeout(() => { tap.current.timer = null; onEdit(); }, 300);
  }
  return (
    <div className="t-linewrap">
      {!swipeRemoves && <button className="t-bin" aria-label={`Remove ${l.item.name}`} onClick={onRemove}>🗑</button>}
      <div
        className={`t-line ${bin ? "binopen" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`Edit ${l.item.name}`}
        onKeyDown={(e) => { if (e.key === "Enter") onEdit(); }}
        onClick={click}
        onPointerDown={(e) => { if (l.sent || (e.target as HTMLElement).closest("button,.t-name")) return; drag.current = { x: e.clientX, y: e.clientY, moved: false, dx: 0 }; }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x; if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(e.clientY - d.y)) { d.moved = true; d.dx = dx; if (swipeRemoves) setSlide(Math.min(0, dx)); else setBin(dx < -40); } }}
        onPointerUp={() => { const d = drag.current; if (swipeRemoves && d?.moved) { if (d.dx <= -72) onRemove(); setSlide(0); } window.setTimeout(() => { drag.current = null; }, 0); }}
        style={swipeRemoves && slide ? { transform: `translateX(${slide}px)`, transition: "none" } : undefined}
      >
        <div className="t-row">
          <h3 className="t-namecell">
            <span className="t-name">{l.item.name}</span>
            {more && <button className="t-more" aria-label={open ? "Hide details" : "Show details"} onClick={(e) => { e.stopPropagation(); onToggle(); }}>{open ? "▴" : "▾"}</button>}
          </h3>
          <div className="t-qty">
            <b>{l.qty}</b>
            <span className="t-stack">
              <button aria-label="More" disabled={!!l.sent} onClick={(e) => { e.stopPropagation(); onQty(1); }}>+</button>
              <button aria-label="Fewer" disabled={!!l.sent} onClick={(e) => { e.stopPropagation(); onQty(-1); }}>−</button>
            </span>
          </div>
          <span className="t-each">{formatMoney(effUnit(l))}</span>
          <span className="t-amt">{formatMoney(effUnit(l) * l.qty)}</span>
        </div>
        {(l.sent || l.course || l.seat || l.channelName || l.hold) && (
          <div className="t-tags">
            {l.sent && <small className="t-tag sent" title="Already sent">✓ sent</small>}
            {l.course ? <small className="t-tag">{COURSE_NAMES[l.course] ?? `Course ${l.course}`}</small> : null}
            {l.seat ? <small className="t-tag">Seat {l.seat}</small> : null}
            {l.channelName ? <small className="t-tag">{l.channelName}</small> : null}
            {l.hold ? <small className="t-tag held">Held</small> : null}
          </div>
        )}
        {open && det.map((d, i) => <div key={i} className="t-detail" style={d.strong ? { fontWeight: 700 } : undefined}><span>{d.text}</span>{d.amount && <span>{d.amount}</span>}</div>)}
      </div>
    </div>
  );
}

/** The ticket: who and where, the lines (one each, details open until folded), the totals, and the action strip with Pay. */
export function TicketPanel(p: {
  channelName: string; title: string; subline: string; shiftChip: ReactNode; bag: BagLine[]; flash: string | null;
  onDining: () => void; onNew: () => void; onQty: (key: string, d: number) => void; onEdit: (key: string) => void; onRemove: (key: string) => void;
  lineRemove?: "bin" | "swipe";
  totals: ReactNode; strip: ReactNode; extra?: ReactNode; open: boolean; onCloseSheet: () => void;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [bin, setBin] = useState<string | null>(null);
  const toggle = (k: string) => setFolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <aside className={`t-ticket ${p.open ? "open" : ""}`} aria-label="Order">
      <button className="t-closesheet" onClick={p.onCloseSheet} aria-label="Close order sheet">⌄</button>
      <div className="t-tickethead">
        <div className="t-titlerow">
          <button className="t-chip" onClick={p.onDining} title="Dining option: tap to change">{p.channelName} ▾</button>
          <h2>{p.title}</h2>
          <button className="t-round t-new" onClick={p.onNew} aria-label="New order">＋</button>
        </div>
        <div className="t-sub">{p.subline}</div>
        <div className="t-chips">{p.shiftChip}</div>
        {p.flash && <div className="t-flash" role="status">{p.flash}</div>}
      </div>
      <div className="t-cols"><span>Name</span><span>Qty</span><span>Each</span><span>Total</span></div>
      <div className="t-lines">
        {p.bag.length === 0 ? <div className="t-empty"><b>＋</b><strong>Your order starts here</strong><span>Tap an item to add it to the ticket</span></div> : p.bag.map((l) => (
          <Line key={l.key} l={l} collapsed={folded.has(l.key)} onToggle={() => toggle(l.key)} onEdit={() => p.onEdit(l.key)} onQty={(d) => p.onQty(l.key, d)} onRemove={() => { setBin(null); p.onRemove(l.key); }} swipeRemoves={p.lineRemove === "swipe"} bin={bin === l.key} setBin={(o) => setBin(o ? l.key : null)} />
        ))}
      </div>
      {p.extra}
      <div className="t-foot">
        {p.totals}
        {p.strip}
        <p className="t-hint">Tap a line to edit it · Double-tap to fold its details</p>
      </div>
    </aside>
  );
}
