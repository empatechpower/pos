import { useSyncExternalStore } from "react";
import { RECORDED_TENDERS } from "@pos/core";
import { staffFetch } from "../auth";
import type { MenuLayout } from "./layout";

/** The shop-wide till settings a manager arranges: action buttons, payment options, the Dashboard switch and the standard menu layout. */
export interface TillSettings {
  actions: { order: string[]; hidden: string[] };
  tenders: { order: string[]; hidden: string[]; shown?: string[] };
  dashboard: boolean;
  /** How a ticket line is removed by sliding it: show a bin button to tap, or remove it at once. */
  lineRemove: "bin" | "swipe";
  layout: MenuLayout | null;
  /** Kitchen stations: each makes the items of its categories. */
  stations?: KitchenStation[];
  /** The shop's own ways to pay (a delivery platform, a gift certificate): recorded only. */
  customTenders?: CustomTender[];
  /** The shop's own buttons: a name, a colour, an icon and a web address to open. */
  customActions?: CustomAction[];
  /** This till's own action and payment lists, when it has any (per station). Missing or null: it uses the shop's. */
  thisTill?: { actions?: ArrangePref; tenders?: ArrangePref } | null;
}
/** The lists this till actually uses: its own when it has them, else the shop's. */
export const actionsPref = (t: TillSettings): ArrangePref => t.thisTill?.actions ?? t.actions;
export const tendersPref = (t: TillSettings): ArrangePref => t.thisTill?.tenders ?? t.tenders;
export interface CustomTender { id: string; name: string }
export interface CustomAction { id: string; label: string; icon: string; color: string; url: string; where: "strip" | "dashboard" | "both" }
/** Open a custom button's web address in a new tab. Only web addresses open; the new page cannot reach back into the till. */
export function openCustomAction(a: CustomAction): void { if (/^https?:\/\//i.test(a.url)) window.open(a.url, "_blank", "noopener,noreferrer"); }
export interface KitchenStation { id: string; name: string; categories: string[] }
export const DEFAULT_TILL: TillSettings = { actions: { order: [], hidden: [] }, tenders: { order: [], hidden: [], shown: [] }, dashboard: true, lineRemove: "bin", layout: null };

/** Every action button the till knows, in its natural order. The settings screen lists these; Pay is always pinned and not one of them. */
export const ACTION_POOL: Array<{ id: string; label: string; note?: string }> = [
  { id: "cancel", label: "Cancel Order" }, { id: "hold", label: "Hold Order" }, { id: "send", label: "Send Order", note: "Shops that pay after ordering" },
  { id: "qty", label: "Quantity" }, { id: "tables", label: "Table Map", note: "Shops with table service" }, { id: "fire", label: "Fire Course", note: "Shows when a course is waiting" },
  { id: "discount", label: "Discount Order" }, { id: "tax", label: "Add/Remove Tax", note: "Only where the country's tax rules allow it" }, { id: "fee", label: "Service Fee" }, { id: "extra", label: "Add Extra Item", note: "Managers" }, { id: "dining", label: "Dining Option" }, { id: "note", label: "Order Note" }, { id: "guests", label: "Guest Count" },
  { id: "bill", label: "Guest Check", note: "Shows on an open table" }, { id: "held", label: "Held Orders" }, { id: "member", label: "Loyalty" }, { id: "barcode", label: "Enter Barcode" }, { id: "coupon", label: "Scan Coupon" }, { id: "invoice", label: "Print Invoice" }, { id: "handover", label: "Hand Over", note: "Riders and collections" }, { id: "giftcards", label: "Gift Cards", note: "Sell a card or check its balance" },
  { id: "drawer", label: "Open Cash Drawer" }, { id: "tabs", label: "Open Tabs", note: "Shops that pay after ordering" },
];
export const TENDER_POOL: Array<{ id: string; label: string; note?: string; optional?: boolean }> = [
  { id: "cash", label: "Cash" }, { id: "credit", label: "Member credit" }, { id: "qr", label: "PayNow QR" },
  // Recorded tenders: the money is taken elsewhere (a card terminal, a cheque) and the cashier confirms it.
  ...RECORDED_TENDERS.map((t) => ({ id: t.id, label: t.label, note: "Recorded only: taken outside the till", ...(t.optional ? { optional: true } : {}) })),
];

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
export type ArrangePref = { order: string[]; hidden: string[]; /** Optional items a manager switched on (they stay off until then). */ shown?: string[] };
/** Whether an item is left off: hidden by a manager, or optional and never switched on. */
export const isHidden = (x: { id: string; optional?: boolean }, pref: ArrangePref): boolean => pref.hidden.includes(x.id) || (!!x.optional && !(pref.shown ?? []).includes(x.id));
export function arrange<T extends { id: string; optional?: boolean }>(all: T[], pref: ArrangePref): T[] {
  const rank = (id: string) => { const i = pref.order.indexOf(id); return i < 0 ? pref.order.length + all.findIndex((x) => x.id === id) : i; };
  return all.filter((x) => !isHidden(x, pref)).sort((a, b) => rank(a.id) - rank(b.id));
}
/** The list as the settings screen shows it: every item (hidden ones too) in the current order. */
export function arrangeAll<T extends { id: string }>(all: T[], pref: ArrangePref): T[] {
  return arrange(all.map((x) => ({ ...x, optional: false })), { order: pref.order, hidden: [] }).map((x) => all.find((y) => y.id === x.id)!);
}
