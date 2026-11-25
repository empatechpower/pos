import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MenuEntry } from "@pos/core";
import { ProtoDialog } from "../proto/ProtoDialog";
import { FN_TILES, type FnId } from "./layout";
import { PAGE, blankPage, cellsOfLayout, layoutFromAuto, pageCount, pageName, pageOf, standardCells, type Cell, type LayoutCell, type MenuLayout } from "./layout";

export interface LayoutEditing {
  /** The layout in force (the person's own, else the shop's), or null for the automatic one. */
  layout: MenuLayout | null;
  hasOwn: boolean;
  canEditShop: boolean;
  onSaveMine: (l: MenuLayout) => Promise<string | null>;
  onSaveShop: (l: MenuLayout) => Promise<string | null>;
  onResetMine: () => Promise<string | null>;
  /** Managers can manage an item (description, sold out, photo, price) from the till: when set, a long press on an item offers it. */
  onManageItem?: (m: MenuEntry) => void;
  /** Set true from outside (the till's settings) to start editing. */
  startRequest: number;
}

/**
 * The menu area: a magnifier and a sliding strip of page tabs on one line, then a 5 x 5 page of tiles. Swipe sideways to change page.
 * A tile shows the item's name (one line) and, once it is on the order, how many. Categories open into their own pages.
 * Press and hold a tile (or use the pencil) to edit the layout: tap a tile, then a cell, to move it; add items, categories or the Discount tile;
 * name and add pages. It is saved as the person's own layout, or, for a manager, as the shop's standard one.
 */
export function TillMenu({ menu, qtyOf, onAdd, onDiscount, onFn, editing }: { menu: MenuEntry[]; qtyOf: (id: string) => number; onAdd: (m: MenuEntry) => void; onDiscount: () => void; /** Cancel, Hold or Send placed on the grid as a tile. */ onFn?: (id: FnId) => void; editing?: LayoutEditing }) {
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const swipe = useRef<number | null>(null);
  const press = useRef<number | null>(null);
  /** A long press must not also count as a tap on the tile when the finger lifts. */
  const held = useRef(0);
  const unlessHeld = (fn: () => void) => () => { if (Date.now() < held.current) return; fn(); };
  const [draft, setDraft] = useState<MenuLayout | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [picker, setPicker] = useState<null | "item" | "category">(null);
  /** The empty cell that was tapped, so the chosen tile lands there. */
  const [placeAt, setPlaceAt] = useState<number | null>(null);
  const [pickQuery, setPickQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [named, setNamed] = useState<string | null>(null);
  /** A long press on an item asks what to do (managers): manage the item, or edit the layout. */
  const [choice, setChoice] = useState<MenuEntry | null>(null);
  const editMode = draft !== null;
  // As in the prototype: while editing, the app carries "edit" (dashed tiles) and the instructions sit over the top of the ticket.
  const [bill, setBill] = useState<Element | null>(null);
  useEffect(() => {
    const app = document.querySelector(".proto .app");
    setBill(editMode ? document.querySelector(".proto .bill") : null);
    app?.classList.toggle("edit", editMode);
    return () => { app?.classList.remove("edit"); };
  }, [editMode]);

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
    const free = draft!.pages[at]!.cells.findIndex((x) => x === null);
    const i = placeAt !== null && draft!.pages[at]!.cells[placeAt] === null ? placeAt : free;
    if (i < 0) return setMsg("This page is full. Add a page, or remove a tile.");
    edit((l) => { l.pages[at]!.cells[i] = c; });
    setPicker(null); setPickQuery(""); setMsg(""); setPlaceAt(null);
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

  // The markup and class names are the prototype's own (proto-reference/index.html: render, tabsHTML, tileHTML), styled by its stylesheet.
  const tab = (label: string, on: boolean, click: () => void, key: string) => <button key={key} className={on ? "selected" : ""} onClick={click}>{label}</button>;
  return (
    <section className="catalog" id="catalog" aria-label="Menu">
      <div className="menuheading pagetabs">
        <button className="searchbtn" aria-label="Search items" onClick={() => (searching ? close() : setSearching(true))}>⌕</button>
        {searching ? (
          <>
            <input id="search" className="menusearch open" autoFocus aria-label="Search items" placeholder="Search items" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
            <button className="searchx" aria-label="Close search" onClick={close}>✕</button>
          </>
        ) : (
          <div className="pageslider">
            {category ? (
              <>
                {tab("TOP MENU", false, () => { setCategory(null); setPage(0); }, "top")}
                {tab(category.toUpperCase(), true, () => undefined, "cat")}
                {pages > 1 && Array.from({ length: pages }, (_, i) => tab(String(i + 1), at === i, () => goto(i), `p${i}`))}
              </>
            ) : useLayout ? shown!.map((p, i) => tab(`${p.name}${editMode && at === i ? " ✎" : ""}`, at === i, () => (editMode && at === i ? setNamed(p.name) : goto(i)), `p${i}`)) : Array.from({ length: pages }, (_, i) => tab(pageName(i), at === i, () => goto(i), `p${i}`))}
            {editMode && <button onClick={addPage}>+ Page</button>}
          </div>
        )}
      </div>
      {editMode && bill && createPortal(
        <div className="editnote editnote-ticket" role="toolbar" aria-label="Edit layout">
          <div><strong>Item layout setup</strong><br />{sel === null ? "Tap a tile, then the cell to move it to · Tap the × to remove a tile · Tap an empty cell to add one" : "Now tap the cell to move it to (a tile there swaps)."}<br />{editing?.canEditShop ? "Done saves your personal layout · Save for everyone sets the shop's standard" : "Editing your personal layout"}{msg && <><br /><span role="alert">{msg}</span></>}
            <div className="editacts">
              <button onClick={dropPage}>Delete page</button>
              <button onClick={() => { setDraft(null); setSel(null); setPicker(null); }}>Cancel</button>
              {editing?.hasOwn && <button onClick={async () => { const e = await editing.onResetMine(); if (e) setMsg(e); else { setDraft(null); } }}>Use the shop's layout</button>}
              {editing?.canEditShop && <button onClick={() => void save(true)}>Save for everyone</button>}
            </div>
          </div>
          <button className="primary" onClick={() => void save(false)}>Done</button>
        </div>, bill)}
      <div
        className={`grid ${editMode ? "editing" : ""}`}
        id="grid"
        onPointerDown={(e) => {
          swipe.current = e.clientX;
          const tile = (e.target as HTMLElement).closest(".tile") as HTMLElement | null;
          if (editing && !editMode && tile) {
            const cell = tiles[Number(tile.dataset.i)];
            if (cell?.kind === "item" && editing.onManageItem) press.current = window.setTimeout(() => { press.current = null; swipe.current = null; held.current = Date.now() + 900; setChoice(cell.item); }, 700);
            else if (!category && !query) press.current = window.setTimeout(() => { press.current = null; swipe.current = null; held.current = Date.now() + 900; startEdit(); }, 700);
          }
        }}
        onPointerMove={(e) => { if (press.current && Math.abs(e.clientX - (swipe.current ?? e.clientX)) > 12) { window.clearTimeout(press.current); press.current = null; } }}
        onPointerUp={(e) => { if (press.current) { window.clearTimeout(press.current); press.current = null; } const s = swipe.current; swipe.current = null; if (s !== null && Math.abs(e.clientX - s) > 70) goto(at + (e.clientX < s ? 1 : -1)); }}
      >
        {tiles.map((c, i) => {
          const x = editMode && c ? <span className="tilex" role="button" aria-label="Remove this button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); edit((l) => { l.pages[at]!.cells[i] = null; }); setSel(null); }}>×</span> : null;
          const onTile = (fn: () => void) => unlessHeld(editMode ? () => tapCell(i) : fn);
          const outline = editMode && sel === i ? { boxShadow: "0 0 0 0.1875em #ffbf47" } : undefined;
          if (!c) return editMode ? <button key={i} data-i={i} className="tile blank" aria-label="Add tile to empty cell" onClick={() => (sel === null ? (setPlaceAt(i), setPicker("item"), setPickQuery("")) : tapCell(i))}>+</button> : <div key={i} className="tile spacer" aria-hidden />;
          if (c.kind === "category") return <button key={i} data-i={i} className="tile categorytile" style={outline} onClick={onTile(() => { setCategory(c.name); setPage(0); })}><strong>{c.name}</strong><span className="tdesc">▦</span><small>Category</small>{x}</button>;
          if (c.kind === "discount") return <button key={i} data-i={i} className="tile shortcut" style={outline} onClick={onTile(onDiscount)}><strong>Discount</strong><span className="tdesc">%</span><small>Discount an order</small>{x}</button>;
          if (c.kind === "fn") { const [name, icon, hint] = FN_TILES[c.id]; return <button key={i} data-i={i} className="tile shortcut" style={outline} onClick={onTile(() => onFn?.(c.id))}><strong>{name}</strong><span className="tdesc">{icon}</span><small>{hint}</small>{x}</button>; }
          const m = c.item;
          const q = editMode ? 0 : qtyOf(m.id);
          const photo = m.imageVersion ? `/api/products/${m.id}/image?v=${m.imageVersion}` : null;
          const badge = q > 0 ? <span className="qtybadge">{q}</span> : null;
          if (photo) return (
            <button key={i} data-i={i} className={`tile photo${q ? " inorder" : ""}${m.soldOut ? " soldout" : ""}`} style={outline} onClick={onTile(() => onAdd(m))}>
              <img src={photo} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />
              <span className="tilefoot"><strong>{m.name}</strong></span>
              {m.soldOut && <span className="soldribbon">Sold out</span>}{badge}{x}
            </button>
          );
          return (
            <button key={i} data-i={i} className={`tile${q ? " inorder" : ""}${m.soldOut ? " soldout" : ""}`} style={outline} onClick={onTile(() => onAdd(m))}>
              <strong>{m.name}</strong>{badge}
              <span><small>{m.options?.length ? "Options available" : m.category}</small></span>
              {m.soldOut && <span className="soldribbon">Sold out</span>}{x}
            </button>
          );
        })}
      </div>
      {picker && (
        <ProtoDialog title="Place a tile" onClose={() => { setPicker(null); setPlaceAt(null); }}>
          <div className="choices">
            <button className={picker === "item" ? "selected" : ""} onClick={() => { setPicker("item"); setPickQuery(""); }}>Item</button>
            <button className={picker === "category" ? "selected" : ""} onClick={() => { setPicker("category"); setPickQuery(""); }}>Category</button>
            <button onClick={() => place({ k: "discount" })}>Discount</button>
            {(Object.keys(FN_TILES) as FnId[]).map((id) => <button key={id} onClick={() => place({ k: "fn", id })}>{FN_TILES[id][0]}</button>)}
          </div>
          <label className="field">Search<input autoFocus placeholder={picker === "item" ? "Search items" : "Search categories"} value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} /></label>
          <div className="checklist">
            {picker === "item" ? pickList.map((m) => <button key={m.id} onClick={() => place({ k: "item", id: m.id })}>{m.name} <small>{m.category}</small></button>) : cats.map((c) => <button key={c} onClick={() => place({ k: "category", name: c })}>{c}</button>)}
          </div>
          <div className="actions"><button onClick={() => { setPicker(null); setPlaceAt(null); }}>Cancel</button></div>
        </ProtoDialog>
      )}
      {choice && (
        <ProtoDialog title="What do you want to do?" onClose={() => setChoice(null)}>
          <p className="muted" style={{ marginBottom: "0.75em" }}>{choice.name}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
            <button className="primary" onClick={() => { const m = choice; setChoice(null); editing?.onManageItem?.(m); }}>Manage item</button>
            <button onClick={() => { setChoice(null); startEdit(); }}>Edit layout</button>
            <button onClick={() => setChoice(null)}>Cancel</button>
          </div>
        </ProtoDialog>
      )}
      {named !== null && (
        <ProtoDialog title="Rename page" onClose={() => setNamed(null)}>
          <label className="field">Page name<input autoFocus maxLength={24} value={named} onChange={(e) => setNamed(e.target.value)} aria-label="Page name" /></label>
          <div className="actions"><button onClick={() => setNamed(null)}>Cancel</button><button className="primary" disabled={!named.trim()} onClick={() => { edit((l) => { l.pages[at]!.name = named.trim(); }); setNamed(null); }}>Save</button></div>
        </ProtoDialog>
      )}
    </section>
  );
}
export const TILES_PER_PAGE = PAGE;
