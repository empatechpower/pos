import { useMemo, useRef, useState } from "react";
import type { MenuEntry } from "@pos/core";
import { PAGE, pageCount, pageName, pageOf, standardCells, type Cell } from "./layout";

/**
 * The menu area: a magnifier and a sliding strip of page tabs on one line, then a 5 x 5 page of tiles. Swipe sideways to change page.
 * A tile shows the item's name (one line) and, once it is on the order, how many. Categories open into their own pages.
 */
export function TillMenu({ menu, qtyOf, onAdd, onDiscount }: { menu: MenuEntry[]; qtyOf: (id: string) => number; onAdd: (m: MenuEntry) => void; onDiscount: () => void }) {
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const swipe = useRef<number | null>(null);

  const cells = useMemo<Cell[]>(() => {
    if (query.trim()) return menu.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase())).map((item): Cell => ({ kind: "item", item }));
    if (category) return menu.filter((m) => m.category === category).map((item): Cell => ({ kind: "item", item }));
    return standardCells(menu);
  }, [menu, category, query]);
  const pages = pageCount(cells.length);
  const at = Math.min(page, pages - 1);
  const tiles = pageOf(cells, at);

  const goto = (i: number) => setPage(Math.max(0, Math.min(pages - 1, i)));
  const close = () => { setSearching(false); setQuery(""); };

  const tab = (label: string, on: boolean, click: () => void, key: string) => <button key={key} className={`t-pill ${on ? "on" : ""}`} onClick={click}>{label}</button>;

  return (
    <section className="t-menu" aria-label="Menu">
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
            ) : Array.from({ length: pages }, (_, i) => tab(pageName(i), at === i, () => goto(i), `p${i}`))}
          </div>
        )}
      </div>
      <div
        className="t-grid"
        onPointerDown={(e) => { swipe.current = e.clientX; }}
        onPointerUp={(e) => { const s = swipe.current; swipe.current = null; if (s !== null && Math.abs(e.clientX - s) > 70) goto(at + (e.clientX < s ? 1 : -1)); }}
      >
        {tiles.map((c, i) => {
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
      {pages > 1 && !query && <div className="t-dots" aria-hidden>{Array.from({ length: pages }, (_, i) => <i key={i} className={i === at ? "on" : ""} />)}</div>}
    </section>
  );
}
export const TILES_PER_PAGE = PAGE;
