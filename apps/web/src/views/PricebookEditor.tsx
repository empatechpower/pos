import { useMemo, useState } from "react";
import { formatMoney, type Catalog } from "@pos/core";
import { authHeader, useStaff } from "../auth";
import { markDeviceRejected } from "../device";

/** "2.2" -> 220, "0" -> 0 (free is a real price), "" -> null (no price). Anything else is not valid. */
function parsePrice(text: string): number | null | "bad" {
  const t = text.trim().replace(/^s?\$/i, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 100000 && /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(n * 100) : "bad";
}

/**
 * Edit every item in one pricebook in a table: its price, and whether it is on. Nothing is saved until "Save changes",
 * and the whole set goes in as one step (all of it or none).
 */
export function PricebookEditor({ catalog, bookId }: { catalog: Catalog; bookId: string }) {
  const staff = useStaff();
  const book = catalog.pricebooks.find((b) => b.id === bookId);
  const [price, setPrice] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [find, setFind] = useState("");
  const [cat, setCat] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = useMemo(() => [...new Set(catalog.products.map((p) => p.category))], [catalog]);

  if (!staff || staff.role === "cashier") return <div className="credit"><h2>Edit prices</h2><p className="muted">Sign in as a manager or owner to edit prices. <a href="#/login">Sign in</a></p></div>;
  if (!book) return <div className="credit"><h2>Edit prices</h2><p className="muted">That pricebook doesn't exist (any more). <a href="#/prices">Back to Prices</a></p></div>;

  const current = (id: string) => (book.prices[id] === undefined ? "" : (book.prices[id]! / 100).toFixed(2));
  const shownPrice = (id: string) => price[id] ?? current(id);
  const isOff = (id: string) => off[id] ?? !!book.off?.includes(id);
  const priceChanged = (id: string) => price[id] !== undefined && parsePrice(price[id]!) !== (book.prices[id] ?? null);
  const offChanged = (id: string) => off[id] !== undefined && off[id] !== !!book.off?.includes(id);
  const changedIds = catalog.products.map((p) => p.id).filter((id) => priceChanged(id) || offChanged(id));
  const badIds = catalog.products.map((p) => p.id).filter((id) => price[id] !== undefined && parsePrice(price[id]!) === "bad");

  const rows = catalog.products.filter((p) => (!cat || p.category === cat) && (!find.trim() || `${p.name} ${p.altName ?? ""}`.toLowerCase().includes(find.trim().toLowerCase())) && (!onlyChanged || changedIds.includes(p.id)));

  async function save() {
    if (busy || !changedIds.length || badIds.length) return;
    setBusy(true);
    setMsg(null);
    const prices: Record<string, number | null> = {};
    const offs: Record<string, boolean> = {};
    for (const id of changedIds) {
      if (priceChanged(id)) prices[id] = parsePrice(price[id]!) as number | null;
      if (offChanged(id)) offs[id] = off[id]!;
    }
    const res = await fetch(`/api/catalog/pricebooks/${book!.id}/bulk`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ prices, off: offs }) }).catch(() => null);
    setBusy(false);
    if (!res) return setMsg({ ok: false, text: "Could not reach the server. Nothing was saved." });
    if (res.status === 401) {
      if (((await res.clone().json().catch(() => ({}))) as { error?: string }).error === "device_not_enrolled") markDeviceRejected();
      return setMsg({ ok: false, text: "Your session has ended. Sign in again. Nothing was saved." });
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { problems?: string[]; error?: string };
      return setMsg({ ok: false, text: `Nothing was saved: ${j.problems?.join("; ") ?? j.error ?? res.status}` });
    }
    setMsg({ ok: true, text: `Saved ${changedIds.length} change${changedIds.length === 1 ? "" : "s"} in ${book!.name}. It is live now.` });
    setPrice({});
    setOff({});
    window.dispatchEvent(new Event("pos:catalog-refresh"));
  }

  return (
    <div className="credit prices wide editor">
      <h2>Edit {book.name}</h2>
      <p className="muted">Change prices or switch items off, then press <b>Save changes</b>. A price of 0 sells the item for free. An empty price means it isn't sold in this pricebook. <b>Off</b> hides it from online ordering and greys it out on the till; the price is kept.</p>
      {msg && <div className={`flash ${msg.ok ? "" : "warn"}`}>{msg.text}</div>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input className="findbox" placeholder={`Search ${catalog.products.length} items`} value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search items" style={{ flex: 1, minWidth: 160 }} />
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <label className="inline"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only changed</label>
      </div>
      <div className="editor-bar">
        <span>{changedIds.length ? <b>{changedIds.length} change{changedIds.length === 1 ? "" : "s"} not saved</b> : "No changes yet"}{badIds.length ? <span className="muted"> · {badIds.length} price{badIds.length === 1 ? " needs" : "s need"} fixing</span> : null}</span>
        <span>
          {changedIds.length > 0 && <button className="secondary sm" onClick={() => { setPrice({}); setOff({}); }}>Undo all</button>}{" "}
          <button className="primary sm" disabled={busy || !changedIds.length || badIds.length > 0} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
        </span>
      </div>
      <div className="pricelist">
        {rows.length === 0 && <p className="muted">No items match.</p>}
        {rows.map((p) => {
          const bad = badIds.includes(p.id);
          const changed = changedIds.includes(p.id);
          const unpriced = book.prices[p.id] === undefined && price[p.id] === undefined;
          return (
            <div className="pricerow" key={p.id} style={changed ? { background: "var(--selected, #fdeee0)" } : undefined}>
              <span className="nm">{p.name}<i className="muted"> · {p.category}{p.soldOut ? " · sold out" : ""}</i></span>
              <span className="muted">S$</span>
              <input
                inputMode="decimal"
                value={shownPrice(p.id)}
                placeholder={unpriced ? "no price" : ""}
                onChange={(e) => setPrice((d) => ({ ...d, [p.id]: e.target.value }))}
                aria-label={`Price for ${p.name}`}
                aria-invalid={bad}
                style={bad ? { borderColor: "#c0392b" } : { width: 90 }}
              />
              <button className={isOff(p.id) ? "secondary sm" : "primary sm"} aria-pressed={!isOff(p.id)} onClick={() => setOff((o) => ({ ...o, [p.id]: !isOff(p.id) }))} title={isOff(p.id) ? "Off: hidden online, greyed out on the till. Press to switch on." : "On: sold. Press to switch off."}>{isOff(p.id) ? "Off" : "On"}</button>
              {book.prices[p.id] !== undefined && !changed && <span className="muted cur">{formatMoney(book.prices[p.id]!)}</span>}
            </div>
          );
        })}
      </div>
      <p><a href="#/prices">← Back to Prices</a></p>
    </div>
  );
}
