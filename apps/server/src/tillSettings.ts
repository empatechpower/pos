import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";

/**
 * How the till looks and behaves for the whole shop (TengSern's Q4/Q12/Q16/Q18): which action buttons show and in what order, which ways to pay
 * show and in what order, whether sign-in lands on the Dashboard, and the shop's standard menu layout. A person's own layout is kept with their
 * preferences and wins over the shop's.
 */
/** "fn" is an order action placed on the menu grid: cancel, hold or send the order. */
export type LayoutCell = { k: "item"; id: string } | { k: "category"; name: string } | { k: "discount" } | { k: "fn"; id: "cancel" | "hold" | "send" } | null;
export interface MenuLayout { pages: Array<{ name: string; cells: LayoutCell[] }> }
export interface TillSettings {
  actions: { order: string[]; hidden: string[] };
  tenders: { order: string[]; hidden: string[]; /** Optional tenders (debit, check, gift card...) a manager switched on. */ shown?: string[] };
  dashboard: boolean;
  /** How a ticket line is removed by sliding it: show a bin button to tap, or remove it at once. */
  lineRemove: "bin" | "swipe";
  layout: MenuLayout | null;
  /** Kitchen stations (hot kitchen, bar...): each makes the items of its categories. The kitchen display can show one station's work. */
  stations?: KitchenStation[];
  /** The shop's own ways to pay (a delivery platform, a gift certificate): recorded only, like Card. */
  customTenders?: CustomTender[];
  /** The shop's own buttons (handout 4.11): a name, a colour, an icon and a web address to open; on the action strip, the dashboard, or both. */
  customActions?: CustomAction[];
  /** One till's own lists (handout 4.11: per station), by device id. A till without an entry uses the shop's. */
  devices?: Record<string, TillOwnLists>;
}
export interface TillOwnLists { actions?: { order: string[]; hidden: string[] }; tenders?: { order: string[]; hidden: string[]; shown?: string[] } }
export interface CustomTender { id: string; name: string }
export interface CustomAction { id: string; label: string; icon: string; color: string; url: string; where: "strip" | "dashboard" | "both" }

const plain = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
/** Up to 12 custom tenders: an id (ct-...) and a name. Null when the shape is wrong or two share a name. */
export function cleanCustomTenders(v: unknown): CustomTender[] | null {
  if (!Array.isArray(v) || v.length > 12) return null;
  const out: CustomTender[] = [];
  for (const x of v as Array<Partial<CustomTender>>) {
    const name = plain(x?.name, 30);
    if (typeof x?.id !== "string" || !/^ct-[a-z0-9]{1,20}$/.test(x.id) || !name || out.some((o) => o.id === x.id || o.name.toLowerCase() === name.toLowerCase())) return null;
    out.push({ id: x.id, name });
  }
  return out;
}
/** Up to 12 custom buttons. The address must be a web address (http or https); nothing else can be opened from the till. */
export function cleanCustomActions(v: unknown): CustomAction[] | null {
  if (!Array.isArray(v) || v.length > 12) return null;
  const out: CustomAction[] = [];
  for (const x of v as Array<Partial<CustomAction>>) {
    const label = plain(x?.label, 24), icon = [...plain(x?.icon, 8)].slice(0, 2).join("") || "↗";
    let url: URL | null = null;
    try { url = new URL(String(x?.url ?? "")); } catch { url = null; }
    if (typeof x?.id !== "string" || !/^ca-[a-z0-9]{1,20}$/.test(x.id) || !label || !url || (url.protocol !== "https:" && url.protocol !== "http:") || url.href.length > 500 || out.some((o) => o.id === x.id)) return null;
    out.push({ id: x.id, label, icon, color: typeof x.color === "string" && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color.toLowerCase() : "#1b9bd8", url: url.href, where: x.where === "dashboard" || x.where === "both" ? x.where : "strip" });
  }
  return out;
}
export interface KitchenStation { id: string; name: string; categories: string[] }
export const PAGE_CELLS = 25;

/** Up to 8 stations, each a name and the menu categories it makes. Null when the shape is wrong. */
export function cleanStations(v: unknown): KitchenStation[] | null {
  if (!Array.isArray(v) || v.length > 8) return null;
  const out: KitchenStation[] = [];
  for (const x of v as Array<Partial<KitchenStation>>) {
    const id = typeof x?.id === "string" && /^[a-z0-9_-]{1,30}$/i.test(x.id) ? x.id : null;
    const name = typeof x?.name === "string" ? x.name.trim().slice(0, 30) : "";
    if (!id || !name || out.some((o) => o.id === id) || !Array.isArray(x.categories) || x.categories.length > 80 || !x.categories.every((c) => typeof c === "string" && c.length > 0 && c.length <= 60)) return null;
    out.push({ id, name, categories: [...new Set(x.categories)] });
  }
  return out;
}
export const DEFAULT_TILL: TillSettings = { actions: { order: [], hidden: [] }, tenders: { order: [], hidden: [] }, dashboard: true, lineRemove: "bin", layout: null };

const ids = (v: unknown, max = 40): string[] | null => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && /^[a-z0-9_-]{1,30}$/i.test(x)) ? [...new Set(v as string[])] : null);

/** A layout from a person or a manager: at most 12 pages of exactly 25 cells, with plain names and ids. Null when it is not usable. */
export function cleanLayout(v: unknown): MenuLayout | null {
  const pages = (v as MenuLayout | null)?.pages;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 12) return null;
  const out: MenuLayout["pages"] = [];
  for (const p of pages) {
    const name = String(p?.name ?? "").trim().slice(0, 24);
    if (!name || !Array.isArray(p.cells) || p.cells.length !== PAGE_CELLS) return null;
    const cells: LayoutCell[] = [];
    for (const c of p.cells as Array<Record<string, unknown> | null>) {
      if (c === null) cells.push(null);
      else if (c.k === "item" && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 80) cells.push({ k: "item", id: c.id });
      else if (c.k === "category" && typeof c.name === "string" && c.name.trim() && c.name.length <= 60) cells.push({ k: "category", name: c.name });
      else if (c.k === "discount") cells.push({ k: "discount" });
      else if (c.k === "fn" && (c.id === "cancel" || c.id === "hold" || c.id === "send")) cells.push({ k: "fn", id: c.id });
      else return null;
    }
    out.push({ name, cells });
  }
  return { pages: out };
}

/** One till's own action and payment lists. Null when the shape is wrong. Either list may be left out (that one then follows the shop). */
export function cleanOwnLists(v: unknown): TillOwnLists | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { actions?: { order?: unknown; hidden?: unknown }; tenders?: { order?: unknown; hidden?: unknown; shown?: unknown } };
  const out: TillOwnLists = {};
  if (o.actions !== undefined) { const order = ids(o.actions?.order, 60), hidden = ids(o.actions?.hidden, 60); if (!order || !hidden) return null; out.actions = { order, hidden }; }
  if (o.tenders !== undefined) { const order = ids(o.tenders?.order, 30), hidden = ids(o.tenders?.hidden, 30), shown = ids(o.tenders?.shown ?? [], 30); if (!order || !hidden || !shown) return null; out.tenders = { order, hidden, shown }; }
  return out;
}
const cleanDevices = (v: unknown): Record<string, TillOwnLists> => {
  const out: Record<string, TillOwnLists> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) { const c = /^[A-Za-z0-9-]{1,64}$/.test(k) ? cleanOwnLists(x) : null; if (c && (c.actions || c.tenders)) out[k] = c; }
  return out;
};

export async function loadTill(db: Db, merchantId: string): Promise<TillSettings> {
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='till'", [merchantId]);
  const v = (r.rows[0]?.value ?? {}) as Partial<TillSettings>;
  return {
    actions: { order: ids(v.actions?.order) ?? [], hidden: ids(v.actions?.hidden) ?? [] },
    tenders: { order: ids(v.tenders?.order, 30) ?? [], hidden: ids(v.tenders?.hidden, 30) ?? [], shown: ids((v.tenders as { shown?: unknown } | undefined)?.shown, 30) ?? [] },
    dashboard: v.dashboard !== false,
    lineRemove: v.lineRemove === "swipe" ? "swipe" : "bin",
    layout: v.layout ? cleanLayout(v.layout) : null,
    stations: cleanStations(v.stations ?? []) ?? [],
    devices: cleanDevices(v.devices),
    customTenders: cleanCustomTenders(v.customTenders ?? []) ?? [],
    customActions: cleanCustomActions(v.customActions ?? []) ?? [],
  };
}

/** What a manager sent, merged over what is there. Null when something in it is not allowed. */
export function mergeTill(cur: TillSettings, b: Partial<Record<keyof TillSettings, unknown>>): TillSettings | null {
  const next = { ...cur };
  const part = (v: unknown, max: number) => { const o = (v ?? {}) as { order?: unknown; hidden?: unknown }; const order = ids(o.order, max), hidden = ids(o.hidden, max); return order && hidden ? { order, hidden } : null; };
  if (b.actions !== undefined) { const a = part(b.actions, 40); if (!a) return null; next.actions = a; }
  if (b.tenders !== undefined) { const t = part(b.tenders, 30); if (!t) return null; const shown = ids((b.tenders as { shown?: unknown }).shown ?? [], 30); if (!shown) return null; next.tenders = { ...t, shown }; }
  if (b.dashboard !== undefined) next.dashboard = !!b.dashboard;
  if (b.lineRemove !== undefined) { if (b.lineRemove !== "bin" && b.lineRemove !== "swipe") return null; next.lineRemove = b.lineRemove; }
  if (b.customTenders !== undefined) { const ct = cleanCustomTenders(b.customTenders); if (!ct) return null; next.customTenders = ct; }
  if (b.customActions !== undefined) { const ca = cleanCustomActions(b.customActions); if (!ca) return null; next.customActions = ca; }
  if (b.stations !== undefined) { const st = cleanStations(b.stations); if (!st) return null; next.stations = st; }
  if (b.layout !== undefined) { if (b.layout === null) next.layout = null; else { const l = cleanLayout(b.layout); if (!l) return null; next.layout = l; } }
  return next;
}

export function registerTill(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, needs } = d;
  /** What a till is sent: the shop's settings, and its own lists when it has any (`thisTill`). Other tills' lists are not sent. */
  const viewFor = (t: TillSettings, deviceId: string | undefined) => { const { devices, ...rest } = t; return { ...rest, thisTill: (deviceId && devices?.[deviceId]) || null }; };
  app.get("/api/settings/till", { preHandler: needs("wallet.read") }, async (req) => viewFor(await loadTill(db, merchantId), req.device?.id));
  app.put<{ Body: Record<string, unknown> }>("/api/settings/till", { preHandler: needs("device.manage") }, async (req, reply) => {
    const next = mergeTill(await loadTill(db, merchantId), req.body ?? {});
    if (!next) return reply.code(400).send({ error: "till_settings_not_allowed" });
    // `thisTill` changes only the lists of the till the request came from: an object sets them, null goes back to the shop's.
    const own = (req.body ?? {}).thisTill;
    if (own !== undefined) {
      if (!req.device?.id) return reply.code(400).send({ error: "not_a_till" });
      const devices = { ...(next.devices ?? {}) };
      if (own === null) delete devices[req.device.id];
      else { const c = cleanOwnLists(own); if (!c) return reply.code(400).send({ error: "till_settings_not_allowed" }); if (c.actions || c.tenders) devices[req.device.id] = c; else delete devices[req.device.id]; }
      next.devices = devices;
    }
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'till',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(next)]);
    await audit(db, merchantId, req.staff!.id, "settings.till", { keys: Object.keys(req.body ?? {}), ...(own !== undefined ? { deviceId: req.device?.id } : {}) });
    return viewFor(next, req.device?.id);
  });
}
