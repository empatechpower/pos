import { useSyncExternalStore } from "react";
import { staffFetch } from "../auth";
import type { MenuLayout } from "./layout";

/** The shop-wide till settings a manager arranges: action buttons, payment options, the Dashboard switch and the standard menu layout. */
export interface TillSettings {
  actions: { order: string[]; hidden: string[] };
  tenders: { order: string[]; hidden: string[] };
  dashboard: boolean;
  layout: MenuLayout | null;
}
export const DEFAULT_TILL: TillSettings = { actions: { order: [], hidden: [] }, tenders: { order: [], hidden: [] }, dashboard: true, layout: null };

/** Every action button the till knows, in its natural order. The settings screen lists these; Pay is always pinned and not one of them. */
export const ACTION_POOL: Array<{ id: string; label: string; note?: string }> = [
  { id: "cancel", label: "Cancel Order" }, { id: "hold", label: "Hold Order" }, { id: "send", label: "Send Order", note: "Shops that pay after ordering" },
  { id: "qty", label: "Quantity" }, { id: "tables", label: "Table Map", note: "Shops with table service" }, { id: "fire", label: "Fire Course", note: "Shows when a course is waiting" },
  { id: "discount", label: "Discount Order" }, { id: "dining", label: "Dining Option" }, { id: "note", label: "Order Note" }, { id: "guests", label: "Guest Count" },
  { id: "bill", label: "Guest Check", note: "Shows on an open table" }, { id: "held", label: "Held Orders" }, { id: "member", label: "Member" },
  { id: "drawer", label: "Open Cash Drawer" }, { id: "tabs", label: "Open Tabs", note: "Shops that pay after ordering" },
];
export const TENDER_POOL: Array<{ id: string; label: string }> = [{ id: "cash", label: "Cash" }, { id: "credit", label: "Member credit" }, { id: "qr", label: "PayNow QR" }];

const KEY = "pos.till";
let current: TillSettings = (() => { try { return { ...DEFAULT_TILL, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<TillSettings>) }; } catch { return DEFAULT_TILL; } })();
const listeners = new Set<() => void>();
const set = (t: TillSettings) => { current = t; try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* not kept */ } listeners.forEach((l) => l()); };

export async function loadTillSettings(): Promise<void> {
  const r = await staffFetch("/api/settings/till");
  if ("res" in r && r.res.ok) set({ ...DEFAULT_TILL, ...((await r.res.json()) as Partial<TillSettings>) });
}
export async function saveTill(patch: Partial<TillSettings>): Promise<string | null> {
  const r = await staffFetch("/api/settings/till", { method: "PUT", body: patch });
  if ("res" in r && r.res.ok) { set({ ...DEFAULT_TILL, ...((await r.res.json()) as Partial<TillSettings>) }); return null; }
  return "problem" in r ? r.problem : "That was not saved.";
}
export const useTillSettings = (): TillSettings => { useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current); return current; };
export const tillSettings = (): TillSettings => current;

/** Put things in the manager's order (anything not mentioned keeps its natural place after the ones that are) and drop the hidden ones. */
export function arrange<T extends { id: string }>(all: T[], pref: { order: string[]; hidden: string[] }): T[] {
  const rank = (id: string) => { const i = pref.order.indexOf(id); return i < 0 ? pref.order.length + all.findIndex((x) => x.id === id) : i; };
  return all.filter((x) => !pref.hidden.includes(x.id)).sort((a, b) => rank(a.id) - rank(b.id));
}
/** The list as the settings screen shows it: every item (hidden ones too) in the current order. */
export function arrangeAll<T extends { id: string }>(all: T[], pref: { order: string[]; hidden: string[] }): T[] {
  return arrange(all, { order: pref.order, hidden: [] });
}
