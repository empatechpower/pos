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

  if (arranging) {
    return (
      <div className="t-strip arranging">
        <div className="t-arrbar">
          <b>Arrange actions</b><span className="t-arrhint">{sel ? "Now tap the one to swap with." : "Tap one action, then another, to swap places."}</span>
          <span className="t-spacer" />
          <button className="t-ghost" onClick={() => setAdding((v) => !v)}>＋ Add action</button>
          <button className="t-primary" onClick={() => { setArranging(false); setSel(null); setAdding(false); }}>Done</button>
        </div>
        {adding && <div className="t-arradd">{off.length === 0 ? <span className="t-muted">Every action is already on the strip.</span> : off.map((a) => <button key={a.id} className="t-ghost" onClick={() => { commit([...ids, a.id], hidden.filter((h) => h !== a.id)); setAdding(false); }}>{a.icon} {a.label}</button>)}</div>}
        <div className="t-arrgrid">
          {actions.map((a) => (
            <div className={`t-action ${sel === a.id ? "sel" : ""}`} key={a.id}>
              <button onClick={() => tap(a)} aria-label={a.label}>{a.icon}</button>
              <span>{a.label}</span>
              <button className="t-actx" aria-label={`Remove ${a.label}`} onClick={(e) => { e.stopPropagation(); commit(ids.filter((x) => x !== a.id), [...hidden, a.id]); setSel(null); }}>×</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const pages: Action[][] = [];
  for (let i = 0; i < actions.length; i += 4) pages.push(actions.slice(i, i + 4));
  return (
    <div className="t-strip">
      <div className="t-actionpages">
        {pages.map((pg, i) => (
          <div className="t-actionpage" key={i}>
            {pg.map((a) => (
              <div className="t-action" key={a.id}>
                <button onClick={() => tap(a)} disabled={a.disabled} title={a.title} aria-label={a.label} {...holdProps(a)}>{a.icon}{a.badge ? <i className="t-abadge">{a.badge}</i> : null}</button>
                <span>{a.label}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="t-action t-payaction">
        <button className="t-pay" onClick={onPay} disabled={payDisabled} aria-label={payLabel}>$</button>
        <span>Pay</span>
      </div>
    </div>
  );
}
