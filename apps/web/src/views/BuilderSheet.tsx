import { useMemo, useState } from "react";
import { MAX_NOTE, allocateSelections, formatMoney, priceBuild, ruleSetFor, validateBuild, type BuildInput, type BuilderGroup, type BuilderSpec, type GroupCheck } from "@pos/core";
import { tx } from "../shopI18n";

interface Props {
  name: string;
  description?: string;
  photoUrl?: string | null;
  /** The product's base price, which already includes every group's allowance. */
  baseCents: number;
  spec: BuilderSpec;
  /** Start from this build (when editing). */
  initial?: BuildInput;
  initialNote?: string;
  cta?: string;
  onAdd: (build: BuildInput, note: string) => void;
  onClose: () => void;
}

type Pick = BuildInput["picks"][number];
const unitsIn = (picks: Pick[], g: string) => picks.filter((p) => p.groupId === g).reduce((n, p) => n + (p.qty ?? 1), 0);
const qtyOf = (picks: Pick[], g: string, o: string) => picks.find((p) => p.groupId === g && p.optionId === o)?.qty ?? (picks.some((p) => p.groupId === g && p.optionId === o) ? 1 : 0);

/** What a group asks for, in words: "Choose 1", "Choose 2 to 4", "Up to 3". */
function rule(g: BuilderGroup): string {
  if (g.maxSelect === null) return g.minSelect > 0 ? tx("Choose at least {n}", { n: g.minSelect }) : tx("Choose any");
  if (g.minSelect === g.maxSelect) return tx("Choose {n}", { n: g.minSelect });
  if (g.minSelect === 0) return tx("Up to {n}", { n: g.maxSelect });
  return tx("Choose {a} to {b}", { a: g.minSelect, b: g.maxSelect });
}

/** What is wrong with a group right now, said plainly (the Add button never just refuses without saying why). */
function problem(c: GroupCheck): string | null {
  if (c.state === "satisfied") return null;
  if (c.state === "below_min") return tx("Choose {n} more in {g}", { n: c.shortfall ?? 1, g: c.groupName });
  if (c.state === "above_max") return tx("Take off {n} in {g}", { n: c.excess ?? 1, g: c.groupName });
  if (c.state === "unavailable_option") return tx("A choice in {g} is sold out", { g: c.groupName });
  return tx("Check {g}", { g: c.groupName });
}

/**
 * The customise screen for a build-your-own item: pick a size or variant (which brings its own rules), then fill each group within its
 * minimum and maximum. Allowances are used up in the order things are picked, and every selection shows what it costs: full price,
 * covered by the allowance, or the charge. The server re-checks and re-prices the same build when the order is placed.
 */
export function BuilderSheet({ name, description, photoUrl, baseCents, spec, initial, initialNote, cta = "Add to bag", onAdd, onClose }: Props) {
  const variants = spec.variants ?? [];
  const [variantId, setVariantId] = useState<string | undefined>(initial?.variantId);
  const [picks, setPicks] = useState<Pick[]>(initial?.picks ?? []);
  const [note, setNote] = useState(initialNote ?? "");
  const input: BuildInput = { ...(variantId ? { variantId } : {}), picks };
  const rs = ruleSetFor(spec, variantId);
  const groups = rs.ok ? rs.groups : [];
  const check = useMemo(() => validateBuild(spec, input), [spec, variantId, picks]); // eslint-disable-line react-hooks/exhaustive-deps
  const priced = useMemo(() => priceBuild(spec, input, baseCents), [spec, variantId, picks, baseCents]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = priced.ok ? priced.unitCents : baseCents + (rs.ok ? rs.deltaCents : 0);
  const firstProblem = !rs.ok ? tx("Choose a size") : check.groups.map(problem).find(Boolean) ?? null;
  // The split is shown as the build is filled in, even before it is complete.
  const split = useMemo(() => allocateSelections(groups, picks), [groups, picks]);
  const splitOf = (g: string, o: string) => split.filter((s) => s.groupId === g && s.optionId === o);

  function chooseVariant(id: string) {
    if (id === variantId) return;
    setVariantId(id);
    setPicks([]); // a different variant is a different rule set: nothing carries over silently
  }
  const toggle = (g: BuilderGroup, optionId: string) =>
    setPicks((cur) => {
      if (qtyOf(cur, g.id, optionId)) return cur.filter((p) => !(p.groupId === g.id && p.optionId === optionId));
      if (g.maxSelect === 1) return [...cur.filter((p) => p.groupId !== g.id), { groupId: g.id, optionId }]; // a choose-one swaps
      return [...cur, { groupId: g.id, optionId }];
    });
  const step = (g: BuilderGroup, optionId: string, max: number, d: number) =>
    setPicks((cur) => {
      const n = Math.max(0, Math.min(max, qtyOf(cur, g.id, optionId) + d));
      if (!n) return cur.filter((p) => !(p.groupId === g.id && p.optionId === optionId));
      return cur.some((p) => p.groupId === g.id && p.optionId === optionId)
        ? cur.map((p) => (p.groupId === g.id && p.optionId === optionId ? { ...p, qty: n } : p))
        : [...cur, { groupId: g.id, optionId, qty: n }];
    });

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
          {variants.length > 0 && (
            <section className="opt-group">
              <div className="opt-gh"><b>{tx("Size")}</b><span className="muted">{tx("Choose 1")}</span></div>
              <div className="opt-pills">
                {variants.map((v) => (
                  <button key={v.id} className={variantId === v.id ? "on" : ""} aria-pressed={variantId === v.id} onClick={() => chooseVariant(v.id)}>
                    <span>{v.name}</span>
                    <small>{formatMoney(baseCents + (v.priceDeltaCents ?? 0))}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {groups.map((g) => {
            const c = check.groups.find((x) => x.groupId === g.id);
            const bad = c && c.state !== "satisfied" ? problem(c) : null;
            const used = unitsIn(picks, g.id);
            const full = g.maxSelect !== null && used >= g.maxSelect;
            return (
              <section key={g.id} className="opt-group">
                <div className="opt-gh">
                  <b>{g.name}</b>
                  <span className="muted">{rule(g)}{g.allowance && g.allowance.mode === "dollar" && g.allowance.value > 0 ? ` · ${tx("{amt} included", { amt: formatMoney(g.allowance.value) })}` : g.allowance && g.allowance.mode === "count" && g.allowance.value > 0 ? ` · ${tx("{n} included", { n: g.allowance.value })}` : ""}</span>
                </div>
                {g.options.map((o) => {
                  const q = qtyOf(picks, g.id, o.id);
                  const max = o.maxQty ?? 1;
                  const sp = splitOf(g.id, o.id)[0];
                  // Unpicked: the full price. Picked: what the allowance covered and what is charged.
                  const price = sp ? (sp.chargedCents === 0 && sp.fullCents > 0 ? tx("Free") : sp.chargedCents > 0 ? `+${formatMoney(sp.chargedCents)}` : "") : o.priceCents > 0 ? `+${formatMoney(o.priceCents)}` : "";
                  const blocked = !!o.soldOut || (!q && full && g.maxSelect !== 1);
                  return (
                    <div className="opt-row" key={o.id}>
                      <div>
                        <b>{o.name}</b>
                        <div className="muted">{o.soldOut ? tx("Sold out") : price}</div>
                      </div>
                      {max > 1 ? (
                        <span className="opt-step">
                          <button disabled={!q} onClick={() => step(g, o.id, max, -1)} aria-label={`Fewer ${o.name}`}>−</button>
                          <b>{q}</b>
                          <button disabled={blocked || q >= max || (full && g.maxSelect !== null)} onClick={() => step(g, o.id, max, 1)} aria-label={`More ${o.name}`}>+</button>
                        </span>
                      ) : (
                        <button className={`opt-tog ${q ? "on" : ""}`} aria-pressed={q > 0} disabled={blocked} onClick={() => toggle(g, o.id)}>{q ? "✓" : "+"}</button>
                      )}
                    </div>
                  );
                })}
                {bad && used > 0 && <p className="muted" role="status">{bad}</p>}
              </section>
            );
          })}
          <section className="opt-group">
            <div className="opt-gh"><b>{tx("Special request")}</b><span className="muted">{tx("Optional")}</span></div>
            <textarea className="opt-note" rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} aria-label={tx("Special request")} />
          </section>
        </div>
        <div className="opt-foot">
          <div>
            <small className="muted">{tx("Total")}</small>
            <div className="opt-total">{formatMoney(total)}</div>
          </div>
          <button className="opt-cta" disabled={!priced.ok} title={firstProblem ?? ""} onClick={() => priced.ok && onAdd(input, note)}>
            {firstProblem ?? tx(cta)}
          </button>
        </div>
      </div>
    </div>
  );
}
