import { useMemo, useState } from "react";
import { tx } from "../shopI18n";
import { MAX_NOTE, PREFIX_LABEL, defaultSelection, formatMoney, resolveOptions, type ChosenOptionInput, type OptionGroup } from "@pos/core";

interface Props {
  name: string;
  description?: string;
  photoUrl?: string | null;
  /** The item's price before options. */
  baseCents: number;
  groups: OptionGroup[];
  /** Start from this selection (e.g. when editing); otherwise the defaults. */
  initial?: ChosenOptionInput[];
  /** Start the Special request box with this text (when editing). */
  initialNote?: string;
  cta?: string;
  /** Show the free-text Special request box (the customer shop; not the till). */
  notes?: boolean;
  /** The kiosk's version: the price under the name, a Quantity stepper, and Cancel beside "Add to order · total". */
  kiosk?: boolean;
  /** The till's version: a blue dialog titled "Select options · name", with Cancel and "Add · total" at the foot. */
  till?: boolean;
  onAdd: (selection: ChosenOptionInput[], note: string, qty: number) => void;
  onClose: () => void;
}

const MAX_EACH = 5;
const MAX_QTY = 20;
const countOf = (sel: ChosenOptionInput[], g: string, c: string) => sel.filter((s) => s.groupId === g && s.choiceId === c).reduce((n, s) => n + (s.qty ?? 1), 0);

/**
 * The customise screen: choose-one groups as pills, "pick any" as toggles, extras as steppers. The total and
 * the Add button follow the same rules the server applies, so what is shown is what is charged.
 */
export function OptionSheet({ name, description, photoUrl, baseCents, groups, initial, initialNote, cta = "Add to bag", notes, kiosk, till, onAdd, onClose }: Props) {
  const [sel, setSel] = useState<ChosenOptionInput[]>(initial ?? defaultSelection(groups));
  const [note, setNote] = useState(initialNote ?? "");
  const [qty, setQty] = useState(1);
  const r = useMemo(() => resolveOptions(groups, sel), [groups, sel]);
  const total = baseCents + (r.ok ? r.extraCents : 0);
  const missing = !r.ok && (r.error === "missing_required" || r.error === "too_few_options") ? groups.find((g) => g.id === r.groupId)?.name : null;

  /** What the item costs with this variant picked (other choices kept), so the tile, the total and the bag all say the same number. */
  const variantPrice = (g: OptionGroup, choiceId: string) => {
    const r2 = resolveOptions(groups, [...sel.filter((s) => s.groupId !== g.id), { groupId: g.id, choiceId }]);
    return baseCents + (r2.ok ? r2.extraCents : (g.choices.find((c) => c.id === choiceId)?.priceCents ?? 0));
  };
  const pickOne = (g: OptionGroup, choiceId: string) => setSel((cur) => [...cur.filter((s) => s.groupId !== g.id), { groupId: g.id, choiceId }]);
  const toggle = (g: OptionGroup, choiceId: string) =>
    setSel((cur) => (countOf(cur, g.id, choiceId) ? cur.filter((s) => !(s.groupId === g.id && s.choiceId === choiceId)) : [...cur, { groupId: g.id, choiceId }]));
  const step = (g: OptionGroup, choiceId: string, d: number) =>
    setSel((cur) => {
      const n = Math.max(0, Math.min(g.maxEach ?? MAX_EACH, countOf(cur, g.id, choiceId) + d));
      const at = cur.findIndex((s) => s.groupId === g.id && s.choiceId === choiceId);
      const rest = cur.filter((s) => !(s.groupId === g.id && s.choiceId === choiceId));
      if (!n) return rest;
      const next = { groupId: g.id, choiceId, qty: n };
      if (at < 0) return [...rest, next];
      const out = [...rest];
      out.splice(at, 0, next); // its first-pick position stays, because the free allowance follows the order things were picked
      return out;
    });
  const used = (g: OptionGroup) => sel.filter((s) => s.groupId === g.id).reduce((n, s) => n + (s.qty ?? 1), 0);

  return (
    <div className={`opt-back ${till ? "opt-till" : ""}`} role="dialog" aria-label={`${tx("Customise")} ${name}`}>
      <div className="opt-sheet">
        <div className="opt-head">
          {till ? <><h2>Select options · {name}</h2><button className="opt-x" onClick={onClose} aria-label="Close">✕</button></>
            : <button className="opt-x" onClick={onClose} aria-label={tx("Back")}><span aria-hidden>‹</span> {tx("Back")}</button>}
        </div>
        <div className="opt-body">
          {photoUrl && !till && <img className="opt-photo" src={photoUrl} alt="" />}
          {!till && <h2>{name}</h2>}
          {kiosk && <div className="opt-price">{formatMoney(total)}</div>}
          {description && <p className="muted">{description}</p>}
          {kiosk && groups.length > 0 && <p className="muted">{tx("Choose your options below — the price updates as you go.")}</p>}
          {groups.map((g) => {
            const max = g.max ?? (g.kind === "multi" ? g.choices.length : 10);
            const full = g.kind !== "single" && used(g) >= max;
            return (
              <section key={g.id} className="opt-group">
                <div className="opt-gh">
                  <b>{g.name}</b>
                  <span className="muted">{g.kind === "single" ? (g.required ? tx("Choose 1") : tx("Choose up to 1")) : (g.min ?? 0) > 0 ? tx("Choose {a} to {b}", { a: g.min!, b: max }) : g.kind === "multi" ? tx("Choose any") : tx("Up to {n}", { n: max })}{(g.free ?? 0) > 0 ? ` · ${tx("first {n} free", { n: g.free! })}` : ""}</span>
                </div>
                {g.kind === "single" || g.kind === "multi" ? (
                  <div className="opt-pills">
                    {g.choices.map((c) => {
                      const on = countOf(sel, g.id, c.id) > 0;
                      return (
                        <button
                          key={c.id}
                          className={on ? "on" : ""}
                          disabled={c.soldOut || (g.kind === "multi" && !on && full)}
                          aria-pressed={on}
                          onClick={() => (g.kind === "single" && (g.required || !on) ? pickOne(g, c.id) : toggle(g, c.id))} // an optional choose-one can be tapped again to clear it
                        >
                          <span>{c.prefix ? `${PREFIX_LABEL[c.prefix]} ${c.name}` : c.name}</span>
                          {c.soldOut ? <small>{tx("Sold out")}</small> : g.variant && g.kind === "single" ? <small>{formatMoney(variantPrice(g, c.id))}</small> : c.priceCents > 0 ? <small>+{formatMoney(c.priceCents)}</small> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  g.choices.map((c) => (
                    <div className="opt-row" key={c.id}>
                      <div>
                        <b>{c.prefix ? `${PREFIX_LABEL[c.prefix]} ${c.name}` : c.name}</b>
                        <div className="muted">{c.soldOut ? tx("Sold out") : tx("+ {amt} each", { amt: formatMoney(c.priceCents) })}</div>
                      </div>
                      <span className="opt-step">
                        <button disabled={!countOf(sel, g.id, c.id)} onClick={() => step(g, c.id, -1)} aria-label={`Fewer ${c.name}`}>−</button>
                        <b>{countOf(sel, g.id, c.id)}</b>
                        <button disabled={c.soldOut || full || countOf(sel, g.id, c.id) >= (g.maxEach ?? MAX_EACH)} onClick={() => step(g, c.id, 1)} aria-label={`More ${c.name}`}>+</button>
                      </span>
                    </div>
                  ))
                )}
              </section>
            );
          })}
          {notes && <section className="opt-group">
            <div className="opt-gh"><b>{tx("Special request")}</b><span className="muted">{tx("Optional")}</span></div>
            <textarea className="opt-note" rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} aria-label={tx("Special request")} />
          </section>}
          {kiosk && (
            <section className="opt-group opt-qty">
              <b>{tx("Quantity")}</b>
              <span className="opt-step">
                <button disabled={qty <= 1} onClick={() => setQty((n) => Math.max(1, n - 1))} aria-label={tx("Fewer")}>−</button>
                <b>{qty}</b>
                <button disabled={qty >= MAX_QTY} onClick={() => setQty((n) => Math.min(MAX_QTY, n + 1))} aria-label={tx("More")}>+</button>
              </span>
            </section>
          )}
        </div>
        {till ? (
          <div className="opt-foot kq">
            <div className="opt-tillprice"><b>{formatMoney(total)}</b>{missing && <small>Select {missing}</small>}</div>
            <button className="opt-cancel" onClick={onClose}>Cancel</button>
            <button className="opt-cta" disabled={!r.ok} onClick={() => r.ok && onAdd(sel, note, 1)}>Add · {formatMoney(total)}</button>
          </div>
        ) : kiosk ? (
          <div className="opt-foot kq">
            <button className="opt-cancel" onClick={onClose}>{tx("Cancel")}</button>
            <button className="opt-cta" disabled={!r.ok} title={missing ? tx("Choose {x}", { x: missing }) : ""} onClick={() => r.ok && onAdd(sel, note, qty)}>
              {missing ? tx("Choose {x}", { x: missing }) : `${tx(cta)} · ${formatMoney(total * qty)}`}
            </button>
          </div>
        ) : (
        <div className="opt-foot">
          <div>
            <small className="muted">{tx("Total")}</small>
            <div className="opt-total">{formatMoney(total)}</div>
          </div>
          <button className="opt-cta" disabled={!r.ok} title={missing ? tx("Choose {x}", { x: missing }) : ""} onClick={() => r.ok && onAdd(sel, note, 1)}>
            {missing ? tx("Choose {x}", { x: missing }) : tx(cta)}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
