import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";

/**
 * The shop floor: sections with their tables, and the switches for table service.
 * Tables are just names; whatever order is sitting at a name is that table's open bill.
 */
/** Where a table sits on the floor map: x and y are percentages of the canvas; the shape is how it is drawn. */
export interface FloorTable { id: string; name: string; seats?: number; shape?: "rect" | "round" | "oval"; x?: number; y?: number }

export interface FloorSettings {
  sections: Array<{ id: string; name: string; tables: Array<FloorTable> }>;
  splitBill: boolean;
  courses: boolean;
  /** Minutes before a seated table, or one with nothing sent, is flagged as overdue. */
  overdueMinutes: number;
}

export const DEFAULT_FLOOR: FloorSettings = {
  sections: [
    { id: "main", name: "Main floor", tables: Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, name: `Table ${i + 1}`, seats: 4 })) },
    { id: "bar", name: "Bar", tables: Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, name: `Bar ${i + 1}`, seats: 2 })) },
  ],
  splitBill: true,
  courses: true,
  overdueMinutes: 45,
};

export async function loadFloor(db: Db, merchantId: string): Promise<FloorSettings> {
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='floor'", [merchantId]);
  const v = (r.rows[0]?.value ?? {}) as Partial<FloorSettings>;
  return { ...DEFAULT_FLOOR, ...v, sections: Array.isArray(v.sections) && v.sections.length ? v.sections : DEFAULT_FLOOR.sections };
}

/** Clean what a manager sends: names trimmed, duplicates and blanks dropped, sizes limited. */
export function cleanFloor(b: Partial<FloorSettings>, cur: FloorSettings): FloorSettings | null {
  const seen = new Set<string>();
  let sections = cur.sections;
  if (b.sections !== undefined) {
    if (!Array.isArray(b.sections) || b.sections.length < 1 || b.sections.length > 12) return null;
    sections = [];
    for (const [si, s] of b.sections.entries()) {
      const name = String(s?.name ?? "").trim().slice(0, 30);
      if (!name || !Array.isArray(s.tables) || s.tables.length > 80) return null;
      const tables: FloorSettings["sections"][number]["tables"] = [];
      for (const [ti, t] of s.tables.entries()) {
        const tn = String(t?.name ?? "").trim().slice(0, 24);
        if (!tn) continue;
        if (seen.has(tn.toLowerCase())) return null;
        seen.add(tn.toLowerCase());
        const seats = Number(t.seats);
        const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(92, Math.max(0, v)) * 10) / 10 : undefined);
        const x = pct(t.x), y = pct(t.y);
        tables.push({ id: String(t.id ?? `t${si}-${ti}`).slice(0, 24), name: tn, ...(Number.isInteger(seats) && seats > 0 && seats <= 40 ? { seats } : {}), ...(t.shape === "rect" || t.shape === "round" || t.shape === "oval" ? { shape: t.shape } : {}), ...(x !== undefined && y !== undefined ? { x, y } : {}) });
      }
      sections.push({ id: String(s.id ?? `s${si}`).slice(0, 24), name, tables });
    }
  }
  const overdue = b.overdueMinutes === undefined ? cur.overdueMinutes : Number(b.overdueMinutes);
  if (!Number.isInteger(overdue) || overdue < 5 || overdue > 600) return null;
  return { sections, splitBill: b.splitBill === undefined ? cur.splitBill : !!b.splitBill, courses: b.courses === undefined ? cur.courses : !!b.courses, overdueMinutes: overdue };
}

export function registerFloor(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, needs } = d;
  app.get("/api/settings/floor", { preHandler: needs("wallet.read") }, async () => loadFloor(db, merchantId));
  app.put<{ Body: Partial<FloorSettings> }>("/api/settings/floor", { preHandler: needs("device.manage") }, async (req, reply) => {
    const next = cleanFloor(req.body ?? {}, await loadFloor(db, merchantId));
    if (!next) return reply.code(400).send({ error: "floor_not_allowed" });
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'floor',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(next)]);
    await audit(db, merchantId, req.staff!.id, "settings.floor", { sections: next.sections.length, tables: next.sections.reduce((n, s) => n + s.tables.length, 0) });
    return next;
  });
}
