import { useEffect, useState } from "react";
import type { Catalog } from "@pos/core";
import { staffFetch } from "../auth";

interface OutletRow { id: string; name: string }

/**
 * Price Zones (HQ only). A zone is a named group of outlets; for each channel it points at one pricebook. Prices live only in the pricebooks:
 * the zone just says who uses which. An outlet is in one zone. A store login never sees this (the server refuses it as well).
 */
export function ZonesPanel({ catalog }: { catalog: Catalog }) {
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [editId, setEditId] = useState<string | undefined>();
  const [picked, setPicked] = useState<string[]>([]);
  const [books, setBooks] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void staffFetch("/api/outlets").then(async (r) => { if ("res" in r && r.res.ok) { const j = (await r.res.json()) as { outlets?: OutletRow[] } | OutletRow[]; setOutlets(Array.isArray(j) ? j : j.outlets ?? []); } });
  }, []);

  const zones = catalog.zones ?? [];
  const channels = catalog.channels.filter((c) => c.active);
  const reset = () => { setOpen(false); setEditId(undefined); setName(""); setPicked([]); setBooks({}); };
  const edit = (id: string) => {
    const z = zones.find((x) => x.id === id)!;
    setEditId(z.id); setName(z.name); setPicked(z.outletIds);
    setBooks(Object.fromEntries(z.books.map((b) => [b.channelId ?? "", b.pricebookId])));
    setOpen(true);
  };
  async function save() {
    const body = { id: editId, name, outletIds: picked, books: Object.entries(books).filter(([, p]) => p).map(([channelId, pricebookId]) => ({ ...(channelId ? { channelId } : {}), pricebookId })) };
    const r = await staffFetch("/api/catalog/zones", { method: "PUT", body });
    if ("res" in r && r.res.ok) { setMsg(`${name} saved.`); reset(); window.dispatchEvent(new Event("pos:catalog-refresh")); }
    else if ("res" in r) { const j = (await r.res.json().catch(() => ({}))) as { problems?: string[]; error?: string }; setMsg(j.problems?.join(" ") ?? (j.error === "brand_only" ? "Only head office can change price zones." : j.error ?? "Could not save.")); }
    else setMsg(r.problem);
  }
  async function remove(id: string) {
    const r = await staffFetch(`/api/catalog/zones/${encodeURIComponent(id)}`, { method: "DELETE" });
    if ("res" in r && r.res.ok) { setMsg("Zone removed."); window.dispatchEvent(new Event("pos:catalog-refresh")); }
  }
  const bookSelect = (channelId: string, label: string) => (
    <label className="field" key={channelId || "any"}>{label}
      <select value={books[channelId] ?? ""} onChange={(e) => setBooks({ ...books, [channelId]: e.target.value })}>
        <option value="">Not set (use the usual pricebook)</option>
        {catalog.pricebooks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  );

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Price zones</h3>
      <p className="muted">Head office groups outlets into a zone and says which pricebook the zone uses for each channel. Outlets never change their own prices; an outlet that needs different pricing is moved to another zone.</p>
      {msg && <div className="flash">{msg}</div>}
      {zones.length === 0 && <p className="muted">No price zones yet. Every outlet uses its own assignment or the default pricebook.</p>}
      {zones.map((z) => (
        <div className="row" key={z.id} style={{ alignItems: "center" }}>
          <span style={{ flex: 1 }}><b>{z.name}</b><small className="muted" style={{ display: "block" }}>{z.outletIds.length} {z.outletIds.length === 1 ? "outlet" : "outlets"}: {z.outletIds.map((o) => outlets.find((x) => x.id === o)?.name ?? o).join(", ") || "none"}</small></span>
          <button className="secondary sm" onClick={() => edit(z.id)}>Edit</button>
          <button className="secondary sm" onClick={() => void remove(z.id)}>Remove</button>
        </div>
      ))}
      {!open ? <button className="secondary sm" onClick={() => setOpen(true)}>New price zone</button> : (
        <div className="editor">
          <label className="field">Zone name<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Town outlets" /></label>
          <p className="muted" style={{ margin: "8px 0 4px" }}>Outlets in this zone</p>
          {outlets.map((o) => (
            <label key={o.id} className="inline"><input type="checkbox" checked={picked.includes(o.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))} /> {o.name}</label>
          ))}
          <p className="muted" style={{ margin: "8px 0 4px" }}>Pricebook for each channel</p>
          {bookSelect("", "Any channel without its own setting")}
          {channels.map((c) => bookSelect(c.id, c.name))}
          <div className="row">
            <button className="primary" disabled={!name.trim()} onClick={() => void save()}>Save zone</button>
            <button className="secondary" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
