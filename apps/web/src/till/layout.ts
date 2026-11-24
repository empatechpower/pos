import type { MenuEntry } from "@pos/core";

/** The menu is pages of 5 x 5 cells. A cell is an item, a category (tap to open it) or the discount shortcut. */
export const PAGE = 25;
export type Cell = { kind: "item"; item: MenuEntry } | { kind: "category"; name: string } | { kind: "discount" } | null;

/** A layout as it is stored: named pages of exactly 25 cells (a shop's standard one, or a person's own). */
export type LayoutCell = { k: "item"; id: string } | { k: "category"; name: string } | { k: "discount" } | null;
export interface MenuLayout { pages: Array<{ name: string; cells: LayoutCell[] }> }

/** The standard layout: every category as a cell, the discount shortcut, then every item, flowing over pages. */
export function standardCells(menu: MenuEntry[]): Cell[] {
  const cats = [...new Set(menu.map((m) => m.category))];
  return [...cats.map((name): Cell => ({ kind: "category", name })), { kind: "discount" }, ...menu.map((item): Cell => ({ kind: "item", item }))];
}
export const pageCount = (n: number) => Math.max(1, Math.ceil(n / PAGE));
export const pageOf = (cells: Cell[], i: number): Cell[] => {
  const out = cells.slice(i * PAGE, i * PAGE + PAGE);
  while (out.length < PAGE) out.push(null);
  return out;
};
export const pageName = (i: number) => (i === 0 ? "TOP MENU" : `Page ${i + 1}`);

const blank = (): LayoutCell[] => Array<LayoutCell>(PAGE).fill(null);
export const blankPage = (name: string): MenuLayout["pages"][number] => ({ name, cells: blank() });

/** The automatic layout written out as a layout, so it can be edited and saved. */
export function layoutFromAuto(menu: MenuEntry[]): MenuLayout {
  const cells = standardCells(menu).map((c): LayoutCell => (c === null ? null : c.kind === "item" ? { k: "item", id: c.item.id } : c.kind === "category" ? { k: "category", name: c.name } : { k: "discount" }));
  const pages: MenuLayout["pages"] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(cells.length / PAGE)); i++) {
    const cs = cells.slice(i * PAGE, i * PAGE + PAGE);
    while (cs.length < PAGE) cs.push(null);
    pages.push({ name: pageName(i), cells: cs });
  }
  return { pages };
}

/** A stored layout turned into cells for the screen. Items no longer on the menu (removed, or not sold in this channel) show as blanks. */
export function cellsOfLayout(l: MenuLayout, menu: MenuEntry[]): { name: string; cells: Cell[] }[] {
  const byId = new Map(menu.map((m) => [m.id, m]));
  return l.pages.map((p) => ({ name: p.name, cells: p.cells.map((c): Cell => (c === null ? null : c.k === "item" ? (byId.has(c.id) ? { kind: "item", item: byId.get(c.id)! } : null) : c.k === "category" ? { kind: "category", name: c.name } : { kind: "discount" })) }));
}
