import { useEffect, useMemo, useRef, useState } from "react";
import type { MenuEntry } from "@pos/core";
import { PAGE, blankPage, cellsOfLayout, layoutFromAuto, pageCount, pageName, pageOf, standardCells, type Cell, type LayoutCell, type MenuLayout } from "./layout";

export interface LayoutEditing {
  /** The layout in force (the person's own, else the shop's), or null for the automatic one. */
  layout: MenuLayout | null;
  hasOwn: boolean;
  canEditShop: boolean;
  onSaveMine: (l: MenuLayout) => Promise<string | null>;
  onSaveShop: (l: MenuLayout) => Promise<string | null>;
  onResetMine: () => Promise<string | null>;
  /** Set true from outside (the till's settings) to start editing. */
  startRequest: number;
}

/**
 * The menu area: a magnifier and a sliding strip of page tabs on one line, then a 5 x 5 page of tiles. Swipe sideways to change page.
 * A tile shows the item's name (one line) and, once it is on the order, how many. Categories open into their own pages.
 * Press and hold a tile (or use the pencil) to edit the layout: tap a tile, then a cell, to move it; add items, categories or the Discount tile;
 * name and add pages. It is saved as the person's own layout, or, for a manager, as the shop's standard one.
 */
export function TillMenu({ menu, qtyOf, onAdd, onDiscount, editing }: { menu: MenuEntry[]; qtyOf: (id: string) => number; onAdd: (m: MenuEntry) => void; onDiscount: () => void; editing?: LayoutEditing }) {
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const swipe = useRef<number | null>(null);
  const press = useRef<number | null>(null);
  const [draft, setDraft] = useState<MenuLayout | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [picker, setPicker] = useState<null | "item" | "category">(null);
  const [pickQuery, setPickQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [named, setNamed] = useState<string | null>(null);
  const editMode = draft !== null;

  const startEdit = () => { if (!editing) return; setDraft(JSON.parse(JSON.stringify(editing.layout ?? layoutFromAuto(menu))) as MenuLayout); setSel(null); setCategory(null); setSearching(false); setQuery(""); setMsg(""); };
  useEffect(() => { if (editing?.startRequest) startEdit(); }, [editing?.startRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo<{ name: string; cells: Cell[] }[] | null>(() => {
    const l = draft ?? editing?.layout;
    return l ? cellsOfLayout(l, menu) : null;
  }, [draft, editing?.layout, menu]);

  const cells = useMemo<Cell[]>(() => {
    if (query.trim()) return menu.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase())).map((item): Cell => ({ kind: "item", item }));
    if (category) return menu.filter((m) => m.category === category).map((item): Cell => ({ kind: "item", item }));
    return standardCells(menu);
  }, [menu, category, query]);
  const useLayout = !!shown && !category && !query.trim();
  const pages = useLayout ? shown!.length : pageCount(cells.length);
  const at = Math.min(page, pages - 1);
  const tiles = useLayout ? shown![at]!.cells : pageOf(cells, at);

  const goto = (i: number) => { setSel(null); setPage(Math.max(0, Math.min(pages - 1, i))); };
  const close = () => { setSearching(false); setQuery(""); };
  const tab = (label: string, on: boolean, click: () => void, key: string) => <button key={key} className={`t-pill ${on ? "on" : ""}`} onClick={click}>{label}</button>;

  // ---- editing ----
  const edit = (fn: (l: MenuLayout) => void) => setDraft((d) => { if (!d) return d; const c = JSON.parse(JSON.stringify(d)) as MenuLayout; fn(c); return c; });
  const cellAt = (i: number) => draft!.pages[at]!.cells[i] ?? null;
  const tapCell = (i: number) => {
    if (sel === null) { if (cellAt(i)) setSel(i); return; }
    if (sel === i) return setSel(null);
    edit((l) => { const cs = l.pages[at]!.cells; [cs[sel], cs[i]] = [cs[i]!, cs[sel]!]; });
    setSel(null);
  };
  const place = (c: LayoutCell) => {
    const i = draft!.pages[at]!.cells.findIndex((x) => x === null);
    if (i < 0) return setMsg("This page is full. Add a page, or remove a tile.");
    edit((l) => { l.pages[at]!.cells[i] = c; });
    setPicker(null); setPickQuery(""); setMsg("");
  };
  const removeSel = () => { if (sel === null) return; edit((l) => { l.pages[at]!.cells[sel] = null; }); setSel(null); };
  const addPage = () => { edit((l) => { if (l.pages.length < 12) l.pages.push(blankPage(`Page ${l.pages.length + 1}`)); }); if (draft && draft.pages.length < 12) setPage(draft.pages.length); };
  const dropPage = () => { if (!draft || draft.pages.length < 2) return setMsg("A layout needs at least one page."); if (!window.confirm(`Delete the page "${draft.pages[at]!.name}"?`)) return; edit((l) => { l.pages.splice(at, 1); }); setPage(Math.max(0, at - 1)); setSel(null); };
  const save = async (shop: boolean) => {
    if (!draft || !editing) return;
    const e = shop ? await editing.onSaveShop(draft) : await editing.onSaveMine(draft);
    if (e) return setMsg(e);
    setDraft(null); setSel(null); setPicker(null);
  };
  const pickList = (picker === "item" ? menu.filter((m) => m.name.toLowerCase().includes(pickQuery.trim().toLowerCase())) : []).slice(0, 40);
  const cats = [...new Set(menu.map((m) => m.category))].filter((c) => c.toLowerCase().includes(pickQuery.trim().toLowerCase()));

  return (
    <section className={`t-menu ${editMode ? "t-editing" : ""}`} aria-label="Menu">
      <div className="t-menuhead">
        <button className="t-round" aria-label="Search items" onClick={() => (searching ? close() : setSearching(true))}>⌕</button>
        {searching ? (
          <>
            <input className="t-search" autoFocus aria-label="Search items" placeholder="Search items" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
            <button className="t-round" aria-label="Close search" onClick={close}>✕</button>
          </>
        ) : (
          <div className="t-pages">
            {category ? (
              <>
                {tab("TOP MENU", false, () => { setCategory(null); setPage(0); }, "top")}
                {tab(category.toUpperCase(), true, () => undefined, "cat")}
                {pages > 1 && Array.from({ length: pages }, (_, i) => tab(String(i + 1), at === i, () => goto(i), `p${i}`))}
              </>
            ) : useLayout ? shown!.map((p, i) => tab(p.name.toUpperCase(), at === i, () => (editMode && at === i ? setNamed(p.name) : goto(i)), `p${i}`)) : Array.from({ length: pages }, (_, i) => tab(pageName(i), at === i, () => goto(i), `p${i}`))}
            {editMode && <button className="t-pill" onClick={addPage}>＋ Page</button>}
          </div>
        )}
        {editing && !editMode && !searching && !category && <button className="t-round" aria-label="Edit layout" title="Edit the menu layout" onClick={startEdit}>✎</button>}
      </div>
      {editMode && (
        <div className="t-edbar" role="toolbar" aria-label="Edit layout">
          <span className="t-banner">{sel === null ? "Tap a tile, then the cell to move it to." : "Now tap the cell to move it to (a tile there swaps)."}</span>
          <button onClick={() => { setPicker("item"); setPickQuery(""); }}>＋ Item</button>
          <button onClick={() => { setPicker("category"); setPickQuery(""); }}>＋ Category</button>
          <button onClick={() => place({ k: "discount" })}>＋ Discount</button>
          <button disabled={sel === null} onClick={removeSel}>Remove tile</button>
          <button onClick={dropPage}>Delete page</button>
        </div>
      )}
      <div
        className="t-grid"
        onPointerDown={(e) => {
          swipe.current = e.clientX;
          if (editing && !editMode && !category && !query && (e.target as HTMLElement).closest(".t-tile")) press.current = window.setTimeout(() => { press.current = null; swipe.current = null; startEdit(); }, 700);
        }}
        onPointerMove={(e) => { if (press.current && Math.abs(e.clientX - (swipe.current ?? e.clientX)) > 12) { window.clearTimeout(press.current); press.current = null; } }}
        onPointerUp={(e) => { if (press.current) { window.clearTimeout(press.current); press.current = null; } const s = swipe.current; swipe.current = null; if (s !== null && Math.abs(e.clientX - s) > 70) goto(at + (e.clientX < s ? 1 : -1)); }}
      >
        {tiles.map((c, i) => {
          if (editMode) {
            const label = !c ? "" : c.kind === "item" ? c.item.name : c.kind === "category" ? c.name : "Discount";
            return <button key={i} className={`t-tile ${c ? "" : "t-blank"} ${sel === i ? "t-sel" : ""} ${c?.kind === "category" ? "t-cat" : c?.kind === "discount" ? "t-fn" : ""}`} aria-label={c ? `Move ${label}` : "Empty cell"} onClick={() => tapCell(i)}>{c ? <strong className="t-name">{label}</strong> : <span className="t-plus">{sel !== null ? "↓" : ""}</span>}</button>;
          }
          if (!c) return <div key={i} className="t-tile t-blank" aria-hidden />;
          if (c.kind === "category") return <button key={i} className="t-tile t-cat" onClick={() => { setCategory(c.name); setPage(0); }}><strong>{c.name}</strong><span>▦</span></button>;
          if (c.kind === "discount") return <button key={i} className="t-tile t-fn" onClick={onDiscount}><strong>Discount</strong><span>%</span></button>;
          const m = c.item;
          const q = qtyOf(m.id);
          const photo = m.imageVersion ? `/api/products/${m.id}/image?v=${m.imageVersion}` : null;
          return (
            <button key={i} className={`t-tile ${photo ? "t-photo" : ""} ${q ? "t-in" : ""} ${m.soldOut ? "t-sold" : ""}`} disabled={m.soldOut} onClick={() => onAdd(m)}>
              {photo && <img src={photo} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />}
              <strong className="t-name">{m.name}</strong>
              {q > 0 && <span className="t-badge">{q}</span>}
              {m.soldOut && <span className="t-ribbon">Sold out</span>}
            </button>
          );
        })}
      </div>
      {pages > 1 && !query && !editMode && <div className="t-dots" aria-hidden>{Array.from({ length: pages }, (_, i) => <i key={i} className={i === at ? "on" : ""} />)}</div>}
      {editMode && (
        <div className="t-edfoot">
          {msg && <span className="t-err" role="alert">{msg}</span>}
          <button className="t-ghost" onClick={() => { setDraft(null); setSel(null); setPicker(null); }}>Cancel</button>
          {editing?.hasOwn && <button className="t-ghost" onClick={async () => { const e = await editing.onResetMine(); if (e) setMsg(e); else { setDraft(null); } }}>Use the shop's layout</button>}
          {editing?.canEditShop && <button className="t-ghost" onClick={() => void save(true)}>Save for everyone</button>}
          <button className="t-primary" onClick={() => void save(false)}>Done (my layout)</button>
        </div>
      )}
      {picker && (
        <div className="t-picker" role="dialog" aria-label={picker === "item" ? "Add an item" : "Add a category"}>
          <div className="t-pickhead"><input autoFocus placeholder={picker === "item" ? "Search items" : "Search categories"} value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} /><button className="t-ghost" onClick={() => setPicker(null)}>Close</button></div>
          <div className="t-picklist">
            {picker === "item" ? pickList.map((m) => <button key={m.id} onClick={() => place({ k: "item", id: m.id })}>{m.name}<small>{m.category}</small></button>) : cats.map((c) => <button key={c} onClick={() => place({ k: "category", name: c })}>{c}</button>)}
          </div>
        </div>
      )}
      {named !== null && (
        <div className="t-picker" role="dialog" aria-label="Rename page">
          <div className="t-pickhead"><input autoFocus maxLength={24} value={named} onChange={(e) => setNamed(e.target.value)} aria-label="Page name" /><button className="t-primary" disabled={!named.trim()} onClick={() => { edit((l) => { l.pages[at]!.name = named.trim(); }); setNamed(null); }}>Rename</button><button className="t-ghost" onClick={() => setNamed(null)}>Cancel</button></div>
        </div>
      )}
    </section>
  );
}
export const TILES_PER_PAGE = PAGE;
