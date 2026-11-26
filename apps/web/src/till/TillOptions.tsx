import { useMemo, useState } from "react";
import { PREFIX_LABEL, defaultSelection, formatMoney, resolveOptions, type ChosenOptionInput, type OptionChoice, type OptionGroup } from "@pos/core";
import { ProtoDialog } from "../proto/ProtoDialog";

const MAX_EACH = 5;
const countOf = (sel: ChosenOptionInput[], g: string, c: string) => sel.filter((s) => s.groupId === g && s.choiceId === c).reduce((n, s) => n + (s.qty ?? 1), 0);
const usedIn = (sel: ChosenOptionInput[], g: OptionGroup) => sel.filter((s) => s.groupId === g.id).reduce((n, s) => n + (s.qty ?? 1), 0);
const maxOf = (g: OptionGroup) => (g.kind === "single" ? 1 : g.max ?? (g.kind === "multi" ? g.choices.length : 10));
const minOf = (g: OptionGroup) => (g.kind === "single" ? (g.required ? 1 : 0) : g.min ?? 0);
const label = (c: OptionChoice) => (c.prefix ? `${PREFIX_LABEL[c.prefix]} ${c.name}` : c.name);

/**
 * The till's "Select options" dialog, in the prototype's own markup (proto-reference/index.html, options()): the item's variations as a row of
 * priced buttons, then one tab per modifier group with its rule, its choices as tiles, and the price with Cancel and Add pinned to the foot.
 * The selection is checked and priced by the same call the server uses, so what is shown is what is charged.
 */
export function TillOptions({ name, description, baseCents, groups, initial, onAdd, onClose }: { name: string; description?: string; baseCents: number; groups: OptionGroup[]; /** The line's present choices, when changing them. */ initial?: ChosenOptionInput[]; onAdd: (selection: ChosenOptionInput[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<ChosenOptionInput[]>(initial ?? defaultSelection(groups));
  const variants = groups.filter((g) => g.variant && g.kind === "single");
  const mods = groups.filter((g) => !variants.includes(g));
  const [tab, setTab] = useState(0);
  const r = useMemo(() => resolveOptions(groups, sel), [groups, sel]);
  const total = baseCents + (r.ok ? r.extraCents : 0);
  const unmet = groups.filter((g) => usedIn(sel, g) < minOf(g)).map((g) => g.name);

  const variantPrice = (g: OptionGroup, choiceId: string) => {
    const r2 = resolveOptions(groups, [...sel.filter((s) => s.groupId !== g.id), { groupId: g.id, choiceId }]);
    return baseCents + (r2.ok ? r2.extraCents : (g.choices.find((c) => c.id === choiceId)?.priceCents ?? 0));
  };
  const pickOne = (g: OptionGroup, choiceId: string) => setSel((cur) => [...cur.filter((s) => s.groupId !== g.id), { groupId: g.id, choiceId }]);
  const toggle = (g: OptionGroup, choiceId: string) => setSel((cur) => (countOf(cur, g.id, choiceId) ? cur.filter((s) => !(s.groupId === g.id && s.choiceId === choiceId)) : [...cur, { groupId: g.id, choiceId }]));
  const step = (g: OptionGroup, choiceId: string, d: number) =>
    setSel((cur) => {
      const n = Math.max(0, Math.min(g.maxEach ?? MAX_EACH, countOf(cur, g.id, choiceId) + d));
      const at = cur.findIndex((s) => s.groupId === g.id && s.choiceId === choiceId);
      const rest = cur.filter((s) => !(s.groupId === g.id && s.choiceId === choiceId));
      if (!n) return rest;
      const out = [...rest];
      out.splice(at < 0 ? out.length : at, 0, { groupId: g.id, choiceId, qty: n }); // its first-pick position stays: the free allowance follows the order things were picked
      return out;
    });
  const tap = (g: OptionGroup, c: OptionChoice, on: boolean) => (g.kind === "qty" ? step(g, c.id, 1) : g.kind === "single" && (g.required || !on) ? pickOne(g, c.id) : toggle(g, c.id));

  const g = mods[Math.min(tab, mods.length - 1)];
  const n = g ? usedIn(sel, g) : 0;
  const free = g?.free ?? 0;
  return (
    <div className="proto protohead">
      <ProtoDialog title={`Select options · ${name}`} extra="optiondialog" onClose={onClose}>
        {description && <p className="muted" style={{ marginBottom: "0.625em" }}>{description}</p>}
        {variants.map((v) => (
          <div key={v.id}>
            <h3>{v.name} · {v.required ? "Required" : "Choose one"}</h3>
            <div className="choices">
              {v.choices.map((c) => {
                const on = countOf(sel, v.id, c.id) > 0;
                return <button key={c.id} className={on ? "selected" : ""} aria-pressed={on} disabled={c.soldOut} onClick={() => tap(v, c, on)}>{label(c)}<br />{c.soldOut ? "Sold out" : formatMoney(variantPrice(v, c.id))}</button>;
              })}
            </div>
          </div>
        ))}
        {mods.length > 0 && (
          <div className="group-tabs" role="tablist" aria-label="Modifier groups">
            {mods.map((x, i) => {
              const count = usedIn(sel, x);
              return <button key={x.id} role="tab" aria-selected={g === x} className={g === x ? "selected" : ""} onClick={() => setTab(i)}>{x.name} {count >= minOf(x) ? "✓" : ""}<small> {count}/{maxOf(x)}</small></button>;
            })}
          </div>
        )}
        {g && (
          <>
            <h3>{g.name}</h3>
            <p className="group-rule">
              {free > 0 ? `Choose ${free} free · min ${minOf(g)} · max ${maxOf(g)}` : minOf(g) ? `Required · choose ${minOf(g)}${maxOf(g) > minOf(g) ? `–${maxOf(g)}` : ""}` : `Optional · max ${maxOf(g)}`}
              <strong className="group-count">{n} / {maxOf(g)} selected</strong>
            </p>
            <div className="optionchoices">
              {g.choices.map((c) => {
                const count = countOf(sel, g.id, c.id);
                const on = count > 0;
                // Picked: what this choice is charged now (units inside the free allowance cost nothing). Not picked: what the next one would cost.
                const got = r.ok ? r.options.find((o) => o.group === g.name && o.name === c.name) : undefined;
                const price = on && got ? (got.qty - (got.freeQty ?? 0)) * got.priceCents : !on && free > 0 && n < free ? 0 : c.priceCents;
                const full = g.kind === "qty" ? n >= maxOf(g) || count >= (g.maxEach ?? MAX_EACH) : !on && maxOf(g) > 1 && n >= maxOf(g);
                return (
                  <div key={c.id} className="optioncell">
                    <button className={on ? "selected" : ""} aria-pressed={on} disabled={c.soldOut || full} onClick={() => tap(g, c, on)}>
                      {label(c)}{g.kind === "qty" && on ? ` × ${count}` : ""}
                      <small>{c.soldOut ? "Sold out" : `${on ? "✓ " : ""}${price ? `+${formatMoney(price)}` : formatMoney(0)}`}</small>
                    </button>
                    {g.kind === "qty" && on && <button className="optionless" aria-label={`Fewer ${c.name}`} onClick={() => step(g, c.id, -1)}>−</button>}
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div className="optionactions">
          <div>
            <strong>{formatMoney(total)}</strong>
            <p className="error" role="status">{r.ok && !unmet.length ? (initial ? "Ready to save" : "Ready to add") : unmet.length ? `Select ${unmet.join(", ")}` : "Check the choices"}</p>
          </div>
          <div className="choices">
            <button onClick={onClose}>Cancel</button>
            <button id="confirmOptions" className="primary" disabled={!r.ok} onClick={() => r.ok && onAdd(sel)}>{initial ? "Save" : "Add"} · {formatMoney(total)}</button>
          </div>
        </div>
      </ProtoDialog>
    </div>
  );
}
