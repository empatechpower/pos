import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";

/**
 * How the till looks and behaves for the whole shop (TengSern's Q4/Q12/Q16/Q18): which action buttons show and in what order, which ways to pay
 * show and in what order, whether sign-in lands on the Dashboard, and the shop's standard menu layout. A person's own layout is kept with their
 * preferences and wins over the shop's.
 */
export type LayoutCell = { k: "item"; id: string } | { k: "category"; name: string } | { k: "discount" } | null;
export interface MenuLayout { pages: Array<{ name: string; cells: LayoutCell[] }> }
export interface TillSettings {
  actions: { order: string[]; hidden: string[] };
  tenders: { order: string[]; hidden: string[] };
  dashboard: boolean;
  layout: MenuLayout | null;
}
export const PAGE_CELLS = 25;
export const DEFAULT_TILL: TillSettings = { actions: { order: [], hidden: [] }, tenders: { order: [], hidden: [] }, dashboard: true, layout: null };

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
      else return null;
    }
    out.push({ name, cells });
  }
  return { pages: out };
}

export async function loadTill(db: Db, merchantId: string): Promise<TillSettings> {
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='till'", [merchantId]);
  const v = (r.rows[0]?.value ?? {}) as Partial<TillSettings>;
  return {
    actions: { order: ids(v.actions?.order) ?? [], hidden: ids(v.actions?.hidden) ?? [] },
    tenders: { order: ids(v.tenders?.order, 12) ?? [], hidden: ids(v.tenders?.hidden, 12) ?? [] },
    dashboard: v.dashboard !== false,
    layout: v.layout ? cleanLayout(v.layout) : null,
  };
}

/** What a manager sent, merged over what is there. Null when something in it is not allowed. */
export function mergeTill(cur: TillSettings, b: Partial<Record<keyof TillSettings, unknown>>): TillSettings | null {
  const next = { ...cur };
  const part = (v: unknown, max: number) => { const o = (v ?? {}) as { order?: unknown; hidden?: unknown }; const order = ids(o.order, max), hidden = ids(o.hidden, max); return order && hidden ? { order, hidden } : null; };
  if (b.actions !== undefined) { const a = part(b.actions, 40); if (!a) return null; next.actions = a; }
  if (b.tenders !== undefined) { const t = part(b.tenders, 12); if (!t) return null; next.tenders = t; }
  if (b.dashboard !== undefined) next.dashboard = !!b.dashboard;
  if (b.layout !== undefined) { if (b.layout === null) next.layout = null; else { const l = cleanLayout(b.layout); if (!l) return null; next.layout = l; } }
  return next;
}

export function registerTill(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, needs } = d;
  app.get("/api/settings/till", { preHandler: needs("wallet.read") }, async () => loadTill(db, merchantId));
  app.put<{ Body: Record<string, unknown> }>("/api/settings/till", { preHandler: needs("device.manage") }, async (req, reply) => {
    const next = mergeTill(await loadTill(db, merchantId), req.body ?? {});
    if (!next) return reply.code(400).send({ error: "till_settings_not_allowed" });
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'till',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(next)]);
    await audit(db, merchantId, req.staff!.id, "settings.till", { keys: Object.keys(req.body ?? {}) });
    return next;
  });
}
