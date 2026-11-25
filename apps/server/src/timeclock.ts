import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db/pool.js";
import { audit, checkStaffPin, type Permission } from "./auth.js";
import { outletAllowed, visibleOutletIds } from "./tenant.js";

/**
 * Staff attendance: clocking in and out, and the timesheet.
 *
 * A punch needs an enrolled till but not a signed-in person: a card held to the reader (it types the card's number), or a staff code and
 * PIN. A card alone is enough to clock, because attendance is not money; it can never sign anyone in to sell. The same punch clocks in
 * when the person is out and out when they are in. Two punches within a minute count as one, so a double tap does not undo itself.
 */
export type PunchMethod = "card" | "pin" | "telegram" | "manager";
export interface Punch { staffId: string; name: string; action: "in" | "out"; at: number; /** Minutes worked in the spell just closed. */ workedMinutes?: number; /** A second punch came too soon: nothing changed. */ repeated?: boolean }
const DOUBLE_TAP_MS = 60_000;
/** A spell left open this long was almost certainly a forgotten clock-out; the timesheet flags it instead of counting it. */
export const FORGOTTEN_HOURS = 16;
export const cleanCard = (v: unknown): string | null => { const s = typeof v === "string" ? v.trim() : ""; return /^[A-Za-z0-9:_-]{4,40}$/.test(s) ? s.toUpperCase() : null; };

export async function punch(db: Db, merchantId: string, staff: { id: string; name: string }, o: { outletId: string; deviceId?: string | null; method: PunchMethod; only?: "in" }): Promise<Punch> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`time/${merchantId}/${staff.id}`]);
    const open = (await client.query("SELECT id, clock_in FROM time_entries WHERE merchant_id=$1 AND staff_id=$2 AND clock_out IS NULL", [merchantId, staff.id])).rows[0];
    const now = Date.now();
    if (open) {
      const since = new Date(open.clock_in).getTime();
      if (o.only === "in" || now - since < DOUBLE_TAP_MS) { await client.query("COMMIT"); return { staffId: staff.id, name: staff.name, action: "in", at: since, repeated: true }; }
      await client.query("UPDATE time_entries SET clock_out=now(), out_method=$2, out_device=$3 WHERE id=$1", [open.id, o.method, o.deviceId ?? null]);
      await client.query("COMMIT");
      return { staffId: staff.id, name: staff.name, action: "out", at: now, workedMinutes: Math.round((now - since) / 60_000) };
    }
    const last = (await client.query("SELECT clock_out FROM time_entries WHERE merchant_id=$1 AND staff_id=$2 ORDER BY clock_in DESC LIMIT 1", [merchantId, staff.id])).rows[0];
    if (last?.clock_out && now - new Date(last.clock_out).getTime() < DOUBLE_TAP_MS) { await client.query("COMMIT"); return { staffId: staff.id, name: staff.name, action: "out", at: new Date(last.clock_out).getTime(), repeated: true }; }
    await client.query("INSERT INTO time_entries (merchant_id, outlet_id, staff_id, staff_name, in_method, in_device) VALUES ($1,$2,$3,$4,$5,$6)", [merchantId, o.outletId, staff.id, staff.name, o.method, o.deviceId ?? null]);
    await client.query("COMMIT");
    return { staffId: staff.id, name: staff.name, action: "in", at: now };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const minutes = (a: Date, b: Date | null, now: number) => Math.max(0, Math.round(((b ? b.getTime() : now) - a.getTime()) / 60_000));

export function registerTimeclock(app: FastifyInstance, d: { db: Db; merchantId: string; defaultOutletId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; needsDevice: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, needs } = d;
  const outletOf = (req: FastifyRequest) => req.device?.outletId ?? d.defaultOutletId;

  /** Clock in or out at a till, by card or by staff code and PIN. No one needs to be signed in. */
  app.post<{ Body: { card?: string; code?: string; pin?: string } }>("/api/time/punch", { preHandler: d.needsDevice }, async (req, reply) => {
    const b = req.body ?? {};
    let staff: { id: string; name: string } | null = null;
    let method: PunchMethod = "card";
    if (b.card !== undefined) {
      const card = cleanCard(b.card);
      const r = card ? await db.query("SELECT id, name FROM staff WHERE merchant_id=$1 AND card_id=$2 AND active", [merchantId, card]) : null;
      if (!r?.rows[0]) return reply.code(404).send({ error: "card_not_known", message: "That card is not set up for anyone. Ask a manager to add it." });
      staff = { id: r.rows[0].id, name: r.rows[0].name };
    } else {
      if (!b.code || !b.pin) return reply.code(400).send({ error: "a card, or a staff code and PIN, is required" });
      const v = await checkStaffPin(db, merchantId, String(b.code).trim(), String(b.pin));
      if (!v.ok) return reply.code(v.reason === "locked" ? 423 : 401).send({ error: v.reason === "locked" ? "locked" : "invalid", message: v.reason === "locked" ? "Too many wrong PINs. Try again in a few minutes." : "Wrong staff code or PIN." });
      staff = { id: v.row.id, name: v.row.name };
      method = "pin";
    }
    const p = await punch(db, merchantId, staff, { outletId: outletOf(req), deviceId: req.device?.id, method });
    if (!p.repeated) await audit(db, merchantId, staff.id, p.action === "in" ? "time.clock_in" : "time.clock_out", { method, deviceId: req.device?.id ?? null, outletId: outletOf(req) });
    return p;
  });

  /** The signed-in person's own state, and a way to clock from the till they are signed in to. */
  app.get("/api/time/me", { preHandler: needs("wallet.read") }, async (req) => {
    const r = await db.query("SELECT clock_in FROM time_entries WHERE merchant_id=$1 AND staff_id=$2 AND clock_out IS NULL", [merchantId, req.staff!.id]);
    return { clockedIn: !!r.rows[0], since: r.rows[0] ? new Date(r.rows[0].clock_in).getTime() : null };
  });
  app.post("/api/time/me", { preHandler: needs("wallet.read") }, async (req) => {
    const p = await punch(db, merchantId, { id: req.staff!.id, name: req.staff!.name }, { outletId: outletOf(req), deviceId: req.device?.id, method: "pin" });
    if (!p.repeated) await audit(db, merchantId, req.staff!.id, p.action === "in" ? "time.clock_in" : "time.clock_out", { method: "pin", deviceId: req.device?.id ?? null });
    return p;
  });

  /** The timesheet: every spell in the dates asked for (Singapore days, both included), and the hours per person. */
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/time/entries", { preHandler: needs("audit.read") }, async (req, reply) => {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
    const from = req.query.from ?? today, to = req.query.to ?? from;
    if (!day.test(from) || !day.test(to) || to < from) return reply.code(400).send({ error: "from and to are dates like 2026-11-25, and to is not before from" });
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    const r = await db.query(
      `SELECT id, outlet_id, staff_id, staff_name, clock_in, clock_out, in_method, out_method, note, edited_by FROM time_entries
        WHERE merchant_id=$1 AND clock_in >= ($2::date::timestamp AT TIME ZONE 'Asia/Singapore') AND clock_in < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Singapore') ORDER BY clock_in`, [merchantId, from, to]);
    const now = Date.now();
    const entries = r.rows.filter((x) => outletAllowed(visible, x.outlet_id)).map((x) => {
      const mins = minutes(x.clock_in, x.clock_out, now);
      const forgotten = !x.clock_out && mins > FORGOTTEN_HOURS * 60;
      return { id: x.id as string, outletId: x.outlet_id as string, staffId: x.staff_id as string, name: x.staff_name as string, clockIn: new Date(x.clock_in).getTime(), clockOut: x.clock_out ? new Date(x.clock_out).getTime() : null, minutes: forgotten ? 0 : mins, open: !x.clock_out, forgotten, inMethod: x.in_method as string, outMethod: (x.out_method as string | null) ?? null, note: (x.note as string | null) ?? null, editedBy: (x.edited_by as string | null) ?? null };
    });
    const by = new Map<string, { staffId: string; name: string; minutes: number; spells: number; open: boolean; forgotten: number }>();
    for (const e of entries) { const t = by.get(e.staffId) ?? { staffId: e.staffId, name: e.name, minutes: 0, spells: 0, open: false, forgotten: 0 }; t.minutes += e.minutes; t.spells++; if (e.open && !e.forgotten) t.open = true; if (e.forgotten) t.forgotten++; by.set(e.staffId, t); }
    return { from, to, entries, totals: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  });

  /** Put a spell right: a forgotten clock-out, a wrong time. Whoever may approve a shift may do it; a reason is required and it is audited. */
  app.put<{ Params: { id: string }; Body: { clockIn?: number; clockOut?: number | null; note?: string } }>("/api/time/entries/:id", { preHandler: needs("shift.approve") }, async (req, reply) => {
    const b = req.body ?? {};
    const note = String(b.note ?? "").trim().slice(0, 200);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || !note) return reply.code(400).send({ error: "a reason is required" });
    const cur = (await db.query("SELECT outlet_id, clock_in, clock_out FROM time_entries WHERE id=$1 AND merchant_id=$2", [req.params.id, merchantId])).rows[0];
    if (!cur) return reply.code(404).send({ error: "entry_not_found" });
    if (!outletAllowed(await visibleOutletIds(db, merchantId, req.staff!), cur.outlet_id)) return reply.code(403).send({ error: "outside_your_scope" });
    const inMs = b.clockIn === undefined ? new Date(cur.clock_in).getTime() : b.clockIn;
    const outMs = b.clockOut === undefined ? (cur.clock_out ? new Date(cur.clock_out).getTime() : null) : b.clockOut;
    const okTime = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 1_500_000_000_000 && n < Date.now() + 60_000;
    if (!okTime(inMs) || (outMs !== null && (!okTime(outMs) || outMs < inMs)) || (outMs !== null && outMs - inMs > 36 * 3600_000)) return reply.code(400).send({ error: "the times are not possible: out is after in, within 36 hours, and not in the future" });
    await db.query("UPDATE time_entries SET clock_in=to_timestamp($2/1000.0), clock_out=CASE WHEN $3::bigint IS NULL THEN NULL ELSE to_timestamp($3/1000.0) END, out_method=CASE WHEN $3::bigint IS NULL THEN NULL ELSE COALESCE(out_method,'manager') END, note=$4, edited_by=$5 WHERE id=$1", [req.params.id, inMs, outMs, note, req.staff!.name]);
    await audit(db, merchantId, req.staff!.id, "time.edit", { entryId: req.params.id, clockIn: inMs, clockOut: outMs, note });
    return { ok: true };
  });

  /** The people who work here, for the timesheet and for giving out cards. A card's number is never sent back whole. */
  app.get("/api/staff", { preHandler: needs("audit.read") }, async (req) => {
    const visible = await visibleOutletIds(db, merchantId, req.staff!);
    const r = await db.query("SELECT id, code, name, role, active, outlet_id, card_id FROM staff WHERE merchant_id=$1 AND role <> 'agent' ORDER BY name", [merchantId]);
    return { staff: r.rows.filter((s) => visible === null || (s.outlet_id && visible.includes(s.outlet_id))).map((s) => ({ id: s.id as string, code: s.code as string, name: s.name as string, role: s.role as string, active: s.active as boolean, card: s.card_id ? `···${String(s.card_id).slice(-4)}` : null })) };
  });
  app.put<{ Params: { id: string }; Body: { card?: string | null } }>("/api/staff/:id/card", { preHandler: needs("staff.manage") }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "staff_not_found" });
    const raw = req.body?.card;
    const card = raw === null || raw === "" ? null : cleanCard(raw);
    if (raw !== null && raw !== "" && !card) return reply.code(400).send({ error: "bad_card", message: "A card number is 4 to 40 letters and digits." });
    if (card) { const other = (await db.query("SELECT name FROM staff WHERE merchant_id=$1 AND card_id=$2 AND id<>$3", [merchantId, card, req.params.id])).rows[0]; if (other) return reply.code(409).send({ error: "card_in_use", message: `That card already belongs to ${other.name}.` }); }
    const r = await db.query("UPDATE staff SET card_id=$3 WHERE merchant_id=$1 AND id=$2 RETURNING name", [merchantId, req.params.id, card]);
    if (!r.rows[0]) return reply.code(404).send({ error: "staff_not_found" });
    await audit(db, merchantId, req.staff!.id, card ? "staff.card_set" : "staff.card_removed", { staffId: req.params.id });
    return { ok: true, card: card ? `···${card.slice(-4)}` : null };
  });
}
