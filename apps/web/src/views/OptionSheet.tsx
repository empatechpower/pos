import { useMemo, useState } from "react";
import { tx } from "../shopI18n";
import { MAX_NOTE, defaultSelection, formatMoney, resolveOptions, type ChosenOptionInput, type OptionGroup } from "@pos/core";

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
  onAdd: (selection: ChosenOptionInput[], note: string) => void;
  onClose: () => void;
}

const MAX_EACH = 5;
const countOf = (sel: ChosenOptionInput[], g: string, c: string) => sel.filter((s) => s.groupId === g && s.choiceId === c).reduce((n, s) => n + (s.qty ?? 1), 0);

/**
 * The customise screen: choose-one groups as pills, "pick any" as toggles, extras as steppers. The total and
 * the Add button follow the same rules the server applies, so what is shown is what is charged.
 */
export function OptionSheet({ name, description, photoUrl, baseCents, groups, initial, initialNote, cta = "Add to bag", notes, onAdd, onClose }: Props) {
  const [sel, setSel] = useState<ChosenOptionInput[]>(initial ?? defaultSelection(groups));
  const [note, setNote] = useState(initialNote ?? "");
  const r = useMemo(() => resolveOptions(groups, sel), [groups, sel]);
  const total = baseCents + (r.ok ? r.extraCents : 0);
  const missing = !r.ok && r.error === "missing_required" ? groups.find((g) => g.id === r.groupId)?.name : null;

  const pickOne = (g: OptionGroup, choiceId: string) => setSel((cur) => [...cur.filter((s) => s.groupId !== g.id), { groupId: g.id, choiceId }]);
  const toggle = (g: OptionGroup, choiceId: string) =>
    setSel((cur) => (countOf(cur, g.id, choiceId) ? cur.filter((s) => !(s.groupId === g.id && s.choiceId === choiceId)) : [...cur, { groupId: g.id, choiceId }]));
  const step = (g: OptionGroup, choiceId: string, d: number) =>
    setSel((cur) => {
      const n = Math.max(0, Math.min(g.maxEach ?? MAX_EACH, countOf(cur, g.id, choiceId) + d));
      const rest = cur.filter((s) => !(s.groupId === g.id && s.choiceId === choiceId));
      return n ? [...rest, { groupId: g.id, choiceId, qty: n }] : rest;
    });
  const used = (g: OptionGroup) => sel.filter((s) => s.groupId === g.id).reduce((n, s) => n + (s.qty ?? 1), 0);

  return (
    <div className="opt-back" role="dialog" aria-label={`${tx("Customise")} ${name}`}>
      <div className="opt-sheet">
        <div className="opt-head">
          <button className="opt-x" onClick={onClose} aria-label={tx("Back")}><span aria-hidden>‹</span> {tx("Back")}</button>
        </div>
        <div className="opt-body">
          {photoUrl && <img className="opt-photo" src={photoUrl} alt="" />}
          <h2>{name}</h2>
          {description && <p className="muted">{description}</p>}
          {groups.map((g) => {
            const max = g.max ?? (g.kind === "multi" ? g.choices.length : 10);
            const full = g.kind !== "single" && used(g) >= max;
            return (
              <section key={g.id} className="opt-group">
                <div className="opt-gh">
                  <b>{g.name}</b>
                  <span className="muted">{g.kind === "single" ? (g.required ? tx("Choose 1") : tx("Choose up to 1")) : g.kind === "multi" ? tx("Choose any") : tx("Up to {n}", { n: max })}</span>
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
                          <span>{c.name}</span>
                          {c.soldOut ? <small>{tx("Sold out")}</small> : c.priceCents > 0 ? <small>+{formatMoney(c.priceCents)}</small> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  g.choices.map((c) => (
                    <div className="opt-row" key={c.id}>
                      <div>
                        <b>{c.name}</b>
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
        </div>
        <div className="opt-foot">
          <div>
            <small className="muted">{tx("Total")}</small>
            <div className="opt-total">{formatMoney(total)}</div>
          </div>
          <button className="opt-cta" disabled={!r.ok} title={missing ? tx("Choose {x}", { x: missing }) : ""} onClick={() => r.ok && onAdd(sel, note)}>
            {missing ? tx("Choose {x}", { x: missing }) : tx(cta)}
          </button>
        </div>
      </div>
    </div>
  );
}
