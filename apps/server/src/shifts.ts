import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, can, type Permission, type Staff } from "./auth.js";
import type { Db } from "./db/pool.js";

export interface ShiftRow {
  id: string; outletId: string; deviceId: string; staffId: string; staffCode: string; staffName: string; drawer: 1 | 2;
  openingFloatCents: number; openedAt: number; closedAt: number | null; closedByName: string | null;
  countedCents: number | null; expectedCents: number | null; varianceCents: number | null; note: string | null;
}

const toRow = (r: any): ShiftRow => ({
  id: r.id, outletId: r.outlet_id, deviceId: r.device_id, staffId: r.staff_id, staffCode: r.staff_code, staffName: r.staff_name, drawer: r.drawer,
  openingFloatCents: r.opening_float_cents, openedAt: new Date(r.opened_at).getTime(), closedAt: r.closed_at ? new Date(r.closed_at).getTime() : null,
  closedByName: r.closed_by_name ?? null, countedCents: r.counted_cents ?? null, expectedCents: r.expected_cents ?? null, varianceCents: r.variance_cents ?? null, note: r.note ?? null,
});

export interface ShiftReport {
  shift: ShiftRow;
  /** What each way of paying took, net of refunds. */
  tenders: Array<{ method: string; salesCents: number; refundsCents: number; netCents: number }>;
  orders: number;
  cashIn: Array<{ reason: string; amountCents: number; by: string; at: number }>;
  cashOut: Array<{ reason: string; amountCents: number; by: string; at: number }>;
  /** Float + cash sales - cash refunds + cash in - cash out. */
  expectedCashCents: number;
}

/** Everything one shift took, worked out from the events that carry its id (payments from the till, refunds from the server). */
export async function shiftReport(db: Db, merchantId: string, s: ShiftRow): Promise<ShiftReport> {
  const pay = (await db.query(
    `SELECT body->>'method' AS method, body->>'type' AS type, SUM((body->>'amountCents')::bigint) AS cents
       FROM events WHERE merchant_id=$1 AND body->>'shiftId'=$2 AND body->>'type' IN ('PaymentRecorded','RefundRecorded')
        AND (body->>'type'='RefundRecorded' OR (body->>'confirmed')::boolean IS TRUE)
      GROUP BY 1,2`, [merchantId, s.id])).rows;
  const orders = Number((await db.query(`SELECT COUNT(DISTINCT order_id) AS n FROM events WHERE merchant_id=$1 AND body->>'shiftId'=$2 AND body->>'type'='PaymentRecorded'`, [merchantId, s.id])).rows[0].n);
  const methods = [...new Set(pay.map((r) => r.method as string))].sort();
  const tenders = methods.map((m) => {
    const sales = Number(pay.find((r) => r.method === m && r.type === "PaymentRecorded")?.cents ?? 0);
    const refunds = Number(pay.find((r) => r.method === m && r.type === "RefundRecorded")?.cents ?? 0);
    return { method: m, salesCents: sales, refundsCents: refunds, netCents: sales - refunds };
  });
  const moves = (await db.query("SELECT kind, amount_cents, reason, staff_name, created_at FROM cash_moves WHERE shift_id=$1 ORDER BY id", [s.id])).rows;
  const mv = (k: string) => moves.filter((m) => m.kind === k).map((m) => ({ reason: m.reason as string, amountCents: m.amount_cents as number, by: m.staff_name as string, at: new Date(m.created_at).getTime() }));
  const cashIn = mv("in"), cashOut = mv("out");
  const cashNet = tenders.find((t) => t.method === "cash")?.netCents ?? 0;
  return { shift: s, tenders, orders, cashIn, cashOut, expectedCashCents: s.openingFloatCents + cashNet + cashIn.reduce((n, m) => n + m.amountCents, 0) - cashOut.reduce((n, m) => n + m.amountCents, 0) };
}

export const loadShift = async (db: Db, merchantId: string, id: string): Promise<ShiftRow | null> => {
  const r = (await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND id=$2", [merchantId, id])).rows[0];
  return r ? toRow(r) : null;
};
export const openShiftOf = async (db: Db, merchantId: string, staffId: string): Promise<ShiftRow | null> => {
  const r = (await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND staff_id=$2 AND closed_at IS NULL", [merchantId, staffId])).rows[0];
  return r ? toRow(r) : null;
};

export async function loadShiftSettings(db: Db | null, merchantId: string): Promise<{ required: boolean }> {
  const r = db ? (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='shifts'", [merchantId])).rows[0] : undefined;
  return { required: !!r?.value?.required };
}

/**
 * Shifts, floats and drawers. A till can have two cashiers on at once, each on their own drawer; the drawer is given out automatically
 * (the cashier never picks). Cash taken is attributed to a shift by the shift id stamped on each payment, so two cashiers on one till
 * never share a figure. Closing counts the drawer against what it should hold and keeps the difference.
 */
export function registerShifts(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, needs } = d;
  const isManager = (s: Staff) => can(s.role, "wallet.refund");

  app.get("/api/settings/shifts", { preHandler: needs("wallet.read") }, async () => loadShiftSettings(db, merchantId));
  app.put<{ Body: { required?: boolean } }>("/api/settings/shifts", { preHandler: needs("device.manage") }, async (req) => {
    const required = !!req.body?.required;
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'shifts',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify({ required })]);
    await audit(db, merchantId, req.staff!.id, "settings.shifts", { required });
    return { required };
  });

  /** The signed-in person's open shift, if any (wherever they opened it). */
  app.get("/api/shifts/mine", { preHandler: needs("wallet.spend") }, async (req) => ({ shift: await openShiftOf(db, merchantId, req.staff!.id) }));

  app.post<{ Body: { openingFloatCents?: number } }>("/api/shifts/open", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const staff = req.staff!;
    const float = Number(req.body?.openingFloatCents ?? 0);
    if (!Number.isSafeInteger(float) || float < 0 || float > 10_000_000) return reply.code(400).send({ error: "float_not_allowed" });
    const mine = await openShiftOf(db, merchantId, staff.id);
    if (mine) return reply.code(409).send({ error: "already_open", shift: mine });
    if (!req.device) return reply.code(409).send({ error: "needs_an_enrolled_till" });
    const id = randomUUID();
    // The drawer is handed out, not chosen: the first free one on this till.
    for (const drawer of [1, 2]) {
      try {
        await db.query(
          "INSERT INTO shifts (id, merchant_id, outlet_id, device_id, staff_id, staff_code, staff_name, drawer, opening_float_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [id, merchantId, req.device.outletId ?? "", req.device.id, staff.id, staff.code, staff.name, drawer, float],
        );
        await audit(db, merchantId, staff.id, "shift.open", { shiftId: id, drawer, openingFloatCents: float });
        return { shift: await loadShift(db, merchantId, id) };
      } catch (e: any) {
        if (e?.code !== "23505") throw e;
        if (await openShiftOf(db, merchantId, staff.id)) return reply.code(409).send({ error: "already_open", shift: await openShiftOf(db, merchantId, staff.id) });
      }
    }
    return reply.code(409).send({ error: "both_drawers_in_use" });
  });

  const mineOrManager = async (req: FastifyRequest, reply: FastifyReply, id: string) => {
    const s = await loadShift(db, merchantId, id);
    if (!s) { await reply.code(404).send({ error: "shift_not_found" }); return null; }
    if (s.staffId !== req.staff!.id && !isManager(req.staff!)) { await reply.code(403).send({ error: "not_your_shift" }); return null; }
    return s;
  };

  app.post<{ Params: { id: string }; Body: { kind?: string; amountCents?: number; reason?: string } }>("/api/shifts/:id/cash", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    if (s.closedAt) return reply.code(409).send({ error: "shift_closed" });
    const kind = req.body?.kind;
    const cents = Number(req.body?.amountCents);
    const reason = String(req.body?.reason ?? "").trim().slice(0, 120);
    if (kind !== "in" && kind !== "out") return reply.code(400).send({ error: "kind_must_be_in_or_out" });
    if (!Number.isSafeInteger(cents) || cents <= 0) return reply.code(400).send({ error: "amount_not_allowed" });
    if (reason.length < 3) return reply.code(400).send({ error: "reason_required" });
    await db.query("INSERT INTO cash_moves (shift_id, kind, amount_cents, reason, staff_name) VALUES ($1,$2,$3,$4,$5)", [s.id, kind, cents, reason, req.staff!.name]);
    await audit(db, merchantId, req.staff!.id, `shift.cash_${kind}`, { shiftId: s.id, amountCents: cents, reason });
    return { ok: true };
  });

  /** The running figures of a shift (an "X report"): the same as the closing report, without closing. */
  app.get<{ Params: { id: string } }>("/api/shifts/:id/report", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    return shiftReport(db, merchantId, s);
  });

  app.post<{ Params: { id: string }; Body: { countedCents?: number; note?: string } }>("/api/shifts/:id/close", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    if (s.closedAt) return reply.code(409).send({ error: "already_closed", report: await shiftReport(db, merchantId, s) });
    const counted = Number(req.body?.countedCents);
    if (!Number.isSafeInteger(counted) || counted < 0 || counted > 100_000_000) return reply.code(400).send({ error: "counted_cash_required" });
    const rep = await shiftReport(db, merchantId, s);
    const variance = counted - rep.expectedCashCents;
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 200) : null;
    const upd = await db.query(
      "UPDATE shifts SET closed_at=now(), closed_by_name=$3, counted_cents=$4, expected_cents=$5, variance_cents=$6, note=$7 WHERE merchant_id=$1 AND id=$2 AND closed_at IS NULL",
      [merchantId, s.id, req.staff!.name, counted, rep.expectedCashCents, variance, note],
    );
    if (!upd.rowCount) return reply.code(409).send({ error: "already_closed" });
    await audit(db, merchantId, req.staff!.id, "shift.close", { shiftId: s.id, countedCents: counted, expectedCents: rep.expectedCashCents, varianceCents: variance, forcedBy: s.staffId !== req.staff!.id ? req.staff!.name : null });
    const closed = (await loadShift(db, merchantId, s.id))!;
    return { report: { ...rep, shift: closed } };
  });

  /** Recent shifts for managers: who is on which drawer now, and how the closed ones balanced. */
  app.get("/api/shifts", { preHandler: needs("wallet.refund") }, async () => {
    const r = await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND (closed_at IS NULL OR opened_at > now() - interval '3 days') ORDER BY closed_at IS NULL DESC, opened_at DESC LIMIT 60", [merchantId]);
    return { shifts: r.rows.map(toRow) };
  });
}
