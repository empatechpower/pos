import { useRef, useState } from "react";

/** One button of the action strip: a round icon with a small label under it. */
export interface Action { id: string; label: string; icon: string; onClick: () => void; disabled?: boolean; title?: string; badge?: string | number }
export interface ActionPref { order: string[]; hidden: string[] }

/**
 * The actions sit in pages of four that slide sideways; Pay stays pinned at the right on the same line.
 * A manager can press and hold an action to arrange them right here: tap one action, then another, to swap
 * their places; × takes one off the strip; "Add action" brings a hidden one back. It is the shop's strip, so it saves for every till.
 */
export function ActionStrip({ actions, everything, pref, canArrange, onArrange, payLabel, onPay, payDisabled }: {
  actions: Action[]; payLabel: string; onPay: () => void; payDisabled: boolean;
  /** Every action there is, hidden ones too, in the shop's order: what the arrange mode picks from. */
  everything?: Action[]; pref?: ActionPref; canArrange?: boolean; onArrange?: (next: ActionPref) => void;
}) {
  const [arranging, setArranging] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const timer = useRef<number | null>(null);
  const suppress = useRef(0);
  const ids = actions.map((a) => a.id);
  const hidden = pref?.hidden ?? [];
  const commit = (order: string[], hide: string[]) => onArrange?.({ order, hidden: hide });
  const swap = (a: string, b: string) => { const o = [...ids]; const i = o.indexOf(a), j = o.indexOf(b); if (i >= 0 && j >= 0) { [o[i], o[j]] = [o[j]!, o[i]!]; commit(o, hidden); } };
  const tap = (a: Action) => {
    if (Date.now() < suppress.current) return;
    if (!arranging) return a.onClick();
    if (!sel || sel === a.id) return setSel(sel === a.id ? null : a.id);
    swap(sel, a.id); setSel(null);
  };
  const holdProps = (_a: Action) => ({
    onPointerDown: () => { if (!canArrange || arranging) return; timer.current = window.setTimeout(() => { suppress.current = Date.now() + 700; setArranging(true); setSel(null); }, 650); },
    onPointerUp: () => { if (timer.current) window.clearTimeout(timer.current); },
    onPointerLeave: () => { if (timer.current) window.clearTimeout(timer.current); },
    onPointerCancel: () => { if (timer.current) window.clearTimeout(timer.current); },
  });
  const off = (everything ?? []).filter((a) => hidden.includes(a.id));

  const face = (a: Action) => (a.id === "qty" && a.badge ? a.badge : <>{a.icon}{a.badge ? <i className="abadge">{a.badge}</i> : null}</>);
  // The markup and class names are the prototype's own (proto-reference/index.html, actionStripHTML and render).
  if (arranging) {
    return (
      <div className="actionstrip arranging">
        <div className="actionbar"><span>Arrange actions</span><span className="sp" /><button onClick={() => setAdding((v) => !v)}>+ Add action</button><button className="primary" onClick={() => { setArranging(false); setSel(null); setAdding(false); }}>Done</button></div>
        {adding && <div className="actionadd">{off.length === 0 ? <span className="muted">All actions are already on the strip.</span> : off.map((a) => <button key={a.id} onClick={() => { commit([...ids, a.id], hidden.filter((h) => h !== a.id)); setAdding(false); }}>{a.icon} {a.label}</button>)}</div>}
        <div className="actionpages">
          <div className="actionpage arrange">
            {actions.map((a) => (
              <div className={`action ${sel === a.id ? "sel" : ""}`} key={a.id}>
                <button onClick={() => tap(a)} aria-label={a.label}>{face(a)}</button>
                <span>{a.label}</span>
                <button className="actx" aria-label={`Remove ${a.label}`} onClick={(e) => { e.stopPropagation(); commit(ids.filter((x) => x !== a.id), [...hidden, a.id]); setSel(null); }}>×</button>
              </div>
            ))}
          </div>
        </div>
        {/* Pay is not shown while arranging (prototype v2.52): it cannot be moved, and its place is given to the actions. */}
      </div>
    );
  }

  const pages: Action[][] = [];
  for (let i = 0; i < actions.length; i += 4) pages.push(actions.slice(i, i + 4));
  if (!pages.length) pages.push([]);
  return (
    <div className="actionstrip">
      <div className="actionpages">
        {pages.map((pg, i) => (
          <div className="actionpage" key={i}>
            {pg.map((a) => (
              <div className="action" key={a.id}>
                <button onClick={() => tap(a)} disabled={a.disabled} title={a.title} aria-label={a.label} {...holdProps(a)}>{face(a)}</button>
                <span>{a.label}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="action payaction">
        <button className="pay" onClick={onPay} disabled={payDisabled} aria-label={payLabel}>$</button>
        <span>Pay</span>
      </div>
    </div>
  );
}
