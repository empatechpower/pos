import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  allocTotal, lineStates, optionLines, orderTotals, quoteAll, quoteCustom, quoteEqual, quoteMine, quoteRound, reduceOrder, tabBill, tabStanding,
  type BusinessConfig, type OrderEvent, type OrderState, type PaymentAlloc, type TabLineIn, type TabOpts, type TabQuote, type TabState,
} from "@pos/core";
import type pg from "pg";
import type { Db } from "./db/pool.js";
import type { Permission } from "./auth.js";
import { audit } from "./auth.js";
import type { Member, MemberStore } from "./members.js";
import { creditBlockedFor, spend as spendCredit } from "./ledger.js";
import { FailureLimiter } from "./rateLimit.js";

/**
 * Tab & Split & Pay on the server (Spec 12 and 13, Addendum 2.4, 3, 4, 5, 6). Everything that moves money is decided here: the app only asks.
 *  - A table's orders are Rounds on one Tab. Whoever scans first is the Host.
 *  - Payment is locked until the waiter releases it; a round ordered after a release starts locked again.
 *  - A quote freezes the maths at issue time. A payment is taken against it, or a new quote is visibly issued: a changed price is never charged silently.
 *  - A payment reserves its units atomically (a database key makes a double claim impossible). One payment in flight per party.
 *  - A payment is attributed to who actually paid (the session identity). There is no way to pay "as" someone else.
 *  - Rewards are credited once, when the whole tab is paid (watermark), to the payer or, if they chose, the Host.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const QUOTE_MINUTES = 10;
export const LOCK_NOTE = "Your waiter will release payment when you're ready to pay.";

export interface TabDeps {
  db: Db;
  merchantId: string;
  config: BusinessConfig;
  eventsForOrder: (orderId: string) => Promise<OrderEvent[]>;
  members?: MemberStore;
  /** Writes events (used to record the Tab's payment on its round orders when it settles). */
  ingest: (events: OrderEvent[], outletId?: string) => Promise<unknown>;
  now?: () => number;
}

interface TabRow { id: string; outlet_id: string; spot: string | null; code: string; status: "open" | "closed"; host_id: string | null; version: number; released_at: Date | null; bill_requested: boolean; waiter_paged: boolean; paged_kind: string | null; closed_at: Date | null; rewards_credited_at: Date | null }
interface PersonRow { id: string; display_name: string; member_id: string | null; ord: number; left_at: Date | null; claimed_by: string | null }
interface PayRow { id: string; payer_id: string; for_id: string | null; mode: string; method: string; amount_cents: number; status: string; host_keep: boolean; alloc: PaymentAlloc; staff_id: string | null; created_at: Date; completed_at: Date | null; note: string | null }

export class TabError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.error ?? "tab_error")); }
}
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => { throw new TabError(status, { error, ...extra }); };

export interface Snapshot {
  tab: TabRow;
  people: PersonRow[];
  rounds: Array<{ roundNo: number; orderId: string; participantId: string; createdAt: Date; order: OrderState | null; locked: boolean }>;
  payments: PayRow[];
  claims: Array<{ lineId: string; idx: number; paymentId: string }>;
  shares: Map<string, string[]>;
  /** Every line of the tab, as the engine sees it. */
  lines: TabLineIn[];
  /** The lines whose round the waiter has released: the only ones that can be paid. */
  payableLines: TabLineIn[];
  opts: TabOpts;
  allocs: PaymentAlloc[];
}

export class TabService {
  constructor(private readonly d: TabDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }
  private get m() { return this.d.merchantId; }

  // ---- settings ---------------------------------------------------------------------------

  async outletSettings(outletId: string): Promise<{ tabService: boolean; allocation: "oldest_first" | "reduce_only"; tableService: boolean }> {
    const r = (await this.d.db.query("SELECT tab_service, tab_custom_allocation, service_mode FROM outlets WHERE merchant_id=$1 AND id=$2", [this.m, outletId])).rows[0];
    return { tabService: !!r?.tab_service && r?.service_mode === "tsr", allocation: r?.tab_custom_allocation === "reduce_only" ? "reduce_only" : "oldest_first", tableService: r?.service_mode === "tsr" };
  }

  /** Invalid combinations cannot be saved: a Tab needs table service (Addendum 7). */
  async saveOutletSettings(outletId: string, s: { tabService?: boolean; allocation?: string }): Promise<void> {
    const cur = await this.outletSettings(outletId);
    if (s.tabService === true && !cur.tableService) fail(400, "tab_needs_table_service", { message: "Add to Tab needs the outlet to be set to table service." });
    if (s.allocation !== undefined && s.allocation !== "oldest_first" && s.allocation !== "reduce_only") fail(400, "allocation_is_oldest_first_or_reduce_only");
    if (s.tabService !== undefined) await this.d.db.query("UPDATE outlets SET tab_service=$3 WHERE merchant_id=$1 AND id=$2", [this.m, outletId, s.tabService]);
    if (s.allocation !== undefined) await this.d.db.query("UPDATE outlets SET tab_custom_allocation=$3 WHERE merchant_id=$1 AND id=$2", [this.m, outletId, s.allocation]);
  }

  // ---- joining ----------------------------------------------------------------------------

  private async newCode(q: Pick<pg.Pool, "query">): Promise<string> {
    for (let i = 0; i < 30; i++) {
      const code = Array.from(randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
      if (!(await q.query("SELECT 1 FROM tabs WHERE merchant_id=$1 AND code=$2 AND status='open'", [this.m, code])).rowCount) return code;
    }
    return fail(503, "could_not_make_a_code");
  }

  /**
   * Join the table's open Tab (the table QR), or open it if none is open (the first person in is the Host), or join by the typed check-in code.
   * Only a display name is asked. A signed-in member is attached by the server from their session, never from anything the client sends.
   * One person can hold only one open tab on a device: joining the same Tab again with the same credential just returns it.
   */
  async join(o: { outletId: string; spot?: string; code?: string; displayName?: string; member?: Member | null; existing?: { participantId: string; token: string } }): Promise<{ tabId: string; participantId: string; token: string; hostId: string; created: boolean }> {
    const client = await this.d.db.connect();
    try {
      await client.query("BEGIN");
      const lockKey = o.code ? `tab-code/${this.m}/${o.code}` : `tab-spot/${this.m}/${o.outletId}/${o.spot ?? ""}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      let tab: TabRow | undefined;
      let created = false;
      if (o.code) {
        tab = (await client.query("SELECT * FROM tabs WHERE merchant_id=$1 AND code=$2 AND status='open'", [this.m, o.code.toUpperCase().replace(/[^A-Z0-9]/g, "")])).rows[0];
        if (!tab) fail(404, "tab_not_found");
      } else {
        const spot = (o.spot ?? "").trim();
        if (!spot) fail(400, "table_or_code_required");
        tab = (await client.query("SELECT * FROM tabs WHERE merchant_id=$1 AND outlet_id=$2 AND spot=$3 AND status='open'", [this.m, o.outletId, spot])).rows[0];
        if (!tab) {
          tab = (await client.query("INSERT INTO tabs (merchant_id, outlet_id, spot, code) VALUES ($1,$2,$3,$4) RETURNING *", [this.m, o.outletId, spot, await this.newCode(client)])).rows[0] as TabRow;
          created = true;
        }
      }
      const t = tab!;
      // The same person coming back with their credential is not a new person.
      if (o.existing) {
        const back = (await client.query("SELECT id FROM tab_participants WHERE id=$1 AND tab_id=$2 AND token_hash=$3", [o.existing.participantId, t.id, sha256(o.existing.token)])).rows[0];
        if (back) { await client.query("UPDATE tab_participants SET left_at=NULL WHERE id=$1", [back.id]); await client.query("COMMIT"); return { tabId: t.id, participantId: back.id, token: o.existing.token, hostId: t.host_id ?? back.id, created: false }; }
      }
      // A signed-in member who is already on this tab is the same person on another phone.
      if (o.member) {
        const same = (await client.query("SELECT id FROM tab_participants WHERE tab_id=$1 AND member_id=$2", [t.id, o.member.id])).rows[0];
        if (same) {
          const token = randomBytes(24).toString("base64url");
          await client.query("UPDATE tab_participants SET token_hash=$2, left_at=NULL WHERE id=$1", [same.id, sha256(token)]);
          await client.query("COMMIT");
          return { tabId: t.id, participantId: same.id, token, hostId: t.host_id ?? same.id, created: false };
        }
      }
      const count = Number((await client.query("SELECT count(*) FROM tab_participants WHERE tab_id=$1", [t.id])).rows[0].count);
      // Unnamed guests are Guest 1, Guest 2 ... (a name someone typed does not use up a number).
      const guests = Math.max(0, ...(await client.query("SELECT display_name FROM tab_participants WHERE tab_id=$1 AND display_name ~ '^Guest [0-9]+$'", [t.id])).rows.map((r) => Number(String(r.display_name).slice(6))));
      const typed = (o.displayName ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 30);
      const name = o.member ? (o.member.name?.trim() || typed || `Member ${count + 1}`) : typed || `Guest ${guests + 1}`;
      const token = randomBytes(24).toString("base64url");
      const p = (await client.query("INSERT INTO tab_participants (tab_id, display_name, member_id, token_hash, ord) VALUES ($1,$2,$3,$4,$5) RETURNING id", [t.id, name, o.member?.id ?? null, sha256(token), count + 1])).rows[0];
      let hostId = t.host_id;
      if (!hostId) { await client.query("UPDATE tabs SET host_id=$2 WHERE id=$1", [t.id, p.id]); hostId = p.id; }
      await client.query("UPDATE tabs SET version = version + 1 WHERE id=$1", [t.id]);
      await client.query("COMMIT");
      return { tabId: t.id, participantId: p.id, token, hostId: hostId!, created };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** The credential is the participant id and its token, checked together. A wrong pair is never told apart from an unknown tab. */
  async authenticate(participantId: unknown, token: unknown): Promise<{ person: PersonRow; tabId: string }> {
    if (typeof participantId !== "string" || typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(participantId)) return fail(401, "join_the_tab");
    const r = (await this.d.db.query("SELECT p.*, p.tab_id FROM tab_participants p WHERE p.id=$1 AND p.token_hash=$2", [participantId, sha256(token)])).rows[0];
    if (!r) return fail(401, "join_the_tab");
    return { person: r as PersonRow, tabId: r.tab_id as string };
  }

  async leave(participantId: string): Promise<void> {
    await this.d.db.query("UPDATE tab_participants SET left_at=now() WHERE id=$1", [participantId]); // leaving never loses paid history
  }

  // ---- reading a tab ----------------------------------------------------------------------

  async snapshot(tabId: string, q: Pick<pg.Pool, "query"> = this.d.db): Promise<Snapshot> {
    const tab = (await q.query("SELECT * FROM tabs WHERE id=$1 AND merchant_id=$2", [tabId, this.m])).rows[0] as TabRow | undefined;
    if (!tab) return fail(404, "tab_not_found");
    const people = (await q.query("SELECT id, display_name, member_id, ord, left_at, claimed_by FROM tab_participants WHERE tab_id=$1 ORDER BY ord", [tabId])).rows as PersonRow[];
    const roundRows = (await q.query("SELECT order_id, round_no, participant_id, created_at FROM tab_rounds WHERE tab_id=$1 ORDER BY round_no", [tabId])).rows;
    const payments = (await q.query("SELECT id, payer_id, for_id, mode, method, amount_cents, status, host_keep, alloc, staff_id, created_at, completed_at, note FROM tab_payments WHERE tab_id=$1 ORDER BY created_at", [tabId])).rows as PayRow[];
    const claims = (await q.query("SELECT line_id, idx, payment_id FROM tab_claims WHERE tab_id=$1", [tabId])).rows.map((x) => ({ lineId: x.line_id as string, idx: x.idx as number, paymentId: x.payment_id as string }));
    const shares = new Map<string, string[]>();
    for (const s of (await q.query("SELECT line_id, participant_id FROM tab_line_shares WHERE tab_id=$1 ORDER BY ord", [tabId])).rows) shares.set(s.line_id, [...(shares.get(s.line_id) ?? []), s.participant_id]);
    const rounds: Snapshot["rounds"] = [];
    for (const r of roundRows) {
      const order = reduceOrder(r.order_id, await this.d.eventsForOrder(r.order_id));
      rounds.push({ roundNo: r.round_no, orderId: r.order_id, participantId: r.participant_id, createdAt: r.created_at, order, locked: !tab.released_at || new Date(r.created_at) > new Date(tab.released_at) });
    }
    const toLines = (rs: typeof rounds): TabLineIn[] => rs.filter((r) => r.order && r.order.stage !== "cancelled").flatMap((r) => r.order!.lines.filter((l) => l.qty > 0).map((l) => ({
      lineId: l.lineId, round: r.roundNo, name: l.name, unitCents: l.unitCents, qty: l.qty, ownerId: r.participantId, bcrs: !!l.bcrs,
      ...(l.taxInclusive !== undefined ? { taxInclusive: l.taxInclusive } : {}), ...(l.taxGroup ? { taxGroup: l.taxGroup } : {}),
      ...(shares.get(l.lineId)?.length ? { sharedWith: shares.get(l.lineId)! } : {}),
    })));
    const first = rounds.find((r) => r.order);
    const opts: TabOpts = { serviceCharge: first?.order?.serviceCharge !== false, pricing: this.d.config.pricing };
    const counted = payments.filter((p) => p.status === "reserved" || p.status === "completed" || p.status === "unknown");
    return { tab, people, rounds, payments, claims, shares, lines: toLines(rounds), payableLines: toLines(rounds.filter((r) => !r.locked)), opts, allocs: counted.map((p) => p.alloc) };
  }

  private state(s: Snapshot): TabState { return { lines: s.payableLines, payments: s.allocs, opts: s.opts }; }

  /** Who stands in as Host: the Host, or if they have left, the earliest-joined person still here. */
  private effectiveHost(s: Snapshot): string {
    const host = s.people.find((p) => p.id === s.tab.host_id);
    if (host && !host.left_at) return host.id;
    return (s.people.find((p) => !p.left_at) ?? s.people[0])?.id ?? "";
  }

  /** What a person sees: the whole tab, who ordered and paid what, their own share, and what is locked. */
  async view(tabId: string, viewerId: string): Promise<Record<string, unknown>> {
    const s = await this.snapshot(tabId);
    const name = (id: string | null) => s.people.find((p) => p.id === id)?.display_name ?? null;
    const whole = tabBill(s.lines, s.opts);
    const counted = s.payments.filter((p) => p.status === "reserved" || p.status === "completed" || p.status === "unknown");
    const paid = counted.reduce((n, p) => n + p.amount_cents, 0);
    const remaining = Math.max(0, whole.totalCents - paid);
    const payById = new Map(s.payments.map((p) => [p.id, p]));
    const claimPay = new Map(s.claims.map((c) => [`${c.lineId}#${c.idx}`, payById.get(c.paymentId)]));
    const states = lineStates(s.lines, s.opts, [], []);
    const released = !!s.tab.released_at;
    const anyPayable = s.payableLines.length > 0;
    const me = s.people.find((p) => p.id === viewerId);
    let owes = 0;
    if (anyPayable && s.tab.status === "open") owes = quoteMine(this.state(s), viewerId).amountCents;
    const rate = this.d.config.rewards.pointsEnabled ? this.d.config.rewards.earnPointsPerDollar : 0;
    const myPaid = s.payments.filter((p) => p.status === "completed" && p.payer_id === viewerId).reduce((n, p) => n + p.amount_cents, 0);
    return {
      id: s.tab.id, spot: s.tab.spot, code: s.tab.code, outletId: s.tab.outlet_id, status: s.tab.status, version: s.tab.version,
      host: { id: this.effectiveHost(s), name: name(this.effectiveHost(s)) },
      people: s.people.map((p) => ({ id: p.id, name: p.display_name, isHost: p.id === this.effectiveHost(s), isMe: p.id === viewerId, left: !!p.left_at, member: !!p.member_id })),
      totals: { totalCents: whole.totalCents, paidCents: Math.min(paid, whole.totalCents), remainingCents: remaining, itemsCents: whole.itemsCents, serviceCents: whole.serviceCents, taxCents: whole.taxCents, depositCents: whole.depositCents, taxIncludedCents: whole.taxIncludedCents },
      // The pay area is locked until the waiter releases it; a round ordered after a release starts locked again.
      paymentLocked: !anyPayable && s.rounds.some((r) => r.order && r.order.stage !== "cancelled"),
      lockNote: LOCK_NOTE,
      released,
      rounds: s.rounds.filter((r) => r.order).map((r) => ({
        round: r.roundNo, orderId: r.orderId, orderedBy: { id: r.participantId, name: name(r.participantId) }, at: r.createdAt, locked: r.locked,
        kitchen: r.order!.stage === "cancelled" ? "Cancelled" : r.order!.stage === "ready" || r.order!.stage === "completed" ? "Served" : r.order!.stage === "preparing" ? "Preparing" : r.order!.acceptedAt ? "Sent to the kitchen" : "Waiting for the waiter",
        lines: r.order!.lines.filter((l) => l.qty > 0).map((l) => {
          const total = states[l.lineId]?.total ?? l.qty;
          const owners = (s.shares.get(l.lineId) ?? []).map((id) => ({ id, name: name(id) }));
          let paidUnits = 0, reservedUnits = 0; const paidBy = new Set<string>();
          for (let i = 0; i < total; i++) {
            const p = claimPay.get(`${l.lineId}#${i}`);
            if (!p) continue;
            if (p.status === "completed") { paidUnits++; paidBy.add(name(p.payer_id) ?? "someone"); } else if (p.status === "reserved" || p.status === "unknown") reservedUnits++;
          }
          return { lineId: l.lineId, productId: l.productId, name: l.name, qty: l.qty, unitCents: l.unitCents, options: optionLines(l.options), deposit: !!l.bcrs, owner: { id: r.participantId, name: name(r.participantId) }, sharedWith: owners, units: total, paidUnits, reservedUnits, paidBy: [...paidBy] };
        }),
      })),
      payments: s.payments.filter((p) => p.status !== "cancelled" && p.status !== "rejected").map((p) => ({ id: p.id, payer: { id: p.payer_id, name: name(p.payer_id) }, for: p.for_id ? { id: p.for_id, name: name(p.for_id) } : null, amountCents: p.amount_cents, status: p.status, method: p.method, mode: p.mode, staffRecorded: !!p.staff_id, hostKeep: p.host_keep, at: p.completed_at ?? p.created_at })),
      billRequested: s.tab.bill_requested, waiterPaged: s.tab.waiter_paged, pagedKind: s.tab.paged_kind,
      me: me ? { id: me.id, name: me.display_name, memberId: me.member_id, owesCents: owes, paidCents: myPaid, pendingPoints: remaining > 0 ? Math.floor((myPaid / 100) * rate) : 0 } : null,
      closed: s.tab.status === "closed",
      pendingRewardsNote: remaining > 0 && rate > 0 ? "These points become available when the whole table bill is paid." : null,
      customAllocation: (await this.outletSettings(s.tab.outlet_id)).allocation,
    };
  }

  // ---- rounds -----------------------------------------------------------------------------

  /** An order the shop took becomes the next Round of the Tab. */
  async addRound(tabId: string, orderId: string, participantId: string): Promise<number> {
    const client = await this.d.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tab/${tabId}`]);
      const t = (await client.query("SELECT status FROM tabs WHERE id=$1", [tabId])).rows[0];
      if (!t || t.status !== "open") fail(409, "tab_closed");
      const no = Number((await client.query("SELECT COALESCE(MAX(round_no),0)+1 AS n FROM tab_rounds WHERE tab_id=$1", [tabId])).rows[0].n);
      await client.query("INSERT INTO tab_rounds (tab_id, order_id, round_no, participant_id) VALUES ($1,$2,$3,$4)", [tabId, orderId, no, participantId]);
      await client.query("UPDATE tabs SET version = version + 1 WHERE id=$1", [tabId]);
      await client.query("COMMIT");
      return no;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async tabOpen(tabId: string): Promise<{ outletId: string; spot: string | null; open: boolean }> {
    const t = (await this.d.db.query("SELECT outlet_id, spot, status FROM tabs WHERE id=$1 AND merchant_id=$2", [tabId, this.m])).rows[0];
    if (!t) return fail(404, "tab_not_found");
    return { outletId: t.outlet_id, spot: t.spot, open: t.status === "open" };
  }

  /** Share a line between the people chosen. A line with a unit that is paid or reserved cannot be re-shared. */
  async shareLine(tabId: string, lineId: string, participantIds: string[]): Promise<void> {
    const s = await this.snapshot(tabId);
    if (s.tab.status !== "open") fail(409, "tab_closed");
    if (!s.lines.some((l) => l.lineId === lineId)) fail(404, "line_not_found");
    if (s.claims.some((c) => c.lineId === lineId && s.payments.find((p) => p.id === c.paymentId && ["reserved", "completed", "unknown"].includes(p.status)))) fail(409, "line_is_locked", { message: "A paid or locked item cannot be shared again." });
    const ids = [...new Set(participantIds)];
    if (ids.some((id) => !s.people.some((p) => p.id === id))) fail(400, "not_on_this_tab");
    const client = await this.d.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tab/${tabId}`]);
      await client.query("DELETE FROM tab_line_shares WHERE tab_id=$1 AND line_id=$2", [tabId, lineId]);
      if (ids.length > 1) for (const [i, id] of ids.entries()) await client.query("INSERT INTO tab_line_shares (tab_id, line_id, participant_id, ord) VALUES ($1,$2,$3,$4)", [tabId, lineId, id, i]);
      await client.query("UPDATE tabs SET version = version + 1 WHERE id=$1", [tabId]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- quotes -----------------------------------------------------------------------------

  private quoteFor(s: Snapshot, requester: string, p: QuoteParams): TabQuote {
    if (!s.payableLines.length) fail(409, "payment_locked", { message: LOCK_NOTE });
    const st = this.state(s);
    const standing = tabStanding(st);
    if (standing.remainingCents <= 0) fail(409, "nothing_to_pay");
    const host = this.effectiveHost(s);
    switch (p.mode) {
      case "mine": {
        const party = p.forParticipantId ?? requester;
        if (!s.people.some((x) => x.id === party)) fail(400, "not_on_this_tab");
        return quoteMine(st, party);
      }
      case "round": {
        if (!Number.isInteger(p.round) || !s.payableLines.some((l) => l.round === p.round)) fail(400, "round_is_not_payable_yet");
        return quoteRound(st, p.round!);
      }
      case "all": return quoteAll(st);
      case "equal": {
        const n = Math.max(1, Math.min(30, Math.floor(p.people ?? 0) || s.people.filter((x) => !x.left_at).length));
        const here = s.people.filter((x) => !x.left_at && x.id !== requester).map((x) => x.id);
        const payers = [requester, ...here.slice(0, n - 1)];
        for (let i = payers.length; i < n; i++) payers.push(`seat-${i + 1}`); // a seat for someone not on the tab
        return quoteEqual(st, payers, requester, host);
      }
      case "custom": {
        if (!Number.isInteger(p.amountCents) || (p.amountCents ?? 0) <= 0) fail(400, "amount_is_whole_cents");
        return quoteCustom(st, p.amountCents!, p.allocation ?? "oldest_first");
      }
    }
    return fail(400, "unknown_mode");
  }

  /** Issue a frozen quote: the maths as it stands now, with the tab's version, to be paid against or rejected. */
  async quote(tabId: string, requester: string, p: QuoteParams): Promise<Record<string, unknown>> {
    const s = await this.snapshot(tabId);
    if (s.tab.status !== "open") fail(409, "tab_closed");
    const allocation = (await this.outletSettings(s.tab.outlet_id)).allocation;
    const params = { ...p, allocation };
    const q = this.quoteFor(s, requester, params);
    if (q.amountCents <= 0) fail(409, "nothing_to_pay_for_this");
    const row = (await this.d.db.query(
      "INSERT INTO tab_quotes (tab_id, participant_id, version, mode, params, amount_cents, breakdown, expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb, now() + make_interval(mins => $8)) RETURNING id, issued_at, expires_at",
      [tabId, requester, s.tab.version, p.mode, JSON.stringify(params), q.amountCents, JSON.stringify(q), QUOTE_MINUTES],
    )).rows[0];
    return this.quoteView(row.id, q, s.tab.version, row.issued_at, row.expires_at, whole(s));
  }

  private quoteView(id: string, q: TabQuote, version: number, issuedAt: Date, expiresAt: Date, tot: { totalCents: number }): Record<string, unknown> {
    return {
      quoteId: id, version, mode: q.mode, amountCents: q.amountCents, issuedAt, expiresAt,
      // The maths in the standard Bag format: what is being paid for, then the components.
      lines: q.lines, itemsCents: q.itemsCents, serviceCents: q.serviceCents, taxCents: q.taxCents, depositCents: q.depositCents, creditAppliedCents: q.creditAppliedCents,
      tabTotalCents: tot.totalCents,
    };
  }

  // ---- paying -----------------------------------------------------------------------------

  /**
   * Pay against a quote. Under a lock on the tab, the quote is checked again: if anything it depends on has changed it is rejected and a new
   * quote is returned (visibly, never silently charged). The units are claimed with a database key, so two phones cannot both take the same
   * liability. One payment in flight per party. The payer is always the session identity.
   */
  async pay(o: { tabId: string; payerId: string; quoteId: string; method: string; idempotencyKey: string; hostKeep?: boolean; member?: Member | null; staffId?: string | null; asStaff?: boolean }): Promise<Record<string, unknown>> {
    if (!/^[\w-]{8,64}$/.test(o.idempotencyKey)) fail(400, "idempotency_key_required");
    if (!/^[0-9a-f-]{36}$/.test(o.quoteId)) fail(400, "quote_required");
    if (!["credit", "counter", "cash", "card", "paynow"].includes(o.method)) fail(400, "unknown_method");
    if (o.method === "card" || o.method === "paynow") fail(501, "provider_unavailable", { message: "Online card and PayNow payment for a tab needs the payment provider to be connected." });
    if (o.method === "cash" && !o.asStaff) fail(403, "cash_is_recorded_by_staff");
    const client = await this.d.db.connect();
    let result: Record<string, unknown>;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tab/${o.tabId}`]);
      const dup = (await client.query("SELECT id, status, quote_id, amount_cents FROM tab_payments WHERE tab_id=$1 AND idem_key=$2", [o.tabId, o.idempotencyKey])).rows[0];
      if (dup) {
        if (dup.quote_id !== o.quoteId) fail(409, "idempotency_key_reused");
        await client.query("COMMIT");
        return { paymentId: dup.id, status: dup.status, amountCents: dup.amount_cents, replayed: true };
      }
      const qrow = (await client.query("SELECT * FROM tab_quotes WHERE id=$1 AND tab_id=$2", [o.quoteId, o.tabId])).rows[0];
      if (!qrow || (!o.asStaff && qrow.participant_id !== o.payerId)) fail(404, "quote_not_found");
      if (qrow.used) fail(409, "quote_already_used");
      const s = await this.snapshot(o.tabId, client);
      if (s.tab.status !== "open") fail(409, "tab_closed");
      const params = qrow.params as QuoteParams & { allocation?: "oldest_first" | "reduce_only" };
      const fresh = this.quoteFor(s, qrow.participant_id as string, params);
      const frozen = qrow.breakdown as TabQuote;
      const expired = new Date(qrow.expires_at).getTime() < this.now();
      const same = fresh.amountCents === frozen.amountCents && sameAlloc(fresh.alloc, frozen.alloc);
      if (expired || !same) {
        // The tab moved on: a new quote is issued, visibly. A changed price is never charged under a stale quote.
        await client.query("ROLLBACK");
        const newQuote = fresh.amountCents > 0 ? await this.quote(o.tabId, qrow.participant_id as string, params) : null;
        return fail(409, expired ? "quote_expired" : "quote_changed", { quote: newQuote });
      }
      // One payment in flight per party.
      const party = params.mode === "mine" ? (params.forParticipantId ?? qrow.participant_id) : qrow.participant_id;
      const busy = (await client.query("SELECT 1 FROM tab_payments WHERE tab_id=$1 AND status IN ('reserved','unknown') AND COALESCE(for_id, payer_id)=$2", [o.tabId, party])).rowCount;
      if (busy) fail(409, "payment_in_flight", { message: "A payment for this share is already in progress." });
      if (frozen.amountCents > Math.max(0, tabStanding(this.state(s)).remainingCents)) fail(409, "would_overpay");
      const id = randomUUID();
      await client.query(
        "INSERT INTO tab_payments (id, tab_id, payer_id, for_id, mode, method, amount_cents, status, quote_id, idem_key, host_keep, alloc, staff_id, history) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10,$11::jsonb,$12,$13::jsonb)",
        [id, o.tabId, o.payerId, params.mode === "mine" && params.forParticipantId && params.forParticipantId !== o.payerId ? params.forParticipantId : null, params.mode, o.method, frozen.amountCents, o.quoteId, o.idempotencyKey, !!o.hostKeep, JSON.stringify(frozen.alloc), o.asStaff ? (o.staffId ?? null) : null, JSON.stringify([{ at: new Date(this.now()).toISOString(), status: "reserved" }])],
      );
      try {
        for (const u of frozen.alloc.units) await client.query("INSERT INTO tab_claims (tab_id, line_id, idx, payment_id) VALUES ($1,$2,$3,$4)", [o.tabId, u.lineId, u.idx, id]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") { await client.query("ROLLBACK"); return fail(409, "already_being_paid", { message: "Someone else has just paid, or is paying, for part of this." }); }
        throw e;
      }
      await client.query("UPDATE tab_quotes SET used=true WHERE id=$1", [o.quoteId]);
      await client.query("UPDATE tabs SET version = version + 1 WHERE id=$1", [o.tabId]);
      await client.query("COMMIT");
      result = { paymentId: id, status: "reserved", amountCents: frozen.amountCents, method: o.method };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    const paymentId = result.paymentId as string;
    if (o.method === "credit") {
      if (!o.member) { await this.release(paymentId, "rejected", "a member must be signed in to pay with credit"); return fail(401, "sign_in_to_use_credit"); }
      // Frozen credit cannot be spent on a tab either.
      if (await creditBlockedFor(this.d.db, this.m, o.member.id)) { await this.release(paymentId, "rejected", "credit is frozen"); return fail(403, "credit_frozen"); }
      const spent = await spendCredit(this.d.db, { merchantId: this.m, customerId: o.member.id, amountCents: result.amountCents as number, idempotencyKey: `tab-pay:${paymentId}`, orderId: o.tabId, deviceId: "shop", outletId: (await this.tabOpen(o.tabId)).outletId, note: "Tab payment" });
      if (!spent.ok) { await this.release(paymentId, "rejected", "not enough credit"); return fail(409, "not_enough_credit", { balanceCents: spent.balanceCents, neededCents: result.amountCents }); }
      await this.complete(paymentId);
      result.status = "completed";
    } else if (o.asStaff) {
      await this.complete(paymentId); // staff recorded it (cash at the counter): it is a first-class payment, with the recorder's identity
      result.status = "completed";
    }
    return result;
  }

  /** The payment is confirmed. Records it, and settles the tab if nothing remains. Safe to call twice. */
  async complete(paymentId: string, providerRef?: string): Promise<void> {
    const r = (await this.d.db.query(
      `UPDATE tab_payments SET status='completed', completed_at=now(), updated_at=now(), provider_ref=COALESCE($2, provider_ref),
         history = history || jsonb_build_array(jsonb_build_object('at', now()::text, 'status', 'completed'))
       WHERE id=$1 AND status IN ('reserved','unknown') RETURNING tab_id`, [paymentId, providerRef ?? null])).rows[0];
    if (!r) return;
    await this.d.db.query("UPDATE tabs SET version = version + 1 WHERE id=$1", [r.tab_id]);
    await this.settleIfPaid(r.tab_id as string);
  }

  /** Cancel before completion, or a terminal rejection: the units and the amount are free again. A completed payment can never be released. */
  async release(paymentId: string, to: "cancelled" | "rejected", why?: string): Promise<boolean> {
    const client = await this.d.db.connect();
    try {
      await client.query("BEGIN");
      const p = (await client.query("SELECT tab_id FROM tab_payments WHERE id=$1", [paymentId])).rows[0];
      if (!p) { await client.query("ROLLBACK"); return false; }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tab/${p.tab_id}`]);
      const r = await client.query(
        `UPDATE tab_payments SET status=$2, updated_at=now(), note=COALESCE($3, note), history = history || jsonb_build_array(jsonb_build_object('at', now()::text, 'status', $2::text))
         WHERE id=$1 AND status IN ('reserved','unknown') RETURNING id`, [paymentId, to, why ?? null]);
      if (!r.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query("DELETE FROM tab_claims WHERE payment_id=$1", [paymentId]);
      await client.query("UPDATE tabs SET version = version + 1 WHERE id=$1", [p.tab_id]);
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** The outcome of an integrated attempt is not known (a timeout, a closed browser): it keeps its reservation and goes on the staff list. */
  async markUnknown(paymentId: string): Promise<boolean> {
    return ((await this.d.db.query("UPDATE tab_payments SET status='unknown', updated_at=now(), history = history || jsonb_build_array(jsonb_build_object('at', now()::text, 'status', 'unknown')) WHERE id=$1 AND status='reserved'", [paymentId])).rowCount ?? 0) > 0;
  }

  // ---- settlement and rewards -------------------------------------------------------------

  /** When nothing remains: the tab closes, and each person's reward is credited once. */
  async settleIfPaid(tabId: string): Promise<boolean> {
    const s = await this.snapshot(tabId);
    if (s.tab.status !== "open" || !s.rounds.length) return false;
    const whole = tabBill(s.lines, s.opts);
    const paid = s.payments.filter((p) => p.status === "completed").reduce((n, p) => n + p.amount_cents, 0);
    const outstanding = s.payments.some((p) => p.status === "reserved" || p.status === "unknown");
    if (whole.totalCents <= 0 || paid < whole.totalCents || outstanding) return false;
    const closed = (await this.d.db.query("UPDATE tabs SET status='closed', closed_at=now(), version=version+1 WHERE id=$1 AND status='open' RETURNING id", [tabId])).rows[0];
    if (!closed) return false;
    await this.creditRewards(s);
    await this.recordOnOrders(s);
    return true;
  }

  /**
   * D4: each person earns on what they actually paid, nothing until the whole tab is paid, and a payer may route a payment's reward to the Host.
   * Credited exactly once (the watermark); a person without an account has their earnings recorded on the tab; a guest who signed up and claimed
   * before settlement is credited into the new account.
   */
  private async creditRewards(s: Snapshot): Promise<void> {
    const mark = (await this.d.db.query("UPDATE tabs SET rewards_credited_at=now() WHERE id=$1 AND rewards_credited_at IS NULL RETURNING id", [s.tab.id])).rows[0];
    if (!mark) return;
    const cfg = this.d.config.rewards;
    const host = this.effectiveHost(s);
    const done = s.payments.filter((p) => p.status === "completed");
    const points = new Map<string, number>();
    if (cfg.pointsEnabled) for (const p of done) { const to = p.host_keep ? host : p.payer_id; points.set(to, (points.get(to) ?? 0) + Math.floor((p.amount_cents / 100) * cfg.earnPointsPerDollar)); }
    const note = `Tab rewards · ${s.tab.spot ?? "bar tab"}`;
    for (const [pid, pts] of points) {
      if (pts <= 0) continue;
      const who = s.people.find((x) => x.id === pid);
      const dest = who?.member_id ?? who?.claimed_by ?? null;
      if (dest && this.d.members) await this.d.members.post(dest, "earn", pts, `tab:${s.tab.id}:${pid}`, { note });
      else await this.d.db.query("INSERT INTO tab_entitlements (tab_id, participant_id, points) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [s.tab.id, pid, pts]);
    }
    // Stamps (X-2): the payer gets the stamp; if no single share qualifies, the Host consolidates and gets it if the whole tab qualifies. Counted once.
    const card = cfg.stampCard;
    if (card.enabled && this.d.members) {
      const byPayer = new Map<string, number>();
      for (const p of done) { const to = p.host_keep ? host : p.payer_id; byPayer.set(to, (byPayer.get(to) ?? 0) + p.amount_cents); }
      const qualifying = [...byPayer].filter(([, c]) => c > 0 && c >= card.minPaidCents).map(([id]) => id);
      const winners = qualifying.length ? qualifying : [...byPayer.values()].reduce((n, v) => n + v, 0) >= card.minPaidCents ? [host] : [];
      for (const pid of winners) {
        const who = s.people.find((x) => x.id === pid);
        const dest = who?.member_id ?? who?.claimed_by;
        if (dest) await this.d.members.stampOnce(dest, `tab:${s.tab.id}:${pid}`, card);
      }
    }
  }

  /** Reports and the order records stay whole: when the tab settles, each round order is marked paid by the Tab. */
  private async recordOnOrders(s: Snapshot): Promise<void> {
    for (const r of s.rounds) {
      if (!r.order || r.order.stage === "cancelled") continue;
      const total = orderTotals(r.order, this.d.config).total;
      const ts = this.now();
      try {
        await this.d.ingest([{ id: `tabpay-${s.tab.id}-${r.orderId}`, orderId: r.orderId, deviceId: "shop", ts, seq: 1_000_001, type: "PaymentRecorded", paymentId: `tab:${s.tab.id}`, method: "other", amountCents: total, confirmed: true } as unknown as OrderEvent], s.tab.outlet_id);
      } catch { /* the Tab is settled regardless; the order record can be reconciled */ }
    }
  }

  // ---- the waiter -------------------------------------------------------------------------

  /** Release payment for everything ordered so far. A round ordered after this starts locked again. */
  async release_(tabId: string): Promise<void> {
    await this.d.db.query("UPDATE tabs SET released_at=now(), version=version+1 WHERE id=$1 AND merchant_id=$2 AND status='open'", [tabId, this.m]);
  }

  async page(tabId: string, kind: "bill" | "help"): Promise<void> {
    await this.d.db.query("UPDATE tabs SET waiter_paged=true, paged_kind=$3, bill_requested = bill_requested OR $4, version=version+1 WHERE id=$1 AND merchant_id=$2 AND status='open' AND NOT waiter_paged", [tabId, this.m, kind, kind === "bill"]);
  }

  async resetPage(tabId: string): Promise<void> {
    await this.d.db.query("UPDATE tabs SET waiter_paged=false, paged_kind=NULL, bill_requested=false, version=version+1 WHERE id=$1 AND merchant_id=$2", [tabId, this.m]);
  }

  /** A guest who has signed up claims what they earned, before settlement. Verified ownership, single use. */
  async claimAsMember(participantId: string, memberId: string): Promise<boolean> {
    const r = await this.d.db.query(
      `UPDATE tab_participants p SET claimed_by=$2 FROM tabs t WHERE p.id=$1 AND p.tab_id=t.id AND t.status='open' AND p.member_id IS NULL AND p.claimed_by IS NULL RETURNING p.id`, [participantId, memberId]);
    return (r.rowCount ?? 0) > 0;
  }
}

export interface QuoteParams {
  mode: "mine" | "round" | "all" | "equal" | "custom";
  forParticipantId?: string;
  round?: number;
  people?: number;
  amountCents?: number;
  allocation?: "oldest_first" | "reduce_only";
}

/** The same settlement, compared field by field (the database does not keep a JSON object's key order). */
function sameAlloc(a: PaymentAlloc, b: PaymentAlloc): boolean {
  const num = (x: number) => x || 0; // -0 and 0 are the same amount
  return num(a.items) === num(b.items) && num(a.service) === num(b.service) && num(a.tax) === num(b.tax) && num(a.deposit) === num(b.deposit) && num(a.credit) === num(b.credit)
    && a.units.length === b.units.length && a.units.every((u, i) => u.lineId === b.units[i]!.lineId && u.idx === b.units[i]!.idx);
}

const whole = (s: Snapshot) => tabBill(s.lines, s.opts);
export { whole as wholeBill };
export type { TabQuote, PaymentAlloc };
void allocTotal;
