import type { MenuEntry } from "@pos/core";

/** The menu is pages of 5 x 5 cells. A cell is an item, a category (tap to open it) or the discount shortcut. */
export const PAGE = 25;
export type Cell = { kind: "item"; item: MenuEntry } | { kind: "category"; name: string } | { kind: "discount" } | null;

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
