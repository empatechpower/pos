/** One button of the action strip: a round icon with a small label under it. */
export interface Action { id: string; label: string; icon: string; onClick: () => void; disabled?: boolean; title?: string; badge?: string | number }

/**
 * The actions sit in pages of four that slide sideways; Pay stays pinned at the right on the same line.
 * (Which actions show, and in what order, will become the merchant's to arrange.)
 */
export function ActionStrip({ actions, payLabel, onPay, payDisabled }: { actions: Action[]; payLabel: string; onPay: () => void; payDisabled: boolean }) {
  const pages: Action[][] = [];
  for (let i = 0; i < actions.length; i += 4) pages.push(actions.slice(i, i + 4));
  return (
    <div className="t-strip">
      <div className="t-actionpages">
        {pages.map((pg, i) => (
          <div className="t-actionpage" key={i}>
            {pg.map((a) => (
              <div className="t-action" key={a.id}>
                <button onClick={a.onClick} disabled={a.disabled} title={a.title} aria-label={a.label}>{a.icon}{a.badge ? <i className="t-abadge">{a.badge}</i> : null}</button>
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
