import { useState } from "react";
import { formatMoney, type Catalog } from "@pos/core";
import { staffFetch } from "../auth";

const TZ = "+08:00";
const stamp = (d: number) => new Date(d).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" });

/**
 * Promotional prices (HQ only): one item at a special price between two moments, in one pricebook or in every pricebook.
 * The pricebook keeps its real price; when the promotion ends the pricebook price is simply back.
 */
export function PromoPricesPanel({ catalog }: { catalog: Catalog }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [productId, setProductId] = useState("");
  const [bookId, setBookId] = useState("");
  const [price, setPrice] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState("");
  const list = catalog.overrides ?? [];
  const now = Date.now();
  const reset = () => { setOpen(false); setTitle(""); setProductId(""); setBookId(""); setPrice(""); setFrom(""); setTo(""); };
  const ok = title.trim() && productId && Number(price) >= 0 && price !== "" && from && to && Date.parse(`${to}${TZ}`) > Date.parse(`${from}${TZ}`);

  async function save() {
    const body = { title, productId, ...(bookId ? { pricebookId: bookId } : {}), priceCents: Math.round(Number(price) * 100), startsAt: Date.parse(`${from}${TZ}`), endsAt: Date.parse(`${to}${TZ}`) };
    const r = await staffFetch("/api/catalog/overrides", { method: "PUT", body });
    if ("res" in r && r.res.ok) { setMsg(`${title} saved.`); reset(); window.dispatchEvent(new Event("pos:catalog-refresh")); }
    else if ("res" in r) { const j = (await r.res.json().catch(() => ({}))) as { problems?: string[]; error?: string }; setMsg(j.problems?.join(" ") ?? (j.error === "brand_only" ? "Only head office can set promotional prices." : "Could not save.")); }
    else setMsg(r.problem);
  }
  async function remove(id: string) {
    const r = await staffFetch(`/api/catalog/overrides/${encodeURIComponent(id)}`, { method: "DELETE" });
    if ("res" in r && r.res.ok) { setMsg("Promotion removed."); window.dispatchEvent(new Event("pos:catalog-refresh")); }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Promotional prices</h3>
      <p className="muted">A special price for one item between two times (Singapore time). It never changes a pricebook: when it ends, the usual price is back.</p>
      {msg && <div className="flash">{msg}</div>}
      {list.length === 0 && <p className="muted">No promotional prices.</p>}
      {list.map((o) => (
        <div className="row" key={o.id} style={{ alignItems: "center", opacity: o.endsAt <= now ? 0.5 : 1 }}>
          <span style={{ flex: 1 }}><b>{o.title}</b> · {catalog.products.find((p) => p.id === o.productId)?.name ?? o.productId} at {formatMoney(o.priceCents)}
            <small className="muted" style={{ display: "block" }}>{stamp(o.startsAt)} to {stamp(o.endsAt)} · {o.pricebookId ? catalog.pricebooks.find((b) => b.id === o.pricebookId)?.name ?? o.pricebookId : "every pricebook"}{o.endsAt <= now ? " · ended" : o.startsAt > now ? " · scheduled" : " · running"}</small></span>
          <button className="secondary sm" onClick={() => void remove(o.id)}>Remove</button>
        </div>
      ))}
      {!open ? <button className="secondary sm" onClick={() => setOpen(true)}>New promotional price</button> : (
        <div className="editor">
          <label className="field">Name<input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Happy hour" /></label>
          <div className="row">
            <label className="field">Item<select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Choose an item</option>{catalog.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field">Pricebook<select value={bookId} onChange={(e) => setBookId(e.target.value)}><option value="">Every pricebook</option>{catalog.pricebooks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label className="field">Promotional price (S$)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          </div>
          <div className="row">
            <label className="field">Starts<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field">Ends<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <div className="row">
            <button className="primary" disabled={!ok} onClick={() => void save()}>Save</button>
            <button className="secondary" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
