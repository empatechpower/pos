import { useState } from "react";
import { OPTION_PREFIXES, PREFIX_LABEL, comboSaving, formatMoney, isCombo, validateOptions, type Catalog, type OptionChoice, type OptionGroup, type Product } from "@pos/core";

const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;
const toCents = (t: string): number | null => {
  const n = Number(t.trim() === "" ? "0" : t.trim());
  return Number.isFinite(n) && n >= 0 && n < 10000 ? Math.round(n * 100) : null;
};
const KIND_LABEL: Record<OptionGroup["kind"], string> = { single: "Choose one", multi: "Choose any", qty: "Add several (quantities)" };

interface Props {
  product: Product;
  catalog: Catalog;
  /** Saves the groups ([] clears them). Resolves to an error message, or null when it worked. */
  onSave: (groups: OptionGroup[], bcrs: boolean) => Promise<string | null>;
  onClose: () => void;
}

/**
 * Variants, modifiers and combo slots for one item. A normal group offers typed-in choices (Hot / Cold, Extra egg +$2).
 * A combo slot offers other menu items (Fries, Nuggets, Coke) and each can carry a top-up, so a combo is
 * "one price, with the parts the customer may swap".
 */
export function OptionsEditor({ product, catalog, onSave, onClose }: Props) {
  const [groups, setGroups] = useState<OptionGroup[]>(() => structuredClone(product.options ?? []));
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bcrs, setBcrs] = useState(!!product.bcrs);
  const menu = catalog.products.filter((p) => p.id !== product.id && !isCombo(p.options)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const defaultBook = catalog.pricebooks.find((b) => b.id === catalog.defaultPricebookId);
  const priceOf = (id: string) => defaultBook?.prices[id] ?? null;
  const isSlot = (g: OptionGroup) => g.choices.some((c) => c.productId) || (g as OptionGroup & { _slot?: boolean })._slot === true;

  const patch = (gi: number, f: (g: OptionGroup) => OptionGroup) => setGroups((cur) => cur.map((g, i) => (i === gi ? f(g) : g)));
  const patchChoice = (gi: number, ci: number, f: (c: OptionChoice) => OptionChoice) => patch(gi, (g) => ({ ...g, choices: g.choices.map((c, i) => (i === ci ? f(c) : c)) }));
  const setDefault = (gi: number, ci: number) => patch(gi, (g) => ({ ...g, choices: g.choices.map((c, i) => ({ ...c, default: i === ci ? true : undefined })) }));

  const addGroup = (slot: boolean) =>
    setGroups((cur) => [
      ...cur,
      slot
        ? ({ id: uid("s"), name: "", kind: "single", required: true, choices: [], _slot: true } as OptionGroup)
        : { id: uid("g"), name: "", kind: "single", required: false, choices: [{ id: uid("c"), name: "", priceCents: 0 }] },
    ]);

  const addPart = (gi: number, productId: string) => {
    const part = menu.find((p) => p.id === productId);
    if (!part) return;
    patch(gi, (g) => (g.choices.some((c) => c.productId === productId) ? g : { ...g, choices: [...g.choices, { id: productId, name: part.name, priceCents: 0, productId, ...(g.choices.length ? {} : { default: true }) }] }));
  };

  const clean = (): OptionGroup[] =>
    groups.map((g) => {
      const { _slot, ...rest } = g as OptionGroup & { _slot?: boolean };
      void _slot;
      return {
        ...rest,
        name: rest.name.trim(),
        required: rest.kind === "single" ? rest.required : false,
        variant: rest.kind === "single" && rest.required && rest.variant ? true : undefined,
        choices: rest.choices.map((c) => ({ ...c, name: c.name.trim(), default: rest.kind === "single" && rest.required ? c.default : undefined })),
      };
    });

  const problems = validateOptions(product.id, clean()).map((p) => p.replace(`${product.id}: `, ""));
  const slotWithoutPart = groups.some((g) => isSlot(g) && !g.choices.length);

  async function save() {
    // A required choose-one group needs a starting choice: use the first one when none is marked.
    const out = clean().map((g) => (g.kind === "single" && g.required && g.choices.length && !g.choices.some((c) => c.default) ? { ...g, choices: g.choices.map((c, i) => (i === 0 ? { ...c, default: true } : c)) } : g));
    setSaving(true);
    setError(await onSave(out, bcrs));
    setSaving(false);
  }

  const base = priceOf(product.id);
  const saved = base === null ? 0 : comboSaving(base, clean(), priceOf);

  return (
    <div className="rn-back" onClick={onClose}>
      <div className="rn-modal oe-modal" role="dialog" aria-modal="true" aria-label={`Options for ${product.name}`} onClick={(e) => e.stopPropagation()}>
        <h3>Options and combo: {product.name}</h3>
        <label className="oe-bcrs"><input type="checkbox" checked={bcrs} onChange={(e) => setBcrs(e.target.checked)} /> Container deposit (BCRS) applies to this item: S$0.10 is added for each one sold</label>
        <p className="muted">
          Options change an item (Hot or Cold, Extra egg). A combo slot lets the customer pick a part from your menu (Side: Fries, Nuggets). The item's own price is the price of the combo;
          each part can add a top-up.
        </p>

        {groups.map((g, gi) => {
          const slot = isSlot(g);
          return (
            <section key={g.id} className="oe-group">
              <div className="oe-head">
                <input placeholder={slot ? "Slot name, e.g. Side" : "Group name, e.g. Hot or cold"} value={g.name} maxLength={60} onChange={(e) => patch(gi, (x) => ({ ...x, name: e.target.value }))} aria-label="Group name" />
                <button className="secondary sm" aria-label="Move up" disabled={gi === 0} onClick={() => setGroups((c) => { const n = [...c]; [n[gi - 1]!, n[gi]!] = [n[gi]!, n[gi - 1]!]; return n; })}>↑</button>
                <button className="secondary sm" aria-label="Remove group" onClick={() => setGroups((c) => c.filter((_, i) => i !== gi))}>✕</button>
              </div>
              {!slot && (
                <div className="oe-row">
                  <select value={g.kind} aria-label="How customers choose" onChange={(e) => patch(gi, (x) => ({ ...x, kind: e.target.value as OptionGroup["kind"], required: e.target.value === "single" ? x.required : false, variant: undefined }))}>
                    {(Object.keys(KIND_LABEL) as Array<OptionGroup["kind"]>).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                  {g.kind === "single" && (
                    <label><input type="checkbox" checked={g.required} onChange={(e) => patch(gi, (x) => ({ ...x, required: e.target.checked, variant: e.target.checked ? x.variant : undefined }))} /> Must choose</label>
                  )}
                  {g.kind !== "single" && (
                    <>
                      <label title="Fewest units the customer must pick (counting quantities). Leave empty for none.">Min <input style={{ width: 52 }} inputMode="numeric" aria-label="Minimum units" value={g.min ?? ""} onChange={(e) => patch(gi, (x) => ({ ...x, min: e.target.value === "" ? undefined : Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 0)) }))} /></label>
                      <label title="Most units in total. Leave empty for no limit.">Max <input style={{ width: 52 }} inputMode="numeric" aria-label="Maximum units" value={g.max ?? ""} onChange={(e) => patch(gi, (x) => ({ ...x, max: e.target.value === "" ? undefined : Math.max(1, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 1)) }))} /></label>
                      <label title="The first units picked, in the order they were picked, cost nothing; later ones pay their own price.">Free <input style={{ width: 52 }} inputMode="numeric" aria-label="Free units" value={g.free ?? ""} onChange={(e) => patch(gi, (x) => ({ ...x, free: e.target.value === "" ? undefined : Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 0)) || undefined }))} /></label>
                    </>
                  )}
                  {g.kind === "single" && g.required && (
                    <label title="Each choice is its own line in the bag, e.g. Hot and Iced coffee."><input type="checkbox" checked={!!g.variant} onChange={(e) => patch(gi, (x) => ({ ...x, variant: e.target.checked || undefined }))} /> Variant</label>
                  )}
                </div>
              )}
              {slot && <div className="muted oe-note">Customer picks one. The ● part is what they get unless they change it. One part only = a fixed part.</div>}

              {g.choices.map((c, ci) => (
                <div className="oe-choice" key={c.id}>
                  {g.kind === "single" && g.required && (
                    <input type="radio" name={`def-${g.id}`} checked={!!c.default} onChange={() => setDefault(gi, ci)} aria-label="Starting choice" title="Starting choice" />
                  )}
                  {slot ? (
                    <span className="oe-name">{c.name}<small className="muted"> · alone {priceOf(c.productId ?? "") === null ? "no price" : formatMoney(priceOf(c.productId ?? "")!)}</small></span>
                  ) : (
                    <input className="oe-name" placeholder="Choice name" value={c.name} maxLength={60} onChange={(e) => patchChoice(gi, ci, (x) => ({ ...x, name: e.target.value }))} aria-label="Choice name" />
                  )}
                  <span className="oe-plus">+<input inputMode="decimal" placeholder="0.00" aria-label="Top-up price" value={prices[`${g.id}/${c.id}`] ?? (c.priceCents ? (c.priceCents / 100).toFixed(2) : "")}
                    onChange={(e) => { setPrices((p) => ({ ...p, [`${g.id}/${c.id}`]: e.target.value })); const v = toCents(e.target.value); if (v !== null) patchChoice(gi, ci, (x) => ({ ...x, priceCents: v })); }} /></span>
                  {g.variant && <input className="oe-code" style={{ width: 130 }} placeholder="Barcode / SKU" maxLength={40} aria-label={`Barcode for ${c.name || "this choice"}`} title="This variant's own barcode: scanning it adds the item as this variant." value={c.barcode ?? ""} onChange={(e) => patchChoice(gi, ci, (x) => { const v = e.target.value.trim(); const { barcode: _b, ...rest } = x; return v ? { ...rest, barcode: v } : rest; })} />}
                  {!slot && g.kind !== "single" && (
                    <select aria-label="Kitchen instruction" title="An instruction about the item's usual ingredients: No onion, Side sauce, Only, Lite. It changes the ticket, not the price or stock." value={c.prefix ?? ""} onChange={(e) => patchChoice(gi, ci, (x) => ({ ...x, prefix: (e.target.value || undefined) as OptionChoice["prefix"] }))}>
                      <option value="">No instruction</option>
                      {OPTION_PREFIXES.map((k) => <option key={k} value={k}>{PREFIX_LABEL[k]}</option>)}
                    </select>
                  )}
                  {!slot && <label className="oe-so"><input type="checkbox" checked={!!c.soldOut} onChange={(e) => patchChoice(gi, ci, (x) => ({ ...x, soldOut: e.target.checked || undefined }))} /> Sold out</label>}
                  <button className="secondary sm" aria-label={`Remove ${c.name || "choice"}`} onClick={() => patch(gi, (x) => ({ ...x, choices: x.choices.filter((_, i) => i !== ci) }))}>✕</button>
                </div>
              ))}

              {slot ? (
                <select value="" aria-label="Add a menu item to this slot" onChange={(e) => e.target.value && addPart(gi, e.target.value)}>
                  <option value="">+ Add a menu item…</option>
                  {menu.filter((p) => !g.choices.some((c) => c.productId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.category} · {p.name}</option>)}
                </select>
              ) : (
                <button className="secondary sm" onClick={() => patch(gi, (x) => ({ ...x, choices: [...x.choices, { id: uid("c"), name: "", priceCents: 0 }] }))}>+ Add a choice</button>
              )}
            </section>
          );
        })}

        <div className="oe-add">
          <button className="secondary sm" onClick={() => addGroup(false)}>+ Add option group</button>
          <button className="secondary sm" onClick={() => addGroup(true)}>+ Add combo slot</button>
        </div>

        {saved > 0 && <p className="oe-save">Customers save {formatMoney(saved)} compared with buying the starting parts separately.</p>}
        {slotWithoutPart && <p className="oe-err">Add at least one menu item to each combo slot.</p>}
        {problems.length > 0 && <p className="oe-err">{problems.join("; ")}</p>}
        {error && <p className="oe-err">{error}</p>}
        <div className="rn-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || problems.length > 0 || slotWithoutPart} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
