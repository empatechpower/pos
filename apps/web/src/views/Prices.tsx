import { useEffect, useState } from "react";
import { formatMoney, type Catalog, type ChannelKind } from "@pos/core";
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

/** Managers and owners: prices per pricebook, channels, and where each pricebook applies. */
export function Prices({ catalog, outletId }: { catalog: Catalog; outletId: string }) {
  const staff = useStaff();
  const [bookId, setBookId] = useState(catalog.defaultPricebookId);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newItem, setNewItem] = useState({ name: "", category: "", price: "" });
  const [newBook, setNewBook] = useState("");
  const [newKind, setNewKind] = useState<ChannelKind>("delivery");
  const [brand, setBrand] = useState<{ primary: string; accent: string; logoUrl: string | null } | null>(null);
  useEffect(() => {
    void fetch("/api/brand").then(async (r) => r.ok && setBrand((await r.json()) as { primary: string; accent: string; logoUrl: string | null }));
  }, []);

  if (!staff || staff.role === "cashier")
    return (
      <div className="credit">
        <h2>Prices</h2>
        <p className="muted">{staff ? "Only managers and owners can change prices." : "Sign in as a manager or owner to change prices."} {!staff && <a href="#/login">Sign in</a>}</p>
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

  const savePrice = (productId: string, text: string) => {
    const cents = toCents(text);
    if (cents === null) return setMsg("Enter a price like 2.20");
    if (book.prices[productId] === cents) return setDraft((d) => ({ ...d, [productId]: "" }));
    void send("PUT", `pricebooks/${book.id}/prices/${productId}`, { priceCents: cents }, "Price saved.");
    setDraft((d) => ({ ...d, [productId]: "" }));
  };

  const assignmentFor = (channelId: string) => catalog.assignments.find((a) => a.channelId === channelId && !a.outletId)?.pricebookId ?? "";

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
      <div className="row">
        {book.id !== catalog.defaultPricebookId && (
          <button className="secondary sm" onClick={() => void send("PUT", "default-pricebook", { pricebookId: book.id }, `${book.name} is now the default.`)}>Make default</button>
        )}
        {book.id !== catalog.defaultPricebookId && (
          <label className="inline">
            Items without a price here:
            <select value={book.missing} onChange={(e) => void send("PATCH", `pricebooks/${book.id}`, { missing: e.target.value }, "Saved.")}>
              <option value="fallback">use the default price</option>
              <option value="hide">don't sell them</option>
            </select>
          </label>
        )}
      </div>

      <div className="pricelist">
        {catalog.products.map((p) => {
          const own = book.prices[p.id];
          return (
            <div className="pricerow" key={p.id}>
              <span className="nm">{p.name}{p.soldOut ? <i className="muted"> · sold out</i> : null}</span>
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
              {own !== undefined && book.id !== catalog.defaultPricebookId && (
                <button className="secondary sm" title="Remove this price" onClick={() => void send("PUT", `pricebooks/${book.id}/prices/${p.id}`, { priceCents: null }, "Price removed.")}>✕</button>
              )}
              <button className="secondary sm" onClick={() => void send("POST", "products", { id: p.id, name: p.name, category: p.category, pointsExempt: p.pointsExempt, soldOut: !p.soldOut }, p.soldOut ? "Back on sale." : "Marked sold out.")}>
                {p.soldOut ? "Back on" : "Sold out"}
              </button>
            </div>
          );
        })}
      </div>

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
      <p className="muted">Colours and logo on the page customers order from. Share <b>{location.origin}/#/shop</b>, or add <b>?table=Table%205</b> for a table's QR code.</p>
      {brand && (
        <div className="row brand">
          {brand.logoUrl ? <img className="logo-preview" src={brand.logoUrl} alt="Current logo" /> : <span className="muted">No logo yet</span>}
          <label className="inline">Main colour <input type="color" value={brand.primary} onChange={(e) => setBrand({ ...brand, primary: e.target.value })} aria-label="Main colour" /></label>
          <label className="inline">Soft colour <input type="color" value={brand.accent} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} aria-label="Soft colour" /></label>
          <button className="primary sm" onClick={async () => {
            const r = await staffFetch("/api/brand", { method: "PUT", body: { primary: brand.primary, accent: brand.accent } });
            setMsg("problem" in r ? r.problem : r.res.ok ? "Shop colours saved." : "Colours were not saved.");
          }}>Save colours</button>
          <label className="secondary sm filebtn">
            Upload logo
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Upload logo" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > 300 * 1024) return setMsg("That logo is too big. Use a PNG, JPEG or WebP under 300 KB.");
              const res = await fetch("/api/brand/logo", { method: "PUT", headers: { "content-type": f.type, ...authHeader() }, body: f }).catch(() => null);
              if (res?.ok) {
                setBrand((await res.json()) as { primary: string; accent: string; logoUrl: string | null });
                setMsg("Logo saved.");
              } else setMsg((await res?.json().catch(() => ({})) as { error?: string } | undefined)?.error ?? "The logo was not saved.");
            }} />
          </label>
        </div>
      )}

      <h3>New pricebook</h3>
      <div className="row">
        <input placeholder="e.g. LIDO, Weekend, Grab" value={newBook} onChange={(e) => setNewBook(e.target.value)} />
        <button className="primary sm" disabled={!newBook.trim()} onClick={() => { void send("POST", "pricebooks", { name: newBook }, `${newBook} created. Pick it above and set its prices.`); setNewBook(""); }}>Create</button>
      </div>
      <p className="muted">Outlet: {outletId}. To price one outlet differently, create a pricebook and assign it to that outlet through the API for now.</p>
    </div>
  );
}
