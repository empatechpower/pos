import { useState } from "react";
import { formatMoney, menuFor, type Catalog, type MenuEntry } from "@pos/core";
import { authHeader, staffFetch } from "../auth";
import { refreshReference } from "../sync";
import { Modal } from "./Modal";

/**
 * Manage item (long-press an item on the till, managers only): its description, a sold-out switch, its photo, and its price in each price list
 * (a price list can serve several dining options, and says so). Changes go to the shop's menu at once.
 */
export function ManageItem({ item, catalog, outletId, channels, onClose }: { item: MenuEntry; catalog: Catalog; outletId: string; channels: Array<{ id: string; name: string }>; onClose: () => void }) {
  const product = catalog.products.find((p) => p.id === item.id) ?? item;
  const [desc, setDesc] = useState(product.description ?? "");
  const [code, setCode] = useState(product.barcode ?? "");
  const [soldOut, setSoldOut] = useState(!!product.soldOut);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // Each price list this item is sold from, with the dining options that use it.
  const lists = new Map<string, { id: string; name: string; channels: string[]; cents: number }>();
  for (const c of channels) {
    const e = menuFor(catalog, { outletId, channelId: c.id }).find((x) => x.id === item.id);
    if (!e) continue;
    const book = catalog.pricebooks.find((b) => b.id === e.pricebookId);
    const l = lists.get(e.pricebookId) ?? { id: e.pricebookId, name: book?.name ?? "Prices", channels: [], cents: e.priceCents };
    l.channels.push(c.name);
    lists.set(e.pricebookId, l);
  }
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries([...lists.values()].map((l) => [l.id, (l.cents / 100).toFixed(2)])));

  async function run(label: string, fn: () => Promise<Response | { problem: string } | null>) {
    setBusy(true); setMsg("");
    const r = await fn();
    setBusy(false);
    if (!r) return setMsg("Could not reach the server. Nothing was changed.");
    if ("problem" in r) return setMsg(r.problem);
    if (r.status === 403) return setMsg("This account isn't allowed to change the menu.");
    if (!r.ok) return setMsg("That was not saved.");
    setMsg(`${label} saved.`);
    await refreshReference();
  }
  const save = (body: object) => run("Item", async () => { const r = await staffFetch("/api/catalog/products", { method: "POST", body: { id: item.id, name: product.name, category: product.category, pointsExempt: product.pointsExempt, ...body } }); return "res" in r ? r.res : r; });

  return (
    <Modal title={`Manage · ${item.name}`} wide onClose={onClose}>
      {msg && <div className="t-flash" role="status">{msg}</div>}
      <label className="t-field">Barcode or SKU<input value={code} maxLength={40} aria-label="Barcode or SKU" placeholder="Scan or type the code" onChange={(e) => setCode(e.target.value.trim())} /></label>
      <div className="t-dact" style={{ justifyContent: "flex-start" }}><button className="t-ghost" disabled={busy || code === (product.barcode ?? "")} onClick={() => void run("Barcode", async () => { const r = await staffFetch(`/api/catalog/products/${encodeURIComponent(item.id)}/barcode`, { method: "PUT", body: { barcode: code || null } }); if ("res" in r && r.res.status === 400) { const j = (await r.res.clone().json().catch(() => ({}))) as { problems?: string[] }; if (j.problems?.[0]) setMsg(j.problems[0]); } return "res" in r ? r.res : r; })}>Save barcode</button></div>
      <label className="t-field">Description<textarea rows={2} maxLength={200} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="t-dact" style={{ justifyContent: "flex-start" }}><button className="t-ghost" disabled={busy || desc === (product.description ?? "")} onClick={() => void save({ description: desc })}>Save description</button></div>
      <div className="t-chiprow"><span>Availability</span><button className={soldOut ? "on" : ""} disabled={busy} onClick={() => { const next = !soldOut; setSoldOut(next); void save({ soldOut: next }); }}>{soldOut ? "Sold out (tap to put back on sale)" : "On sale (tap to mark sold out)"}</button></div>
      <div className="t-chiprow"><span>Photo</span>
        <label className="t-ghost" style={{ cursor: "pointer", padding: ".35em .8em", border: "1px solid #b6d6e4", borderRadius: 999 }}>{product.imageVersion ? "Change photo" : "Add photo"}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Photo" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; if (f.size > 300_000) return setMsg("Photos are at most 300 KB."); void run("Photo", () => fetch(`/api/catalog/products/${item.id}/image`, { method: "PUT", headers: { "content-type": f.type, ...authHeader() }, body: f }).catch(() => null)); }} />
        </label>
      </div>
      <h3 className="t-h3">Price</h3>
      {[...lists.values()].map((l) => (
        <div className="t-chiprow" key={l.id}>
          <span style={{ minWidth: "11em" }}>{l.channels.join(", ")}<small className="t-muted"> · {l.name}</small></span>
          <input inputMode="decimal" aria-label={`Price for ${l.channels.join(", ")}`} value={prices[l.id] ?? ""} onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value.replace(/[^\d.]/g, "") }))} style={{ width: "6em" }} />
          <button className="t-primary" disabled={busy || !(Math.round(Number(prices[l.id]) * 100) >= 0) || Math.round(Number(prices[l.id]) * 100) === l.cents} onClick={() => void run("Price", async () => { const r = await staffFetch(`/api/catalog/pricebooks/${encodeURIComponent(l.id)}/prices/${encodeURIComponent(item.id)}`, { method: "PUT", body: { priceCents: Math.round(Number(prices[l.id]) * 100) } }); return "res" in r ? r.res : r; })}>Save</button>
          <small className="t-muted">now {formatMoney(l.cents)}</small>
        </div>
      ))}
      {lists.size === 0 && <p className="t-muted">This item is not priced in any dining option here.</p>}
      <div className="t-dact"><button className="t-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
