import { LANGS } from "../shopI18n";
import { useEffect, useState } from "react";
import { brandColoursFromPixels, formatMoney, isCombo, type Catalog, type ChannelKind, type OptionGroup } from "@pos/core";
import { OptionsEditor } from "./OptionsEditor";
import { StockPanel } from "./StockPanel";
import { PromoPanel } from "./PromoPanel";
import { authHeader, staffFetch, useStaff } from "../auth";
import { markDeviceRejected } from "../device";

const KINDS: Array<[ChannelKind, string]> = [
  ["dine_in", "Dine in"],
  ["takeaway", "Take away"],
  ["delivery", "Delivery"],
  ["other", "Other (event, partner)"],
];

/** "2.2" → 220. Returns null for anything that isn't a sensible amount. */
const toCents = (text: string): number | null => {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) : null;
};

interface Brand {
  primary: string;
  accent: string;
  logoUrl: string | null;
  heroUrl: string | null;
  tagline: string | null;
  promoTitle: string | null;
  promoBody: string | null;
}

/** Managers and owners: prices per pricebook, channels, and where each pricebook applies. */
export function Prices({ catalog, outletId }: { catalog: Catalog; outletId: string }) {
  const staff = useStaff();
  const [bookId, setBookId] = useState(catalog.defaultPricebookId);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [renamingCat, setRenamingCat] = useState<{ from: string; to: string; names: Record<string, string> } | null>(null);
  const [newItem, setNewItem] = useState({ name: "", category: "", price: "" });
  const [newBook, setNewBook] = useState("");
  const [newKind, setNewKind] = useState<ChannelKind>("delivery");
  const [brand, setBrand] = useState<Brand | null>(null);
  const [find, setFind] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string; names: Record<string, string> } | null>(null);
  const [editingOptions, setEditingOptions] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/brand").then(async (r) => r.ok && setBrand((await r.json()) as Brand));
  }, []);

  if (!staff || staff.role === "cashier")
    return (
      <div className="credit">
        <h2>Prices</h2>
        <p className="muted">{staff ? "Only managers and owners can change prices." : "Sign in as a manager or owner to change prices."} {!staff && <a href="/login">Sign in</a>}</p>
      </div>
    );

  const book = catalog.pricebooks.find((b) => b.id === bookId) ?? catalog.pricebooks[0]!;

  /** One call for every change: sends it, reports problems in plain words, asks the POS to reload. */
  async function send(method: string, path: string, body: object, done: string) {
    setMsg(null);
    const res = await fetch(`/api/catalog/${path}`, { method, headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify(body) }).catch(() => null);
    if (!res) return setMsg("Could not reach the server. Nothing was changed.");
    if (res.status === 401 && ((await res.clone().json().catch(() => ({}))) as { error?: string }).error === "device_not_enrolled") return markDeviceRejected();
    if (res.status === 401) return setMsg("Your session has ended. Sign in again. Nothing was changed.");
    if (res.status === 403) return setMsg("This account isn't allowed to change prices.");
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
      return setMsg(`Not changed: ${j.problems?.join("; ") ?? j.error ?? res.status}`);
    }
    setMsg(done);
    window.dispatchEvent(new Event("pos:catalog-refresh"));
  }

  /** Save an item's option groups and combo slots. Returns the reason in plain words when it did not work. */
  async function saveOptions(productId: string, options: OptionGroup[], bcrs: boolean): Promise<string | null> {
    const p = catalog.products.find((x) => x.id === productId);
    if (!p) return "That item is gone.";
    const res = await fetch("/api/catalog/products", { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ id: p.id, name: p.name, category: p.category, pointsExempt: p.pointsExempt, soldOut: p.soldOut, bcrs, options }) }).catch(() => null);
    if (!res) return "Could not reach the server. Nothing was changed.";
    if (res.status === 401) return "Your session has ended. Sign in again. Nothing was changed.";
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
      return `Not saved: ${j.problems?.join("; ") ?? j.error ?? res.status}`;
    }
    setEditingOptions(null);
    setMsg(options.length ? `Options saved for ${p.name}.` : `Options cleared for ${p.name}.`);
    window.dispatchEvent(new Event("pos:catalog-refresh"));
    return null;
  }

  const savePrice = (productId: string, text: string) => {
    const cents = toCents(text);
    if (cents === null) return setMsg("Enter a price like 2.20");
    if (book.prices[productId] === cents) return setDraft((d) => ({ ...d, [productId]: "" }));
    void send("PUT", `pricebooks/${book.id}/prices/${productId}`, { priceCents: cents }, "Price saved.");
    setDraft((d) => ({ ...d, [productId]: "" }));
  };

  const assignmentFor = (channelId: string) => catalog.assignments.find((a) => a.channelId === channelId && !a.outletId)?.pricebookId ?? "";

  async function uploadBrandImage(e: React.ChangeEvent<HTMLInputElement>, path: "logo" | "hero", label: string) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 300 * 1024) return setMsg(`That ${label.toLowerCase()} is too big. Use a PNG, JPEG or WebP under 300 KB.`);
    const res = await fetch(`/api/brand/${path}`, { method: "PUT", headers: { "content-type": f.type, ...authHeader() }, body: f }).catch(() => null);
    if (res?.ok) {
      setBrand((await res.json()) as Brand);
      setMsg(`${label} saved.`);
    } else setMsg(((await res?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? `The ${label.toLowerCase()} was not saved.`);
  }

  return (
    <div className="credit prices">
      <h2>Prices</h2>
      {msg && <div className="flash">{msg}</div>}

      <label className="field">
        Pricebook
        <select value={book.id} onChange={(e) => setBookId(e.target.value)}>
          {catalog.pricebooks.map((b) => (
            <option key={b.id} value={b.id}>{b.name}{b.id === catalog.defaultPricebookId ? " (default)" : ""}</option>
          ))}
        </select>
      </label>
      <p><a href={`/pricebook/${book.id}`}>Edit all items in a table →</a></p>
      <div className="row">
        {book.id !== catalog.defaultPricebookId && (
          <button className="secondary sm" onClick={() => void send("PUT", "default-pricebook", { pricebookId: book.id }, `${book.name} is now the default.`)}>Make default</button>
        )}
        {book.id !== catalog.defaultPricebookId && (
          <label className="inline">
            Items without a price here:
            <select value={book.missing} onChange={(e) => void send("PATCH", `pricebooks/${book.id}`, { missing: e.target.value }, "Saved.")}>
              <option value="show">show it, but it cannot be ordered</option>
              <option value="hide">don't sell them</option>
            </select>
          </label>
        )}
      </div>

      <details className="catlist">
        <summary>Categories ({new Set(catalog.products.map((p) => p.category)).size})</summary>
        {[...new Set(catalog.products.map((p) => p.category))].map((c) => (
          <div className="catrow" key={c}>
            <span>{c} <i className="muted">· {catalog.products.filter((p) => p.category === c).length}</i></span>
            <button className="pencil" aria-label={`Rename category ${c}`} title="Rename category" onClick={() => setRenamingCat({ from: c, to: c, names: { ...(catalog.categoryNames?.[c] ?? {}) } })}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
          </div>
        ))}
      </details>

      <div className="pricelist">
        <input className="findbox" placeholder={`Search ${catalog.products.length} items`} value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search items" />
        {catalog.products.filter((p) => !find.trim() || `${p.name} ${p.category}`.toLowerCase().includes(find.trim().toLowerCase())).map((p) => {
          const own = book.prices[p.id];
          return (
            <div className="pricerow" key={p.id}>
              <span className="nm">{p.name}{p.soldOut ? <i className="muted"> · sold out</i> : null}{" "}
                <button className="pencil" aria-label={`Rename ${p.name}`} title="Rename" onClick={() => setRenaming({ id: p.id, name: p.name, names: { ...(p.names ?? {}) } })}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              </span>
              <input
                inputMode="decimal"
                placeholder={own === undefined ? "—" : (own / 100).toFixed(2)}
                value={draft[p.id] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                onBlur={(e) => e.target.value && savePrice(p.id, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                aria-label={`Price for ${p.name}`}
              />
              <span className="muted cur">{own === undefined ? (book.missing === "hide" ? "not sold" : "default") : formatMoney(own)}</span>
              {own !== undefined && (
                <button className={book.off?.includes(p.id) ? "secondary sm" : "primary sm"} aria-pressed={!book.off?.includes(p.id)} title={book.off?.includes(p.id) ? "Off in this pricebook: hidden online, greyed out on the till. Press to switch on." : "On. Press to switch off in this pricebook (hides it online, greys it out on the till)."} onClick={() => void send("PUT", `pricebooks/${book.id}/off/${p.id}`, { off: !book.off?.includes(p.id) }, book.off?.includes(p.id) ? `${p.name} is back on in ${book.name}.` : `${p.name} is off in ${book.name}.`)}>{book.off?.includes(p.id) ? "Off" : "On"}</button>
              )}
              {own !== undefined && book.id !== catalog.defaultPricebookId && (
                <button className="secondary sm" title="Remove this price" onClick={() => void send("PUT", `pricebooks/${book.id}/prices/${p.id}`, { priceCents: null }, "Price removed.")}>✕</button>
              )}
              <label className="secondary sm filebtn" title="Replace this item's photo">
                {p.imageVersion ? "Photo" : "Add photo"}
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={`Photo for ${p.name}`} onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (f.size > 300 * 1024) return setMsg("That photo is too big. Use a PNG, JPEG or WebP under 300 KB.");
                  const res = await fetch(`/api/catalog/products/${p.id}/image`, { method: "PUT", headers: { "content-type": f.type, ...authHeader() }, body: f }).catch(() => null);
                  if (res?.ok) { setMsg(`Photo saved for ${p.name}.`); window.dispatchEvent(new Event("pos:catalog-refresh")); }
                  else setMsg(((await res?.json().catch(() => ({}))) as { problems?: string[]; error?: string } | undefined)?.problems?.join("; ") ?? "The photo was not saved.");
                }} />
              </label>
              <button className="secondary sm" title="Variants, modifiers and combo parts for this item" onClick={() => setEditingOptions(p.id)}>
                {isCombo(p.options) ? "Combo" : p.options?.length ? `Options (${p.options.length})` : "Options"}
              </button>
              <button className="secondary sm" onClick={() => void send("POST", "products", { id: p.id, name: p.name, category: p.category, pointsExempt: p.pointsExempt, soldOut: !p.soldOut }, p.soldOut ? "Back on sale." : "Marked sold out.")}>
                {p.soldOut ? "Back on" : "Sold out"}
              </button>
            </div>
          );
        })}
      </div>

      {renamingCat && (() => {
        const to = renamingCat.to.trim();
        const cleanC = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
        const catNow = cleanC(renamingCat.names);
        const catChanged = JSON.stringify(Object.entries(catNow).sort()) !== JSON.stringify(Object.entries(cleanC(catalog.categoryNames?.[renamingCat.from] ?? {})).sort());
        const save = () => {
          if (!to) return;
          const from = renamingCat.from;
          setRenamingCat(null);
          if (to !== from || catChanged) void send("POST", "categories/rename", { from, to, ...(catChanged ? { names: catNow } : {}) }, to !== from ? `${from} is now ${to}.` : "Names saved.");
        };
        return (
          <div className="rn-back" onClick={() => setRenamingCat(null)}>
            <div className="rn-modal" role="dialog" aria-modal="true" aria-label={`Rename category ${renamingCat.from}`} onClick={(e) => e.stopPropagation()}>
              <h3>Rename category</h3>
              <p className="muted">Every item in “{renamingCat.from}” moves to the new name. Printers set to this category keep printing it. Using an existing name merges the two.</p>
              <input autoFocus value={renamingCat.to} maxLength={80} aria-label="New category name" onChange={(e) => setRenamingCat({ ...renamingCat, to: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setRenamingCat(null); }} />
              <details style={{ marginTop: 10 }} open={Object.keys(catNow).length > 0}>
                <summary>Name in other languages <span className="muted">(optional)</span></summary>
                <p className="muted" style={{ margin: "6px 0" }}>Shown to customers who pick that language. Leave one blank to show the name above. Nothing is translated automatically.</p>
                {LANGS.filter((l) => l.code !== "en").map((l) => (
                  <label key={l.code} style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
                    <span style={{ width: 120, flex: "none" }}>{l.native}</span>
                    <input style={{ flex: 1 }} value={renamingCat.names[l.code] ?? ""} maxLength={80} aria-label={`Category name in ${l.en}`} onChange={(e) => setRenamingCat({ ...renamingCat, names: { ...renamingCat.names, [l.code]: e.target.value } })} />
                  </label>
                ))}
              </details>
              <div className="rn-actions">
                <button className="secondary" onClick={() => setRenamingCat(null)}>Cancel</button>
                <button className="primary" disabled={!to || (to === renamingCat.from && !catChanged)} onClick={save}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}

      {editingOptions && (() => {
        const p = catalog.products.find((x) => x.id === editingOptions);
        return p ? <OptionsEditor product={p} catalog={catalog} onSave={(groups, bcrs) => saveOptions(p.id, groups, bcrs)} onClose={() => setEditingOptions(null)} /> : null;
      })()}

      {renaming && (() => {
        const p = catalog.products.find((x) => x.id === renaming.id);
        if (!p) return null;
        const name = renaming.name.trim();
        const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
        const namesNow = clean(renaming.names);
        const namesChanged = JSON.stringify(Object.entries(namesNow).sort()) !== JSON.stringify(Object.entries(clean(p.names ?? {})).sort());
        const save = () => {
          if (!name) return;
          setRenaming(null);
          // Container deposit (BCRS): a name that says BCRS switches the deposit ON; a rename that drops "BCRS" while it is ON asks first
          // (the rename always saves; the deposit goes OFF only if confirmed, and a manual OFF is never switched back on by a rename).
          let bcrsPatch: { bcrs?: boolean } = {};
          if (!/bcrs/i.test(p.name) && /bcrs/i.test(name) && !p.bcrs) bcrsPatch = { bcrs: true };
          if (/bcrs/i.test(p.name) && !/bcrs/i.test(name) && p.bcrs && window.confirm("The name no longer says BCRS. Turn the container deposit OFF for this item?")) bcrsPatch = { bcrs: false };
          if (name !== p.name || namesChanged) void send("POST", "products", { id: p.id, name, category: p.category, pointsExempt: p.pointsExempt, soldOut: p.soldOut, ...bcrsPatch, ...(namesChanged ? { names: namesNow } : {}) }, name !== p.name ? `Renamed to ${name}.` : "Names saved.");
        };
        return (
          <div className="rn-back" onClick={() => setRenaming(null)}>
            <div className="rn-modal" role="dialog" aria-modal="true" aria-label={`Rename ${p.name}`} onClick={(e) => e.stopPropagation()}>
              <h3>Rename item</h3>
              <p className="muted">Currently “{p.name}”. Its photo, options and prices stay as they are.</p>
              <input autoFocus value={renaming.name} maxLength={120} aria-label="New name" onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setRenaming(null); }} />
              <details style={{ marginTop: 10 }} open={Object.keys(namesNow).length > 0}>
                <summary>Name in other languages <span className="muted">(optional)</span></summary>
                <p className="muted" style={{ margin: "6px 0" }}>Shown to customers who pick that language. Leave one blank to show the name above. Nothing is translated automatically.</p>
                {LANGS.filter((l) => l.code !== "en").map((l) => (
                  <label key={l.code} style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
                    <span style={{ width: 120, flex: "none" }}>{l.native}</span>
                    <input style={{ flex: 1 }} value={renaming.names[l.code] ?? ""} maxLength={80} aria-label={`Name in ${l.en}`} onChange={(e) => setRenaming({ ...renaming, names: { ...renaming.names, [l.code]: e.target.value } })} />
                  </label>
                ))}
              </details>
              <div className="rn-actions">
                <button className="secondary" onClick={() => setRenaming(null)}>Cancel</button>
                <button className="primary" disabled={!name || (name === p.name && !namesChanged)} onClick={save}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}

      <h3>Add an item</h3>
      <div className="row">
        <input placeholder="Name" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
        <input placeholder="Category" value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })} list="cats" />
        <datalist id="cats">{[...new Set(catalog.products.map((p) => p.category))].map((c) => <option key={c} value={c} />)}</datalist>
        <input placeholder="Price" inputMode="decimal" value={newItem.price} onChange={(e) => setNewItem({ ...newItem, price: e.target.value })} />
        <button
          className="primary sm"
          disabled={!newItem.name.trim() || !newItem.category.trim() || toCents(newItem.price) === null}
          onClick={() => {
            void send("POST", "products", { name: newItem.name, category: newItem.category, priceCents: toCents(newItem.price) }, `${newItem.name} added at the default price.`);
            setNewItem({ name: "", category: "", price: "" });
          }}
        >Add</button>
      </div>

      <h3>Channels</h3>
      <p className="muted">Each channel can use its own pricebook and decide whether service charge applies.</p>
      {catalog.channels.map((c) => (
        <div className="chrow" key={c.id}>
          <input defaultValue={c.name} aria-label="Channel name" onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && void send("POST", "channels", { ...c, name: e.target.value }, "Channel renamed.")} />
          <select value={assignmentFor(c.id)} aria-label={`Pricebook for ${c.name}`} onChange={(e) => void (e.target.value ? send("PUT", "assignments", { pricebookId: e.target.value, channelId: c.id }, "Pricebook set.") : send("POST", "assignments/remove", { channelId: c.id }, "Back to the default pricebook."))}>
            <option value="">default pricebook</option>
            {catalog.pricebooks.filter((b) => b.id !== catalog.defaultPricebookId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <label className="inline"><input type="checkbox" checked={c.serviceCharge} onChange={(e) => void send("POST", "channels", { ...c, serviceCharge: e.target.checked }, "Saved.")} /> service charge</label>
          <label className="inline"><input type="checkbox" checked={c.active} onChange={(e) => void send("POST", "channels", { ...c, active: e.target.checked }, "Saved.")} /> on</label>
        </div>
      ))}
      <div className="row">
        <select aria-label="Kind of new channel" value={newKind} onChange={(e) => setNewKind(e.target.value as ChannelKind)}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="secondary sm" onClick={() => {
          const name = window.prompt("Name of the new channel (e.g. FoodPanda, Movie Event)");
          if (name?.trim()) void send("POST", "channels", { name, kind: newKind, serviceCharge: newKind === "dine_in", active: true }, `${name} added.`);
        }}>Add a channel</button>
      </div>

      <h3>Shop look</h3>
      <p className="muted">How the page customers order from looks. Share <b>{location.origin}/shop</b>, or add <b>?table=Table%205</b> for a table's QR code.</p>
      {brand && (
        <div className="brandbox">
          <div className="row brand">
            {brand.logoUrl ? <img className="logo-preview" src={brand.logoUrl} alt="Current logo" /> : <span className="muted">No logo yet</span>}
            <label className="secondary sm filebtn">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Upload logo" onChange={(e) => void uploadBrandImage(e, "logo", "Logo")} /></label>
            {brand.heroUrl ? <img className="logo-preview wide" src={brand.heroUrl} alt="Current top photo" /> : <span className="muted">No top photo yet</span>}
            <label className="secondary sm filebtn">Upload top photo<input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Upload top photo" onChange={(e) => void uploadBrandImage(e, "hero", "Top photo")} /></label>
          </div>
          <div className="row brand">
            <label className="inline">Button colour <input type="color" value={brand.primary} onChange={(e) => setBrand({ ...brand, primary: e.target.value })} aria-label="Button colour" /></label>
            <label className="inline">Highlight colour <input type="color" value={brand.accent} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} aria-label="Highlight colour" /></label>
            {brand.logoUrl && <button className="secondary sm" onClick={() => void (async () => {
              // The logo comes first and is never recoloured: its own colours become the shop's. The manager checks them, then saves.
              const img = new Image();
              img.crossOrigin = "anonymous";
              const loaded = await new Promise<boolean>((ok) => { img.onload = () => ok(true); img.onerror = () => ok(false); img.src = brand.logoUrl!; });
              if (!loaded) { setMsg("Could not read the logo."); return; }
              const c = document.createElement("canvas");
              c.width = 96; c.height = 96;
              const g = c.getContext("2d", { willReadFrequently: true });
              if (!g) { setMsg("Could not read the logo."); return; }
              g.drawImage(img, 0, 0, 96, 96);
              const found = brandColoursFromPixels(g.getImageData(0, 0, 96, 96).data);
              if (!found) { setMsg("The logo has no colour to take (it is black and white). Choose the colours yourself."); return; }
              setBrand({ ...brand, primary: found.primary, accent: found.accent });
              setMsg("Colours taken from the logo. Check them, then press Save colours.");
            })()}>Use the logo's colours</button>}
            <button className="primary sm" onClick={async () => {
              const r = await staffFetch("/api/brand", { method: "PUT", body: { primary: brand.primary, accent: brand.accent } });
              setMsg("problem" in r ? r.problem : r.res.ok ? "Shop colours saved." : "Colours were not saved.");
            }}>Save colours</button>
          </div>
          <div className="editor">
            <label className="field">Line under the top photo<input aria-label="Tagline" maxLength={80} value={brand.tagline ?? ""} onChange={(e) => setBrand({ ...brand, tagline: e.target.value })} /></label>
            <label className="field">Special offer title (leave empty to hide the offer)<input aria-label="Offer title" maxLength={80} value={brand.promoTitle ?? ""} onChange={(e) => setBrand({ ...brand, promoTitle: e.target.value })} /></label>
            <label className="field">Special offer text<textarea aria-label="Offer text" maxLength={400} rows={3} value={brand.promoBody ?? ""} onChange={(e) => setBrand({ ...brand, promoBody: e.target.value })} /></label>
            <button className="primary sm" onClick={async () => {
              const r = await staffFetch("/api/brand/content", { method: "PUT", body: { tagline: brand.tagline ?? "", promoTitle: brand.promoTitle ?? "", promoBody: brand.promoBody ?? "" } });
              setMsg("problem" in r ? r.problem : r.res.ok ? "Shop text saved." : "The text was not saved.");
            }}>Save text</button>
          </div>
        </div>
      )}

      <h3>New pricebook</h3>
      <div className="row">
        <input placeholder="e.g. LIDO, Weekend, Grab" value={newBook} onChange={(e) => setNewBook(e.target.value)} />
        <button className="primary sm" disabled={!newBook.trim()} onClick={() => { void send("POST", "pricebooks", { name: newBook }, `${newBook} created. Pick it above and set its prices.`); setNewBook(""); }}>Create</button>
      </div>
      <StockPanel catalog={catalog} outletId={outletId} />
      <PromoPanel />
      <p className="muted">Outlet: {outletId}. To price one outlet differently, create a pricebook and assign it to that outlet through the API for now.</p>
    </div>
  );
}
