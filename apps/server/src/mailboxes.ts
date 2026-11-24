import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, type Permission } from "./auth.js";
import type { Db } from "./db/pool.js";
import { ImapMailbox, realImap, type ImapFactory } from "./imapMailbox.js";
import { GmailMailbox, type AlertMailbox } from "./paynowMatcher.js";
import { loadPaynow } from "./paynow.js";
import { secretKey, seal, unseal } from "./secrets.js";

export interface MailboxRow { id: string; label: string; kind: "imap" | "gmail"; host: string | null; port: number | null; username: string | null; lastOkAt: number | null; lastError: string | null }

const IMAP_PORTS = [993, 143];

/** The server must never be pointed at the shop's own network or at itself: only real, public mail servers. */
export function hostProblem(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]{1,251}[a-z0-9])$/.test(h) || !h.includes(".")) return "That is not a mail server address (for example imap.gmail.com).";
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return "That address is not a public mail server.";
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return "That address is not a public mail server.";
  }
  return null;
}

const toRow = (r: Record<string, any>): MailboxRow => ({ id: r.id, label: r.label, kind: r.kind, host: r.host, port: r.port, username: r.username, lastOkAt: r.last_ok_at ? new Date(r.last_ok_at).getTime() : null, lastError: r.last_error ?? null });

export async function listMailboxes(db: Db, merchantId: string): Promise<MailboxRow[]> {
  return (await db.query("SELECT id, label, kind, host, port, username, last_ok_at, last_error FROM mailboxes WHERE merchant_id=$1 ORDER BY created_at", [merchantId])).rows.map(toRow);
}

/** A working mailbox reader for one saved mailbox, or null when its secret cannot be opened (no key, or the key changed). */
export async function openMailbox(db: Db, merchantId: string, id: string, factory: ImapFactory = realImap, env: NodeJS.ProcessEnv = process.env): Promise<AlertMailbox | null> {
  const key = secretKey(env);
  const r = (await db.query("SELECT kind, host, port, username, secret_enc FROM mailboxes WHERE merchant_id=$1 AND id=$2", [merchantId, id])).rows[0];
  if (!key || !r) return null;
  const secret = unseal(r.secret_enc, key);
  if (secret === null) return null;
  if (r.kind === "imap") return new ImapMailbox({ host: r.host, port: r.port, user: r.username, pass: secret }, factory);
  try { const g = JSON.parse(secret) as { clientId: string; clientSecret: string; refreshToken: string }; return new GmailMailbox(g); } catch { return null; }
}

/** What a failed connection says, with nothing from the server's own message that could carry a password. */
export function plainProblem(e: unknown): string {
  const m = String((e as { message?: string; code?: string })?.message ?? e).toLowerCase();
  const code = String((e as { code?: string })?.code ?? "").toLowerCase();
  if ((e as { authenticationFailed?: boolean })?.authenticationFailed === true || String((e as { serverResponseCode?: string })?.serverResponseCode ?? "").toUpperCase() === "AUTHENTICATIONFAILED" || m.includes("authentication") || m.includes("invalid credentials") || m.includes("login") || m.includes("refused (4")) return "The mailbox refused the username or password. With Gmail, use an app password (Google account, Security, 2-Step Verification, App passwords).";
  if (code === "enotfound" || m.includes("enotfound") || m.includes("getaddrinfo")) return "Could not find that mail server. Check the address.";
  if (m.includes("timeout") || m.includes("timed out") || code === "etimedout") return "The mail server did not answer in time. Check the address and port.";
  if (code === "econnrefused" || m.includes("econnrefused")) return "The mail server refused the connection. Check the port (993 is usual).";
  return "Could not read the mailbox. Check the details and try again.";
}

export interface MailboxInput { label: string; kind?: "imap" | "gmail"; host?: string; port?: number; username: string; password?: string; clientId?: string; clientSecret?: string; refreshToken?: string }

/**
 * Add a PayNow alert mailbox. This is done by us, not by merchants: the mailbox is one we create (Gmail, Outlook or another provider) or one a
 * merchant gives us on their own company domain, dedicated to PayNow alerts. Merchants never type a mailbox password into the system, so none of
 * theirs is ours to leak. Run from the server (cli.ts add-mailbox); the password is sealed with SECRETS_KEY and never shown again.
 */
export async function addMailbox(db: Db, merchantId: string, b: MailboxInput, env: NodeJS.ProcessEnv = process.env): Promise<MailboxRow> {
  const key = secretKey(env);
  if (!key) throw new Error("SECRETS_KEY is not set (32 bytes as 64 hex characters), so a mailbox password cannot be kept safely.");
  const label = String(b.label ?? "").trim().slice(0, 60);
  const username = String(b.username ?? "").trim().slice(0, 120);
  if (!label || !username) throw new Error("A mailbox needs a name and its email address.");
  const kind = b.kind === "gmail" ? "gmail" : "imap";
  let host: string | null = null, port: number | null = null, secret: string;
  if (kind === "imap") {
    host = String(b.host ?? "").trim().toLowerCase();
    port = Number(b.port ?? 993);
    const bad = hostProblem(host);
    if (bad) throw new Error(bad);
    if (!IMAP_PORTS.includes(port)) throw new Error("Use port 993 (or 143).");
    if (!b.password || b.password.length > 200) throw new Error("A password (an app password for Gmail) is needed.");
    secret = b.password;
  } else {
    if (!b.clientId || !b.clientSecret || !b.refreshToken) throw new Error("A Gmail login needs a client id, client secret and refresh token.");
    secret = JSON.stringify({ clientId: b.clientId, clientSecret: b.clientSecret, refreshToken: b.refreshToken });
  }
  const r = await db.query("INSERT INTO mailboxes (merchant_id, label, kind, host, port, username, secret_enc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, label, kind, host, port, username, last_ok_at, last_error", [merchantId, label, kind, host, port, username, seal(secret, key)]);
  await audit(db, merchantId, null, "settings.mailbox_added", { label, kind, host, username, by: "operator" });
  return toRow(r.rows[0]);
}

export async function removeMailbox(db: Db, merchantId: string, id: string): Promise<boolean> {
  const r = await db.query("DELETE FROM mailboxes WHERE merchant_id=$1 AND id=$2", [merchantId, id]);
  if (r.rowCount) await audit(db, merchantId, null, "settings.mailbox_removed", { id, by: "operator" });
  return !!r.rowCount;
}

/**
 * What a merchant sees: the mailboxes we set up for them (the address their bank should send alerts to, and whether it is working), and a way to
 * test one. They cannot add, change or remove one: that is ours to do, so their own mailbox secrets never pass through here.
 */
export function registerMailboxes(app: FastifyInstance, d: { db: Db; merchantId: string; needs: (p: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; imapFactory?: ImapFactory; now?: () => number }) {
  const { db, merchantId, needs } = d;

  app.get("/api/settings/mailboxes", { preHandler: needs("staff.manage") }, async () => ({ mailboxes: await listMailboxes(db, merchantId) }));

  /** Connect to the mailbox and look for the bank's alerts of the last three days. Says plainly what is wrong when it cannot. */
  app.post<{ Params: { id: string }; Body: { sender?: string } }>("/api/settings/mailboxes/:id/test", { preHandler: needs("staff.manage") }, async (req, reply) => {
    const mb = await openMailbox(db, merchantId, req.params.id, d.imapFactory);
    if (!mb) return reply.code(secretKey() ? 404 : 409).send({ error: secretKey() ? "not_found_or_unreadable" : "secrets_key_missing" });
    const sender = String(req.body?.sender ?? "").trim().toLowerCase() || (await loadPaynow(db, merchantId))?.alertSender || "alert";
    const t = (d.now ?? Date.now)();
    try {
      const found = (await mb.fetch({ sender, afterMs: t - 3 * 86_400_000 })).length;
      await db.query("UPDATE mailboxes SET last_ok_at=now(), last_error=NULL WHERE merchant_id=$1 AND id=$2", [merchantId, req.params.id]);
      return { ok: true, found, sender };
    } catch (e) {
      const message = plainProblem(e);
      await db.query("UPDATE mailboxes SET last_error=$3 WHERE merchant_id=$1 AND id=$2", [merchantId, req.params.id, message]);
      return { ok: false, error: message };
    }
  });
}
