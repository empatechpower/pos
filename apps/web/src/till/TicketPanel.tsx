import { useRef, useState, type ReactNode } from "react";
import { COURSE_NAMES, formatMoney, optionLines } from "@pos/core";
import { effUnit, type BagLine } from "./types";

/** The details under a line: its choices, a price set by hand, discounts, and the kitchen note. */
function details(l: BagLine): Array<{ text: string; amount?: string; strong?: boolean }> {
  const out: Array<{ text: string; amount?: string; strong?: boolean }> = [];
  for (const o of l.options) out.push({ text: optionLines([o])[0]!, amount: o.priceCents ? `+${formatMoney(o.priceCents * (o.qty || 1))}` : undefined });
  if (l.override) out.push({ text: `Price ${formatMoney(l.unitCents)} → ${formatMoney(l.override.unitCents)} · ${l.override.reason}` });
  for (const d of l.discounts ?? []) out.push({ text: `${d.kind === "percent" ? `${d.value}% off` : `${formatMoney(d.value)} off`} · ${d.reason}` });
  if (l.memberPriced && !l.override) out.push({ text: `Member price (usual ${formatMoney(l.unitCents + (l.item.priceCents - (l.item.memberPriceCents ?? l.item.priceCents)))})` });
  if (l.note) out.push({ text: `Note: ${l.note}`, strong: true });
  return out;
}

function Line({ l, kitchen, collapsed, onToggle, onHold, onEdit, onQty, onRemove, bin, setBin, swipeRemoves }: { l: BagLine; /** Where a sent line is in the kitchen. */ kitchen?: "ready" | "served"; collapsed: boolean; onToggle: () => void; /** Press and hold: sell this line through the next dining channel. */ onHold?: () => void; onEdit: () => void; onQty: (d: number) => void; onRemove: () => void; bin: boolean; setBin: (open: boolean) => void; swipeRemoves: boolean }) {
  const det = details(l);
  // What the prototype puts on the grey line under the details; ours adds "sent", the seat and "Held".
  const meta = [l.sent ? (kitchen === "served" ? "✓ served" : kitchen === "ready" ? "● ready to serve" : "✓ sent") : "", l.course ? COURSE_NAMES[l.course] ?? `Course ${l.course}` : "", l.seat ? `Seat ${l.seat}` : "", l.channelName ?? "", l.hold ? "Held" : ""].filter(Boolean);
  const more = det.length > 0 || meta.length > 0;
  const open = more && !collapsed;
  const tap = useRef<{ at: number; timer: number | null }>({ at: 0, timer: null });
  const drag = useRef<{ x: number; y: number; moved: boolean; dx: number } | null>(null);
  const [slide, setSlide] = useState(0);
  // Press and hold (650 ms, without sliding) changes the line's dining channel. The tap that ends the hold does nothing more.
  const hold = useRef<{ timer: number | null; until: number }>({ timer: null, until: 0 });
  const endHold = () => { if (hold.current.timer) { window.clearTimeout(hold.current.timer); hold.current.timer = null; } };

  function click() {
    if (Date.now() < hold.current.until) return;
    if (drag.current?.moved) return;
    if (bin) return setBin(false);
    if (!more) return onEdit();
    // On a line with details a quick second tap folds or unfolds them; a single tap opens the line.
    const now = Date.now();
    if (tap.current.timer && now - tap.current.at < 320) { window.clearTimeout(tap.current.timer); tap.current.timer = null; return onToggle(); }
    tap.current.at = now;
    tap.current.timer = window.setTimeout(() => { tap.current.timer = null; onEdit(); }, 300);
  }
  const shift = swipeRemoves ? slide : bin ? -64 : 0;
  return (
    <div className="linewrap">
      <div
        className={`line ${bin ? "binopen" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`Edit ${l.item.name}`}
        style={shift ? { transform: `translateX(${shift}px)`, transition: swipeRemoves ? "none" : "transform .15s" } : undefined}
        onKeyDown={(e) => { if (e.key === "Enter") onEdit(); }}
        onClick={click}
        onPointerDown={(e) => { if (l.sent || (e.target as HTMLElement).closest("button,.lname")) return; drag.current = { x: e.clientX, y: e.clientY, moved: false, dx: 0 }; endHold(); if (onHold) hold.current.timer = window.setTimeout(() => { hold.current.timer = null; if (drag.current?.moved) return; hold.current.until = Date.now() + 900; onHold(); }, 650); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x; if (Math.abs(dx) > 12 || Math.abs(e.clientY - d.y) > 12) endHold(); if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(e.clientY - d.y)) { d.moved = true; d.dx = dx; if (swipeRemoves) setSlide(Math.min(0, dx)); else setBin(dx < -40); } }}
        onPointerLeave={endHold}
        onPointerCancel={endHold}
        onPointerUp={() => { endHold(); const d = drag.current; if (swipeRemoves && d?.moved) { if (d.dx <= -72) onRemove(); setSlide(0); } window.setTimeout(() => { drag.current = null; }, 0); }}
      >
        <div className="ticketrow">
          <h3 className="lnamecell">
            <span className="lname">{l.item.name}</span>
            {more && <button className="lmore" aria-label={open ? "Collapse details" : "Expand details"} onClick={(e) => { e.stopPropagation(); onToggle(); }}>{open ? "▴" : "▾"}</button>}
          </h3>
          <div className="qtycell">
            <b>{l.qty}</b>
            <div className="qtycontrols">
              <button aria-label="Increase quantity" disabled={!!l.sent} onClick={(e) => { e.stopPropagation(); onQty(1); }}><span>+</span></button>
              <button aria-label="Decrease quantity" disabled={!!l.sent} onClick={(e) => { e.stopPropagation(); onQty(-1); }}><span>−</span></button>
            </div>
          </div>
          <span>{formatMoney(effUnit(l))}</span>
          <span>{formatMoney(effUnit(l) * l.qty)}</span>
        </div>
        {open && det.map((d, i) => <div key={i} className="ldetail" style={d.strong ? { fontWeight: 700 } : undefined}><span className="ld-name">{d.text}</span>{d.amount && <span className="ld-amt">{d.amount}</span>}</div>)}
        {open && meta.length > 0 && <div className="ldetail meta"><span className="ld-name">{meta.join(" · ")}</span></div>}
      </div>
      <button className="binbtn" aria-label={`Remove ${l.item.name}`} onClick={onRemove}>🗑</button>
    </div>
  );
}

/**
 * The ticket: who and where, the lines (one each, details open until folded), the totals, and the action strip with Pay.
 * The markup and class names are the prototype's own (proto-reference/index.html, render and lineHTML), styled by its stylesheet.
 */
export function TicketPanel(p: {
  channelName: string; title: string; subline: string; shiftChip: ReactNode; bag: BagLine[]; flash: string | null;
  onDining: () => void; onNew: () => void; onQty: (key: string, d: number) => void; onEdit: (key: string) => void; onRemove: (key: string) => void;
  lineRemove?: "bin" | "swipe";
  /** Press and hold a line that is not sent yet. */
  onHoldLine?: (key: string) => void;
  /** Kitchen progress of sent lines, by the order's line id. */
  kitchen?: Record<string, "ready" | "served">;
  totals: ReactNode; strip: ReactNode; extra?: ReactNode; open: boolean; onCloseSheet: () => void;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [bin, setBin] = useState<string | null>(null);
  const toggle = (k: string) => setFolded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <aside className={`bill ${p.open ? "open" : ""}`} aria-label="Order">
      <div className="billtop">
        <div className="billtitle">
          <button className="closebill" onClick={p.onCloseSheet} aria-label="Close bill">⌄</button>
          <button className="chanchip" onClick={p.onDining} title="Dining option — tap to change">{p.channelName} ▾</button>
          <h2>{p.title}</h2>
          <button className="primary newcircle" onClick={p.onNew} aria-label="New order">+</button>
          <small>{p.subline}</small>
        </div>
        <div className="orderinfo">{p.shiftChip}</div>
      </div>
      <div className="tickethead"><span>Name</span><span>Qty</span><span>Each</span><span>Total</span></div>
      <div id="lines" className={`lines ${p.lineRemove === "swipe" ? "" : "binmode"}`}>
        {p.bag.length === 0 ? <div className="empty"><b>＋</b><strong>Your order starts here</strong><span>Tap an item to add it to the ticket</span></div> : p.bag.map((l) => (
          <Line key={l.key} l={l} kitchen={l.sent ? p.kitchen?.[l.sent.lineId] : undefined} collapsed={folded.has(l.key)} onToggle={() => toggle(l.key)} onHold={p.onHoldLine && !l.sent ? () => p.onHoldLine!(l.key) : undefined} onEdit={() => p.onEdit(l.key)} onQty={(d) => p.onQty(l.key, d)} onRemove={() => { setBin(null); p.onRemove(l.key); }} swipeRemoves={p.lineRemove === "swipe"} bin={bin === l.key} setBin={(o) => setBin(o ? l.key : null)} />
        ))}
      </div>
      <div className="billfooter">
        {p.extra}
        {p.totals}
        {p.strip}
        <p className="hint">Tap line to edit · Double-tap line to fold its details</p>
      </div>
      {p.flash && <div className="notice" role="status">{p.flash}</div>}
    </aside>
  );
}
