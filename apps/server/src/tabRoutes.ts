import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "./auth.js";
import { audit } from "./auth.js";
import type { Db } from "./db/pool.js";
import type { Member, MemberStore } from "./members.js";
import { FailureLimiter } from "./rateLimit.js";
import { TabError, type QuoteParams, type TabService } from "./tabs.js";

/** The Tab routes. Customers act with their tab credential (participant id and token together); staff with a staff session on an enrolled device. */
export function registerTabRoutes(app: FastifyInstance, d: {
  db: Db; merchantId: string; tabs: TabService; members?: MemberStore;
  needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  outletIds: () => Promise<string[]>;
}) {
  const joinLimit = new FailureLimiter(60, 10 * 60_000);
  const actLimit = new FailureLimiter(1200, 10 * 60_000);
  const limited = (lim: FailureLimiter, req: FastifyRequest, reply: FastifyReply) => {
    if (lim.blocked(req.ip)) { void reply.code(429).send({ error: "too_many_requests" }); return true; }
    lim.fail(req.ip);
    return false;
  };
  const bearer = (req: FastifyRequest) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || undefined;
  const memberOf = async (req: FastifyRequest): Promise<Member | null> => (d.members ? d.members.fromToken(bearer(req)) : null);
  /** Run a handler, turning a TabError into its answer. */
  const guard = <T>(fn: () => Promise<T>, reply: FastifyReply) => fn().catch((e) => {
    if (e instanceof TabError) return reply.code(e.status).send(e.body);
    throw e;
  });
  const creds = (req: FastifyRequest) => ({ participantId: req.headers["x-tab-participant"], token: req.headers["x-tab-token"] });
  const me = async (req: FastifyRequest) => { const c = creds(req); return d.tabs.authenticate(c.participantId, c.token); };

  // ---- customers --------------------------------------------------------------------------

  /** Whether this outlet runs table service with a shared tab, so the phone knows what to offer. Public. */
  app.get<{ Querystring: { outlet?: string } }>("/api/shop/tab/settings", async (req) => {
    const outlets = await d.outletIds();
    const id = req.query.outlet && outlets.includes(req.query.outlet) ? req.query.outlet : outlets[0] ?? "";
    const s = await d.tabs.outletSettings(id);
    return { outletId: id, tabService: s.tabService };
  });

  app.post<{ Body: { outletId?: string; table?: string; code?: string; displayName?: string; participantId?: string; token?: string } }>("/api/shop/tab/join", async (req, reply) => {
    if (limited(joinLimit, req, reply)) return;
    return guard(async () => {
      const b = req.body ?? {};
      const outlets = await d.outletIds();
      const outletId = b.outletId && outlets.includes(b.outletId) ? b.outletId : outlets[0] ?? "";
      if (!(await d.tabs.outletSettings(outletId)).tabService) return reply.code(400).send({ error: "this_outlet_has_no_tabs" });
      const member = await memberOf(req);
      const r = await d.tabs.join({ outletId, spot: typeof b.table === "string" ? b.table : undefined, code: typeof b.code === "string" ? b.code : undefined, displayName: b.displayName, member, existing: b.participantId && b.token ? { participantId: b.participantId, token: b.token } : undefined });
      return { tabId: r.tabId, participantId: r.participantId, token: r.token, isHost: r.hostId === r.participantId, created: r.created, tab: await d.tabs.view(r.tabId, r.participantId) };
    }, reply);
  });

  app.get("/api/shop/tab", async (req, reply) => {
    if (limited(actLimit, req, reply)) return;
    return guard(async () => { const { person, tabId } = await me(req); return d.tabs.view(tabId, person.id); }, reply);
  });

  app.post("/api/shop/tab/leave", async (req, reply) => guard(async () => { const { person } = await me(req); await d.tabs.leave(person.id); return { ok: true }; }, reply));

  app.post<{ Params: { lineId: string }; Body: { with?: string[] } }>("/api/shop/tab/lines/:lineId/share", async (req, reply) => guard(async () => {
    const { tabId } = await me(req);
    if (!Array.isArray(req.body?.with)) return reply.code(400).send({ error: "with is a list of people" });
    await d.tabs.shareLine(tabId, req.params.lineId, req.body!.with!.map(String));
    return { ok: true };
  }, reply));

  /** The maths of a payment, frozen. Nothing is reserved yet. */
  app.post<{ Body: QuoteParams }>("/api/shop/tab/quote", async (req, reply) => {
    if (limited(actLimit, req, reply)) return;
    return guard(async () => { const { person, tabId } = await me(req); return d.tabs.quote(tabId, person.id, { ...(req.body ?? {}) } as QuoteParams); }, reply);
  });

  /**
   * Pay against a quote. The payer is whoever holds the tab credential (and, for credit, the signed-in member): nothing in the body can name another payer.
   */
  app.post<{ Body: { quoteId?: string; method?: string; idempotencyKey?: string; hostKeep?: boolean } & Record<string, unknown> }>("/api/shop/tab/pay", async (req, reply) => {
    if (limited(actLimit, req, reply)) return;
    return guard(async () => {
      const { person, tabId } = await me(req);
      const b = req.body ?? {};
      // The prototype's "{person} pays - simulate his phone" does not exist here: any attempt to name another payer is refused.
      if ("payerId" in b || "payer" in b || "simulateFor" in b || "asPerson" in b) return reply.code(400).send({ error: "payer_is_the_session_identity" });
      const member = await memberOf(req);
      if (member && person.member_id && person.member_id !== member.id) return reply.code(403).send({ error: "not_your_tab_identity" });
      return d.tabs.pay({ tabId, payerId: person.id, quoteId: String(b.quoteId ?? ""), method: String(b.method ?? ""), idempotencyKey: String(b.idempotencyKey ?? ""), hostKeep: b.hostKeep === true, member: person.member_id ? member : null });
    }, reply);
  });

  app.post<{ Params: { id: string } }>("/api/shop/tab/payments/:id/cancel", async (req, reply) => guard(async () => {
    const { person, tabId } = await me(req);
    const p = (await d.db.query("SELECT payer_id, status FROM tab_payments WHERE id=$1 AND tab_id=$2", [req.params.id, tabId])).rows[0];
    if (!p || p.payer_id !== person.id) return reply.code(404).send({ error: "payment_not_found" });
    if (p.status === "completed") return reply.code(409).send({ error: "already_paid" });
    return { ok: await d.tabs.release(req.params.id, "cancelled", "cancelled by the payer") };
  }, reply));

  /** "Request the bill" or "Call waiter for help". Once paged, re-taps do nothing; only staff reset it. */
  app.post<{ Body: { kind?: string } }>("/api/shop/tab/page", async (req, reply) => guard(async () => {
    const { tabId } = await me(req);
    const kind = req.body?.kind === "bill" ? "bill" : req.body?.kind === "help" ? "help" : null;
    if (!kind) return reply.code(400).send({ error: "kind is bill or help" });
    await d.tabs.page(tabId, kind);
    return { ok: true };
  }, reply));

  /** A guest who has signed up claims what they earned on this tab. Needs the tab credential AND the signed-in member; single use. */
  app.post("/api/shop/tab/claim", async (req, reply) => guard(async () => {
    const { person } = await me(req);
    const member = await memberOf(req);
    if (!member) return reply.code(401).send({ error: "sign_in_to_claim" });
    const ok = await d.tabs.claimAsMember(person.id, member.id);
    return ok ? { ok: true } : reply.code(409).send({ error: "nothing_to_claim_or_already_claimed" });
  }, reply));

  // ---- staff ------------------------------------------------------------------------------

  const staff = { preHandler: d.needs("wallet.spend") };

  app.get<{ Querystring: { outlet?: string } }>("/api/tabs", staff, async (req) => {
    const r = await d.db.query(
      `SELECT t.id, t.spot, t.code, t.outlet_id, t.released_at, t.bill_requested, t.waiter_paged, t.paged_kind, t.opened_at,
              (SELECT count(*) FROM tab_participants p WHERE p.tab_id=t.id AND p.left_at IS NULL)::int AS people
       FROM tabs t WHERE t.merchant_id=$1 AND t.status='open' AND ($2::text IS NULL OR t.outlet_id=$2) ORDER BY t.opened_at`, [d.merchantId, req.query.outlet ?? null]);
    const out = [];
    for (const t of r.rows) { const v = (await d.tabs.view(t.id, "")) as { totals: { totalCents: number; paidCents: number; remainingCents: number }; paymentLocked: boolean }; out.push({ id: t.id, spot: t.spot, code: t.code, outletId: t.outlet_id, people: t.people, released: !!t.released_at, billRequested: t.bill_requested, waiterPaged: t.waiter_paged, pagedKind: t.paged_kind, openedAt: t.opened_at, ...v.totals, locked: v.paymentLocked }); }
    return { tabs: out };
  });

  app.get<{ Params: { id: string } }>("/api/tabs/:id", staff, async (req, reply) => guard(() => d.tabs.view(req.params.id, ""), reply));

  /** The waiter releases payment for the table. A round ordered after this starts locked again. */
  app.post<{ Params: { id: string } }>("/api/tabs/:id/release", staff, async (req, reply) => guard(async () => {
    await d.tabs.release_(req.params.id);
    await audit(d.db, d.merchantId, req.staff!.id, "tab.release", { tab: req.params.id });
    return { ok: true };
  }, reply));

  app.post<{ Params: { id: string } }>("/api/tabs/:id/reset-page", staff, async (req, reply) => guard(async () => {
    await d.tabs.resetPage(req.params.id);
    await audit(d.db, d.merchantId, req.staff!.id, "tab.reset_page", { tab: req.params.id });
    return { ok: true };
  }, reply));

  /** Cash at the counter is a first-class tab payment: the recorder's identity and the time are kept, and the payer is the person who paid. */
  app.post<{ Params: { id: string }; Body: QuoteParams & { participantId?: string; idempotencyKey?: string } }>("/api/tabs/:id/payments", staff, async (req, reply) => guard(async () => {
    const b = req.body ?? ({} as never);
    const s = await d.tabs.snapshot(req.params.id);
    const payer = s.people.find((p) => p.id === b.participantId) ?? s.people.find((p) => p.id === s.tab.host_id) ?? s.people[0];
    if (!payer) return reply.code(400).send({ error: "nobody_on_this_tab" });
    const q = (await d.tabs.quote(req.params.id, payer.id, { mode: b.mode, forParticipantId: b.forParticipantId, round: b.round, people: b.people, amountCents: b.amountCents })) as { quoteId: string };
    const r = await d.tabs.pay({ tabId: req.params.id, payerId: payer.id, quoteId: q.quoteId, method: "cash", idempotencyKey: String(b.idempotencyKey ?? `staff-${q.quoteId.slice(0, 8)}-${Date.now()}`), asStaff: true, staffId: req.staff!.id });
    await audit(d.db, d.merchantId, req.staff!.id, "tab.cash_payment", { tab: req.params.id, payer: payer.id, amountCents: r.amountCents });
    return r;
  }, reply));

  /** A customer chose "pay at the counter": staff confirm they have been paid. */
  app.post<{ Params: { id: string } }>("/api/tabs/payments/:id/confirm", staff, async (req, reply) => guard(async () => {
    const p = (await d.db.query("SELECT status, method FROM tab_payments WHERE id=$1 AND tab_id IN (SELECT id FROM tabs WHERE merchant_id=$2)", [req.params.id, d.merchantId])).rows[0];
    if (!p) return reply.code(404).send({ error: "payment_not_found" });
    if (p.status !== "reserved") return reply.code(409).send({ error: "not_waiting_to_be_confirmed" });
    await d.db.query("UPDATE tab_payments SET staff_id=$2 WHERE id=$1", [req.params.id, req.staff!.id]);
    await d.tabs.complete(req.params.id);
    await audit(d.db, d.merchantId, req.staff!.id, "tab.payment_confirmed", { payment: req.params.id });
    return { ok: true };
  }, reply));

  /** Payments whose outcome is not known, with amount, party, reference and age, for staff to resolve from evidence (Addendum 4.3). */
  app.get("/api/tabs/reconciliation", staff, async () => {
    const r = await d.db.query(
      `SELECT p.id, p.tab_id, p.amount_cents, p.method, p.provider_ref, p.created_at, t.spot, pp.display_name AS payer
       FROM tab_payments p JOIN tabs t ON t.id=p.tab_id LEFT JOIN tab_participants pp ON pp.id=p.payer_id
       WHERE t.merchant_id=$1 AND p.status='unknown' ORDER BY p.created_at`, [d.merchantId]);
    return { payments: r.rows.map((x) => ({ id: x.id, tabId: x.tab_id, table: x.spot, party: x.payer, amountCents: x.amount_cents, method: x.method, providerRef: x.provider_ref, ageSeconds: Math.round((Date.now() - new Date(x.created_at).getTime()) / 1000) })) };
  });

  app.post<{ Params: { id: string }; Body: { outcome?: string; evidence?: string } }>("/api/tabs/payments/:id/resolve", staff, async (req, reply) => guard(async () => {
    const outcome = req.body?.outcome;
    const evidence = String(req.body?.evidence ?? "").trim();
    if ((outcome !== "completed" && outcome !== "rejected") || evidence.length < 3) return reply.code(400).send({ error: "outcome is completed or rejected, with the evidence you checked" });
    const p = (await d.db.query("SELECT status FROM tab_payments WHERE id=$1 AND tab_id IN (SELECT id FROM tabs WHERE merchant_id=$2)", [req.params.id, d.merchantId])).rows[0];
    if (!p) return reply.code(404).send({ error: "payment_not_found" });
    if (p.status !== "unknown") return reply.code(409).send({ error: "not_unknown" });
    await d.db.query("UPDATE tab_payments SET note=$2, staff_id=$3 WHERE id=$1", [req.params.id, evidence.slice(0, 300), req.staff!.id]);
    if (outcome === "completed") await d.tabs.complete(req.params.id); else await d.tabs.release(req.params.id, "rejected", evidence);
    await audit(d.db, d.merchantId, req.staff!.id, "tab.payment_resolved", { payment: req.params.id, outcome, evidence });
    return { ok: true };
  }, reply));

  /** Closing a tab that is not fully paid needs staff, with the reason logged. It is never closed or charged automatically. */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/tabs/:id/close", staff, async (req, reply) => guard(async () => {
    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 3) return reply.code(400).send({ error: "a_reason_is_required" });
    const r = await d.db.query("UPDATE tabs SET status='closed', closed_at=now(), closed_reason=$3, version=version+1 WHERE id=$1 AND merchant_id=$2 AND status='open' RETURNING id", [req.params.id, d.merchantId, reason.slice(0, 200)]);
    if (!r.rowCount) return reply.code(404).send({ error: "no_open_tab" });
    await d.db.query("UPDATE tab_payments SET status='cancelled', updated_at=now() WHERE tab_id=$1 AND status='reserved'", [req.params.id]);
    await d.db.query("DELETE FROM tab_claims WHERE payment_id IN (SELECT id FROM tab_payments WHERE tab_id=$1 AND status='cancelled')", [req.params.id]);
    await audit(d.db, d.merchantId, req.staff!.id, "tab.close", { tab: req.params.id, reason });
    return { ok: true };
  }, reply));

  // ---- settings ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/outlets/:id/tab-settings", { preHandler: d.needs("device.manage") }, async (req) => d.tabs.outletSettings(req.params.id));
  app.put<{ Params: { id: string }; Body: { tabService?: boolean; allocation?: string } }>("/api/outlets/:id/tab-settings", { preHandler: d.needs("device.manage") }, async (req, reply) => guard(async () => {
    if (!(await d.outletIds()).includes(req.params.id)) return reply.code(404).send({ error: "outlet_not_found" });
    await d.tabs.saveOutletSettings(req.params.id, req.body ?? {});
    await audit(d.db, d.merchantId, req.staff!.id, "outlet.tab_settings", { outlet: req.params.id, ...(req.body ?? {}) });
    return d.tabs.outletSettings(req.params.id);
  }, reply));
}
