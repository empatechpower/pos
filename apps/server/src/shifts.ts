import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { confirmedPaid, orderTotals, reduceAll, type BusinessConfig } from "@pos/core";
import { audit, canDo, checkStaffPin, type Permission, type Staff } from "./auth.js";
import type { EventStore } from "./store.js";
import type { Db } from "./db/pool.js";

export interface ShiftRow {
  id: string; outletId: string; deviceId: string; staffId: string; staffCode: string; staffName: string; drawer: 1 | 2;
  openingFloatCents: number; openedAt: number; closedAt: number | null; closedByName: string | null;
  countedCents: number | null; expectedCents: number | null; varianceCents: number | null; note: string | null;
  approvedByName: string | null; dispositions: Disposition[];
}
export interface Disposition { orderId: string; queueNumber: string | null; decision: "left_open"; by: string; at: number }

const toRow = (r: any): ShiftRow => ({
  id: r.id, outletId: r.outlet_id, deviceId: r.device_id, staffId: r.staff_id, staffCode: r.staff_code, staffName: r.staff_name, drawer: r.drawer,
  openingFloatCents: r.opening_float_cents, openedAt: new Date(r.opened_at).getTime(), closedAt: r.closed_at ? new Date(r.closed_at).getTime() : null,
  closedByName: r.closed_by_name ?? null, countedCents: r.counted_cents ?? null, expectedCents: r.expected_cents ?? null, varianceCents: r.variance_cents ?? null, note: r.note ?? null,
  approvedByName: r.approved_by_name ?? null, dispositions: r.dispositions ?? [],
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
    // A payment taken as a named tender (debit, check, gift card...) is its own row; a refund is filed under the tender of the payment it gives back.
    `SELECT COALESCE(CASE WHEN e.body->>'type'='PaymentRecorded' THEN COALESCE('custom:' || NULLIF(e.body->>'tenderName',''), e.body->>'tender')
                          ELSE (SELECT COALESCE('custom:' || NULLIF(p.body->>'tenderName',''), p.body->>'tender') FROM events p WHERE p.merchant_id=e.merchant_id AND p.order_id=e.order_id AND p.body->>'type'='PaymentRecorded' AND p.body->>'paymentId'=e.body->>'paymentId' LIMIT 1) END,
                     e.body->>'method') AS method, e.body->>'type' AS type, SUM((e.body->>'amountCents')::bigint) AS cents
       FROM events e WHERE e.merchant_id=$1 AND e.body->>'shiftId'=$2 AND e.body->>'type' IN ('PaymentRecorded','RefundRecorded')
        AND (e.body->>'type'='RefundRecorded' OR (e.body->>'confirmed')::boolean IS TRUE)
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



/** A cash count by note and coin ("1000": 3 means three $10 notes). Whatever is not a small whole count is dropped. */
const cleanDenoms = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (/^\d{1,6}$/.test(k) && Number.isInteger(n) && (n as number) > 0 && (n as number) < 100_000) out[k] = n as number;
  return out;
};

/** Orders at an outlet that still owe money and are not cancelled or finished: each one has to be answered for before a shift can close. */
async function openOrdersAt(store: EventStore, config: BusinessConfig, outletId: string) {
  const all = await store.after(0, outletId || undefined);
  return reduceAll(all.map((x) => x.event))
    .filter((o) => !o.onTab && !o.refunds?.length && o.stage !== "completed" && o.stage !== "cancelled" && o.lines.some((l) => l.qty > 0))
    .map((o) => ({ o, total: orderTotals(o, config).total }))
    .filter((x) => x.total > 0 && confirmedPaid(x.o) < x.total)
    .map((x) => ({ orderId: x.o.orderId, queueNumber: x.o.queueNumber ?? null, totalCents: x.total, paidCents: confirmedPaid(x.o), source: x.o.source, channel: x.o.channelName ?? null, openedAt: x.o.openedAt }))
    .sort((a, b) => a.openedAt - b.openedAt);
}

export const loadShift = async (db: Db, merchantId: string, id: string): Promise<ShiftRow | null> => {
  const r = (await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND id=$2", [merchantId, id])).rows[0];
  return r ? toRow(r) : null;
};
export const openShiftOf = async (db: Db, merchantId: string, staffId: string): Promise<ShiftRow | null> => {
  const r = (await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND staff_id=$2 AND closed_at IS NULL", [merchantId, staffId])).rows[0];
  return r ? toRow(r) : null;
};

export type VariancePolicy = "proceed" | "managerpin" | "blocked";
export interface ShiftSettings {
  /** Must a shift be open before a payment can be taken. */
  required: boolean;
  /** What a closing difference does: close anyway, need a manager's PIN (the default), or be blocked until it balances or a manager closes it. */
  variancePolicy: VariancePolicy;
  /** Does the shop run a formal Day-End close on top of each cashier's shift close (off unless switched on). */
  dayEnd: boolean;
  /** Minutes of no use before a till locks itself (0 = never). */
  lockMinutes: number;
}
export const DEFAULT_SHIFT_SETTINGS: ShiftSettings = { required: false, variancePolicy: "managerpin", dayEnd: false, lockMinutes: 3 };

export async function loadShiftSettings(db: Db | null, merchantId: string): Promise<ShiftSettings> {
  const r = db ? (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='shifts'", [merchantId])).rows[0] : undefined;
  const v = r?.value ?? {};
  return {
    required: !!v.required,
    variancePolicy: ["proceed", "managerpin", "blocked"].includes(v.variancePolicy) ? v.variancePolicy : DEFAULT_SHIFT_SETTINGS.variancePolicy,
    dayEnd: !!v.dayEnd,
    lockMinutes: Number.isInteger(v.lockMinutes) && v.lockMinutes >= 0 && v.lockMinutes <= 240 ? v.lockMinutes : DEFAULT_SHIFT_SETTINGS.lockMinutes,
  };
}

/**
 * Shifts, floats and drawers. A till can have two cashiers on at once, each on their own drawer; the drawer is given out automatically
 * (the cashier never picks). Cash taken is attributed to a shift by the shift id stamped on each payment, so two cashiers on one till
 * never share a figure. Closing counts the drawer against what it should hold and keeps the difference.
 */
export function registerShifts(app: FastifyInstance, d: { db: Db; merchantId: string; store: EventStore; config: BusinessConfig; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const { db, merchantId, store, config, needs } = d;
  const isManager = (s: Staff) => canDo(s, "shift.approve");

  app.get("/api/settings/shifts", { preHandler: needs("wallet.read") }, async () => loadShiftSettings(db, merchantId));
  app.put<{ Body: Partial<ShiftSettings> }>("/api/settings/shifts", { preHandler: needs("device.manage") }, async (req, reply) => {
    const cur = await loadShiftSettings(db, merchantId);
    const b = req.body ?? {};
    const next: ShiftSettings = {
      required: b.required === undefined ? cur.required : !!b.required,
      variancePolicy: b.variancePolicy === undefined ? cur.variancePolicy : (["proceed", "managerpin", "blocked"].includes(b.variancePolicy as string) ? (b.variancePolicy as VariancePolicy) : cur.variancePolicy),
      dayEnd: b.dayEnd === undefined ? cur.dayEnd : !!b.dayEnd,
      lockMinutes: b.lockMinutes === undefined ? cur.lockMinutes : Number(b.lockMinutes),
    };
    if (!Number.isInteger(next.lockMinutes) || next.lockMinutes < 0 || next.lockMinutes > 240) return reply.code(400).send({ error: "lock_minutes_not_allowed" });
    await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'shifts',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(next)]);
    await audit(db, merchantId, req.staff!.id, "settings.shifts", next);
    return next;
  });

  /** A till locked itself (idle) or was locked by hand: the lock is written to the audit log with who it was. Their shift stays open for them. */
  /** Someone signed in at a till that still held another person's order and carried it on (decision Q2: lock, then anyone takes over). */
  app.post<{ Body: { from?: string; orderId?: string | null; items?: number } }>("/api/auth/takeover", { preHandler: needs("wallet.spend") }, async (req) => {
    await audit(db, merchantId, req.staff!.id, "till.takeover", { deviceId: req.device?.id ?? null, from: String(req.body?.from ?? "").slice(0, 60), orderId: req.body?.orderId ? String(req.body.orderId).slice(0, 64) : null, items: Number.isInteger(req.body?.items) ? req.body!.items : null });
    return { ok: true };
  });

  app.post<{ Body: { auto?: boolean } }>("/api/auth/lock", { preHandler: needs("wallet.spend") }, async (req) => {
    await audit(db, merchantId, req.staff!.id, req.body?.auto ? "auth.lock_auto" : "auth.lock", { deviceId: req.device?.id ?? null });
    return { ok: true };
  });

  /** The signed-in person's open shift, if any (wherever they opened it). */
  app.get("/api/shifts/mine", { preHandler: needs("wallet.spend") }, async (req) => ({ shift: await openShiftOf(db, merchantId, req.staff!.id) }));

  app.post<{ Body: { openingFloatCents?: number; denominations?: Record<string, number> } }>("/api/shifts/open", { preHandler: needs("wallet.spend") }, async (req, reply) => {
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
          "INSERT INTO shifts (id, merchant_id, outlet_id, device_id, staff_id, staff_code, staff_name, drawer, opening_float_cents, opening_denoms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [id, merchantId, req.device.outletId ?? "", req.device.id, staff.id, staff.code, staff.name, drawer, float, JSON.stringify(cleanDenoms(req.body?.denominations))],
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

  /** A drawer count in the middle of a shift. The count is kept; the answer says what the till expected, and the difference. */
  app.post<{ Params: { id: string }; Body: { countedCents?: number; denominations?: Record<string, number> } }>("/api/shifts/:id/count", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    if (s.closedAt) return reply.code(409).send({ error: "shift_closed" });
    const counted = Number(req.body?.countedCents);
    if (!Number.isSafeInteger(counted) || counted < 0 || counted > 100_000_000) return reply.code(400).send({ error: "amount_not_allowed" });
    const expected = (await shiftReport(db, merchantId, s)).expectedCashCents;
    await db.query("INSERT INTO drawer_counts (shift_id, counted_cents, expected_cents, denominations, staff_name) VALUES ($1,$2,$3,$4::jsonb,$5)", [s.id, counted, expected, JSON.stringify(cleanDenoms(req.body?.denominations)), req.staff!.name]);
    await audit(db, merchantId, req.staff!.id, "shift.count", { shiftId: s.id, countedCents: counted, expectedCents: expected });
    return { countedCents: counted, expectedCents: expected, varianceCents: counted - expected };
  });

  /** Everything that moved cash in this shift's drawer, oldest first: cash sales and refunds, cash in and out, and drawer counts. */
  app.get<{ Params: { id: string } }>("/api/shifts/:id/history", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    const rows: Array<{ at: number; what: string; amountCents: number | null; by: string }> = [];
    const pay = (await db.query(
      `SELECT e.type, e.body, e.created_at,
              (SELECT o.body->>'queueNumber' FROM events o WHERE o.merchant_id=e.merchant_id AND o.order_id=e.order_id AND o.type='OrderOpened' LIMIT 1) AS queue
         FROM events e WHERE e.merchant_id=$1 AND e.body->>'shiftId'=$2 AND e.body->>'method'='cash'
          AND (e.type='RefundRecorded' OR (e.type='PaymentRecorded' AND (e.body->>'confirmed')::boolean IS TRUE))`, [merchantId, s.id])).rows;
    for (const r of pay) {
      const cents = Number(r.body.amountCents) || 0;
      const refund = r.type === "RefundRecorded";
      rows.push({ at: Number(r.body.ts) > 1e11 ? Number(r.body.ts) : new Date(r.created_at).getTime(), what: `${refund ? "Cash refund" : "Cash sale"}${r.queue ? ` · Order ${r.queue}` : ""}`, amountCents: refund ? -cents : cents, by: String(r.body.byName ?? r.body.approvedBy ?? s.staffName) });
    }
    for (const m of (await db.query("SELECT kind, amount_cents, reason, staff_name, created_at FROM cash_moves WHERE shift_id=$1", [s.id])).rows)
      rows.push({ at: new Date(m.created_at).getTime(), what: `${m.kind === "in" ? "Cash in" : "Cash out"} · ${m.reason}`, amountCents: m.kind === "in" ? m.amount_cents : -m.amount_cents, by: m.staff_name });
    for (const c of (await db.query("SELECT counted_cents, expected_cents, staff_name, created_at FROM drawer_counts WHERE shift_id=$1", [s.id])).rows)
      rows.push({ at: new Date(c.created_at).getTime(), what: `Drawer count · counted ${(c.counted_cents / 100).toFixed(2)}, expected ${(c.expected_cents / 100).toFixed(2)}`, amountCents: null, by: c.staff_name });
    rows.sort((a, b) => a.at - b.at);
    return { openingFloatCents: s.openingFloatCents, openedAt: s.openedAt, rows };
  });

  /** The orders a cashier has to answer for before this shift can close. */
  app.get<{ Params: { id: string } }>("/api/shifts/:id/open-orders", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    return { orders: await openOrdersAt(store, config, s.outletId) };
  });

  app.post<{ Params: { id: string }; Body: { countedCents?: number; note?: string; denominations?: Record<string, number>; dispositions?: Array<{ orderId?: string; decision?: string }>; leaveAllOpen?: boolean; approverCode?: string; approverPin?: string } }>("/api/shifts/:id/close", { preHandler: needs("wallet.spend") }, async (req, reply) => {
    const s = await mineOrManager(req, reply, req.params.id);
    if (!s) return;
    if (s.closedAt) return reply.code(409).send({ error: "already_closed", report: await shiftReport(db, merchantId, s) });
    const b = req.body ?? {};
    const counted = Number(b.countedCents);
    if (!Number.isSafeInteger(counted) || counted < 0 || counted > 100_000_000) return reply.code(400).send({ error: "counted_cash_required" });
    const me = req.staff!;
    const manager = isManager(me);

    // Every order still open is answered for: left open on purpose (settling it is done at the till before closing). A manager closing someone's forgotten shift may leave them all.
    const open = await openOrdersAt(store, config, s.outletId);
    const said = new Set((b.dispositions ?? []).filter((x) => x?.decision === "left_open").map((x) => String(x.orderId)));
    const leaveAll = !!b.leaveAllOpen && manager;
    const unanswered = leaveAll ? [] : open.filter((o) => !said.has(o.orderId));
    if (unanswered.length) return reply.code(409).send({ error: "open_orders_unanswered", orders: unanswered });
    const dispositions: Disposition[] = open.map((o) => ({ orderId: o.orderId, queueNumber: o.queueNumber, decision: "left_open", by: me.name, at: Date.now() }));

    const rep = await shiftReport(db, merchantId, s);
    const variance = counted - rep.expectedCashCents;
    const policy = (await loadShiftSettings(db, merchantId)).variancePolicy;
    let approvedBy: string | null = null;
    if (variance !== 0) {
      if (manager) approvedBy = me.name;
      else if (policy === "blocked") return reply.code(409).send({ error: "variance_blocked", varianceCents: variance });
      else if (policy === "managerpin") {
        if (!b.approverCode || !b.approverPin) return reply.code(428).send({ error: "manager_approval_needed", varianceCents: variance });
        const v = await checkStaffPin(db, merchantId, String(b.approverCode).trim(), String(b.approverPin));
        if (!v.ok) return reply.code(v.reason === "locked" ? 423 : 422).send({ error: v.reason === "locked" ? "approver_locked" : "approval_refused" });
        if (!canDo(v.row, "shift.approve")) return reply.code(422).send({ error: "approver_cannot_approve" });
        approvedBy = v.row.name;
      }
    }

    const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : null;
    const upd = await db.query(
      "UPDATE shifts SET closed_at=now(), closed_by_name=$3, counted_cents=$4, expected_cents=$5, variance_cents=$6, note=$7, closing_denoms=$8::jsonb, dispositions=$9::jsonb, approved_by_name=$10 WHERE merchant_id=$1 AND id=$2 AND closed_at IS NULL",
      [merchantId, s.id, me.name, counted, rep.expectedCashCents, variance, note, JSON.stringify(cleanDenoms(b.denominations)), JSON.stringify(dispositions), approvedBy],
    );
    if (!upd.rowCount) return reply.code(409).send({ error: "already_closed" });
    await audit(db, merchantId, me.id, "shift.close", { shiftId: s.id, countedCents: counted, expectedCents: rep.expectedCashCents, varianceCents: variance, approvedBy, forcedBy: s.staffId !== me.id ? me.name : null, leftOpen: dispositions.map((d) => d.orderId) });
    for (const d of dispositions) await audit(db, merchantId, me.id, "shift.order_left_open", { shiftId: s.id, orderId: d.orderId });
    const closed = (await loadShift(db, merchantId, s.id))!;
    return { report: { ...rep, shift: closed } };
  });

  /**
   * The formal Day-End close, for shops that switch it on: every shift must be closed first. It records who closed the day and what the day's
   * shifts came to; the day's detail stays in each shift's own Z report.
   */
  app.post("/api/shifts/day-end", { preHandler: needs("wallet.refund") }, async (req, reply) => {
    if (!(await loadShiftSettings(db, merchantId)).dayEnd) return reply.code(409).send({ error: "day_end_not_switched_on" });
    const open = (await db.query("SELECT COUNT(*) AS n FROM shifts WHERE merchant_id=$1 AND closed_at IS NULL", [merchantId])).rows[0].n;
    if (Number(open) > 0) return reply.code(409).send({ error: "shifts_still_open", count: Number(open) });
    const day = (await db.query("SELECT to_char(now() AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD') AS d")).rows[0].d as string;
    const todays = (await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND closed_at IS NOT NULL AND to_char(closed_at AT TIME ZONE 'Asia/Singapore','YYYY-MM-DD')=$2", [merchantId, day])).rows.map(toRow);
    let sales = 0, orders = 0, variance = 0;
    for (const sh of todays) {
      const rep = await shiftReport(db, merchantId, sh);
      sales += rep.tenders.reduce((n, t) => n + t.netCents, 0);
      orders += rep.orders;
      variance += sh.varianceCents ?? 0;
    }
    const row = (await db.query("INSERT INTO day_ends (merchant_id, business_date, closed_by_name, shifts, orders, sales_cents, variance_cents) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [merchantId, day, req.staff!.name, todays.length, orders, sales, variance])).rows[0];
    await audit(db, merchantId, req.staff!.id, "shift.day_end", { date: day, shifts: todays.length, orders, salesCents: sales, varianceCents: variance });
    return { dayEnd: { id: Number(row.id), date: day, closedBy: req.staff!.name, shifts: todays.length, orders, salesCents: sales, varianceCents: variance } };
  });

  /** Recent shifts for managers: who is on which drawer now, and how the closed ones balanced. */
  app.get("/api/shifts", { preHandler: needs("wallet.refund") }, async () => {
    const r = await db.query("SELECT * FROM shifts WHERE merchant_id=$1 AND (closed_at IS NULL OR opened_at > now() - interval '3 days') ORDER BY closed_at IS NULL DESC, opened_at DESC LIMIT 60", [merchantId]);
    const days = (await db.query("SELECT id, business_date, closed_by_name, shifts, orders, sales_cents, variance_cents, created_at FROM day_ends WHERE merchant_id=$1 ORDER BY id DESC LIMIT 7", [merchantId])).rows.map((x) => ({ id: Number(x.id), date: x.business_date as string, closedBy: x.closed_by_name as string, shifts: x.shifts as number, orders: x.orders as number, salesCents: Number(x.sales_cents), varianceCents: Number(x.variance_cents) }));
    return { shifts: r.rows.map(toRow), dayEnds: days };
  });
}
