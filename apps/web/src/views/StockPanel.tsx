import { useCallback, useEffect, useState } from "react";
import { askText } from "../proto/confirm";
import type { Catalog, Product, ProductStock } from "@pos/core";
import { staffFetch } from "../auth";

interface Item { id: string; name: string; unit: string; onHand: number }

/**
 * Stock for managers: the stock items and how many each outlet has, receiving / waste / stocktake (each a movement, never an edit), and which
 * products use stock: finished stock (its own item) or made from a recipe (its ingredients). A product with neither is not tracked.
 */
export function StockPanel({ catalog, outletId, onChanged }: { catalog: Catalog; outletId: string; onChanged?: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [msg, setMsg] = useState("");
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("pcs");
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await staffFetch(`/api/inventory?outlet=${encodeURIComponent(outletId)}`);
    if ("res" in r && r.res.ok) setItems(((await r.res.json()) as { items: Item[] }).items);
  }, [outletId]);
  useEffect(() => { void load(); }, [load]);

  async function addItem() {
    const r = await staffFetch(`/api/inventory/${encodeURIComponent(newId)}`, { method: "PUT", body: { name: newName, unit: newUnit } });
    if ("res" in r && r.res.ok) { setMsg(`${newName} added.`); setNewId(""); setNewName(""); void load(); } else setMsg("problem" in r ? r.problem : "Could not add it. The code is lowercase letters, digits and dashes.");
  }
  async function move(i: Item, reason: "receive" | "waste" | "count") {
    const ask = await askText({ title: reason === "receive" ? "Stock received" : reason === "waste" ? "Stock wasted" : "Stock count", message: reason === "receive" ? `How many ${i.unit} of ${i.name} arrived?` : reason === "waste" ? `How many ${i.unit} of ${i.name} were wasted?` : `Counted: how many ${i.unit} of ${i.name} are on the shelf?`, label: `Quantity (${i.unit})`, inputMode: "decimal", ok: "Save" });
    if (ask === null || ask.trim() === "") return;
    const qty = Number(ask);
    const r = await staffFetch(`/api/inventory/${encodeURIComponent(i.id)}/movements`, { method: "POST", body: { outletId, reason, qty } });
    setMsg("res" in r && r.res.ok ? `${i.name} updated.` : "problem" in r ? r.problem : "Could not record that. Use a whole number.");
    void load();
  }
  async function saveStock(p: Product, stock: ProductStock | null) {
    const r = await staffFetch("/api/catalog/products", { method: "POST", body: { id: p.id, name: p.name, category: p.category, soldOut: !!p.soldOut, pointsExempt: !!p.pointsExempt, stock } }); // (the save replaces these two when they are left out, so they are sent as they are)
    setMsg("res" in r && r.res.ok ? `${p.name}: stock set-up saved.` : "problem" in r ? r.problem : "Could not save. Check the items exist and each quantity is a whole number.");
    if ("res" in r && r.res.ok) { setEditing(null); onChanged?.(); }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Stock</h3>
      <p className="muted">Stock for outlet <b>{outletId}</b>. Receiving, waste and counting are recorded as movements and never overwritten. An item that runs out is shown as sold out to customers.</p>
      {msg && <div className="flash">{msg}</div>}
      {items.length === 0 && <p className="muted">No stock items yet. Add the things you count (a can of Coke, a loaf of bread, kaya jam in grams).</p>}
      {items.map((i) => (
        <div className="row" key={i.id} style={{ alignItems: "center" }}>
          <span style={{ flex: 1 }}><b>{i.name}</b> <span className="muted">({i.id})</span></span>
          <span style={{ minWidth: 90, textAlign: "right", color: i.onHand <= 0 ? "var(--danger, #e1523e)" : undefined }}>{i.onHand} {i.unit}</span>
          <button className="secondary sm" onClick={() => void move(i, "receive")}>Receive</button>
          <button className="secondary sm" onClick={() => void move(i, "waste")}>Waste</button>
          <button className="secondary sm" onClick={() => void move(i, "count")}>Count</button>
        </div>
      ))}
      <div className="row">
        <input placeholder="code, e.g. coke-can" value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} aria-label="Stock item code" />
        <input placeholder="name, e.g. Coke can" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Stock item name" />
        <input style={{ width: 70 }} value={newUnit} onChange={(e) => setNewUnit(e.target.value)} aria-label="Unit" />
        <button className="primary sm" disabled={!newId || !newName.trim()} onClick={() => void addItem()}>Add stock item</button>
      </div>

      <h4 style={{ marginTop: 16 }}>Which products use stock</h4>
      {catalog.products.map((p) => (
        <div key={p.id} style={{ marginBottom: 6 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <span style={{ flex: 1 }}>{p.name}</span>
            <span className="muted">{p.stock ? (p.stock.basis === "finished" ? `finished stock: ${items.find((x) => x.id === p.stock!.itemId)?.name ?? p.stock.itemId}` : `recipe of ${p.stock.recipe?.length ?? 0}`) : "not tracked"}</span>
            <button className="secondary sm" onClick={() => setEditing(editing === p.id ? null : p.id)}>{editing === p.id ? "Close" : "Set up"}</button>
          </div>
          {editing === p.id && <StockEditor product={p} items={items} onSave={(s) => void saveStock(p, s)} />}
        </div>
      ))}
    </div>
  );
}

function StockEditor({ product, items, onSave }: { product: Product; items: Item[]; onSave: (s: ProductStock | null) => void }) {
  const [basis, setBasis] = useState<"none" | "finished" | "recipe">(product.stock?.basis ?? "none");
  const [itemId, setItemId] = useState(product.stock?.itemId ?? "");
  const [lines, setLines] = useState<Array<{ itemId: string; qty: string }>>((product.stock?.recipe ?? []).map((l) => ({ itemId: l.itemId, qty: String(l.qty) })));
  const valid = basis === "none" || (basis === "finished" && !!itemId) || (basis === "recipe" && lines.length > 0 && lines.every((l) => l.itemId && Number.isInteger(Number(l.qty)) && Number(l.qty) > 0));
  return (
    <div className="editor" style={{ marginLeft: 12 }}>
      <label className="field">One sale uses
        <select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
          <option value="none">Nothing (not tracked)</option>
          <option value="finished">Its own stock (finished stock)</option>
          <option value="recipe">Ingredients (made from a recipe)</option>
        </select>
      </label>
      {basis === "finished" && (
        <label className="field">Stock item
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">Choose…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        </label>
      )}
      {basis === "recipe" && (
        <>
          {lines.map((l, n) => (
            <div className="row" key={n}>
              <select value={l.itemId} onChange={(e) => setLines(lines.map((x, k) => (k === n ? { ...x, itemId: e.target.value } : x)))}><option value="">Ingredient…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select>
              <input style={{ width: 90 }} inputMode="numeric" value={l.qty} placeholder="how many" onChange={(e) => setLines(lines.map((x, k) => (k === n ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity" />
              <button className="secondary sm" onClick={() => setLines(lines.filter((_, k) => k !== n))}>Remove</button>
            </div>
          ))}
          <button className="secondary sm" onClick={() => setLines([...lines, { itemId: "", qty: "" }])}>Add an ingredient</button>
        </>
      )}
      <p className="muted" style={{ fontSize: 12 }}>A product is finished stock or made from a recipe, never both. A set meal itself uses nothing; the parts the customer picks use their own stock.</p>
      <button className="primary sm" disabled={!valid} onClick={() => onSave(basis === "none" ? null : basis === "finished" ? { basis, itemId } : { basis, recipe: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })) })}>Save</button>
    </div>
  );
}
