import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DisplayState } from "@pos/core";
import type { Db } from "./db/pool.js";
import { FailureLimiter } from "./rateLimit.js";

/**
 * Customer display on a separate device (backend: the boss's decision that the display runs as a PWA for shops without a dual-screen till).
 * The display page asks for a pairing and shows its short code; the till types the code once; from then on the till publishes what the customer
 * should see and the display reads it. The state is only what the customer is shown (items, totals, a payment QR), never anything private.
 */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_MINUTES = 15;
const MAX_STATE_BYTES = 32_000;
const MODES = ["idle", "sale", "pay", "thanks"];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n) : undefined);
const cents = (v: unknown) => (Number.isSafeInteger(v) && Math.abs(v as number) < 100_000_000 ? (v as number) : 0);

/** Only what the display draws is kept: known fields, clipped text, whole-number money. Anything else a client sends is dropped. */
export function cleanDisplayState(raw: unknown): DisplayState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.mode !== "string" || !MODES.includes(r.mode)) return null;
  const lines = (Array.isArray(r.lines) ? r.lines.slice(0, 60) : []).map((l: any) => ({
    qty: Math.max(0, Math.min(999, Number.isInteger(l?.qty) ? l.qty : 0)),
    name: clip(l?.name, 80) ?? "",
    details: (Array.isArray(l?.details) ? l.details.slice(0, 20) : []).map((d: unknown) => clip(d, 80) ?? "").filter(Boolean),
    lineCents: cents(l?.lineCents),
    ...(l?.deposit ? { deposit: true } : {}),
  }));
  const totals = (Array.isArray(r.totals) ? r.totals.slice(0, 12) : []).map((t: any) => ({ key: clip(t?.key, 20) ?? "", label: clip(t?.label, 40) ?? "", cents: cents(t?.cents), ...(t?.negative ? { negative: true } : {}) }));
  const out: DisplayState = { mode: r.mode as DisplayState["mode"], lines, totals, totalCents: cents(r.totalCents) };
  const orderType = clip(r.orderType, 30); if (orderType) out.orderType = orderType;
  const orderNo = clip(r.orderNo, 20); if (orderNo) out.orderNo = orderNo;
  const imageUrl = clip(r.imageUrl, 500); if (imageUrl && /^(https?:\/\/|\/)/.test(imageUrl)) out.imageUrl = imageUrl;
  const qrText = clip(r.qrText, 600); if (qrText) out.qrText = qrText;
  if (typeof r.qrImage === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]{1,20000}$/.test(r.qrImage)) out.qrImage = r.qrImage;
  if (r.demo) out.demo = true;
  return JSON.stringify(out).length > MAX_STATE_BYTES ? null : out;
}

export function registerDisplay(app: FastifyInstance, d: { db: Db; merchantId: string; needsDevice: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const startLimit = new FailureLimiter(60, 10 * 60_000);
  const pollLimit = new FailureLimiter(6000, 10 * 60_000);
  const linkLimit = new FailureLimiter(30, 10 * 60_000);
  const limited = (lim: FailureLimiter, req: FastifyRequest, reply: FastifyReply) => {
    if (lim.blocked(req.ip)) { void reply.code(429).send({ error: "too_many_requests" }); return true; }
    lim.fail(req.ip); // counts every call, so this caps requests per address in the window
    return false;
  };

  const newCode = async (): Promise<string> => {
    for (let i = 0; i < 20; i++) {
      const code = Array.from(randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
      const taken = await d.db.query("SELECT 1 FROM display_screens WHERE merchant_id=$1 AND code=$2", [d.merchantId, code]);
      if (!taken.rowCount) return code;
    }
    throw new Error("could not make a pairing code");
  };

  /** A new display asks for a pairing. It keeps the secret; the code is for the till. */
  app.post("/api/display/pair", async (req, reply) => {
    if (limited(startLimit, req, reply)) return;
    await d.db.query("DELETE FROM display_screens WHERE merchant_id=$1 AND till_device_id IS NULL AND created_at < now() - make_interval(mins => $2)", [d.merchantId, CODE_MINUTES]);
    const secret = randomBytes(24).toString("base64url");
    const code = await newCode();
    await d.db.query("INSERT INTO display_screens (merchant_id, secret_hash, code) VALUES ($1,$2,$3)", [d.merchantId, hash(secret), code]);
    return { secret, code, expiresInSeconds: CODE_MINUTES * 60 };
  });

  /** The display polls with its secret. `since` is the updatedAt it already has, so an unchanged state costs a few bytes. */
  app.get<{ Querystring: { since?: string } }>("/api/display/state", async (req, reply) => {
    if (limited(pollLimit, req, reply)) return;
    const secret = String(req.headers["x-display-secret"] ?? "");
    if (!secret) return reply.code(401).send({ error: "no_secret" });
    const s = (await d.db.query("UPDATE display_screens SET last_seen=now() WHERE secret_hash=$1 AND merchant_id=$2 RETURNING id, code, till_device_id", [hash(secret), d.merchantId])).rows[0];
    if (!s) return reply.code(404).send({ error: "unknown_screen" }); // never paired, or its code expired: the page starts again
    if (!s.till_device_id) return { linked: false, code: s.code };
    const st = (await d.db.query("SELECT state, updated_at FROM display_state WHERE merchant_id=$1 AND till_device_id=$2", [d.merchantId, s.till_device_id])).rows[0];
    const updatedAt = st ? new Date(st.updated_at).getTime() : 0;
    if (req.query.since && Number(req.query.since) === updatedAt) return { linked: true, unchanged: true, updatedAt };
    return { linked: true, updatedAt, state: st?.state ?? null };
  });

  /** A till types the code the display is showing. The display is then tied to this till. */
  app.post<{ Body: { code?: string } }>("/api/display/link", { preHandler: d.needsDevice }, async (req, reply) => {
    if (limited(linkLimit, req, reply)) return;
    const code = String(req.body?.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) return reply.code(400).send({ error: "code_looks_wrong" });
    const r = await d.db.query(
      `UPDATE display_screens SET till_device_id=$3, linked_at=now(), code=NULL
       WHERE merchant_id=$1 AND code=$2 AND till_device_id IS NULL AND created_at > now() - make_interval(mins => $4) RETURNING id`,
      [d.merchantId, code, req.device!.id, CODE_MINUTES],
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "code_not_found" });
    return { ok: true, screenId: r.rows[0].id };
  });

  /** The screens linked to this till. */
  app.get("/api/display/screens", { preHandler: d.needsDevice }, async (req) => {
    const r = await d.db.query("SELECT id, linked_at, last_seen FROM display_screens WHERE merchant_id=$1 AND till_device_id=$2 ORDER BY linked_at", [d.merchantId, req.device!.id]);
    return { screens: r.rows.map((x) => ({ id: x.id, linkedAt: x.linked_at, lastSeen: x.last_seen })) };
  });

  app.delete<{ Params: { id: string } }>("/api/display/screens/:id", { preHandler: d.needsDevice }, async (req, reply) => {
    const r = await d.db.query("DELETE FROM display_screens WHERE merchant_id=$1 AND id=$2 AND till_device_id=$3", [d.merchantId, req.params.id, req.device!.id]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "screen_not_found" });
  });

  /** The till says what the customer should see. Latest wins. */
  app.put<{ Body: { state?: unknown } }>("/api/display/state", { preHandler: d.needsDevice }, async (req, reply) => {
    const state = cleanDisplayState(req.body?.state);
    if (!state) return reply.code(400).send({ error: "bad_display_state" });
    const r = await d.db.query(
      `INSERT INTO display_state (merchant_id, till_device_id, state) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (merchant_id, till_device_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now() RETURNING updated_at`,
      [d.merchantId, req.device!.id, JSON.stringify(state)],
    );
    return { ok: true, updatedAt: new Date(r.rows[0].updated_at).getTime() };
  });
}
