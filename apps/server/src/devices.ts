import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db/pool.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const ENROLLMENT_MINUTES = 15;
// No 0/O/1/I/L: a code read aloud or typed from a screen should not be ambiguous.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface Device {
  id: string;
  merchantId: string;
  outletId: string;
  name: string;
}

const toDevice = (r: Record<string, unknown>): Device => ({
  id: r.id as string,
  merchantId: r.merchant_id as string,
  outletId: r.outlet_id as string,
  name: r.name as string,
});

const newCode = () =>
  Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** A manager or owner creates a one-time code and types or shows it on the new device. */
export async function createEnrollmentCode(
  db: Db,
  i: { merchantId: string; outletId: string; createdBy: string | null; deviceId?: string },
): Promise<{ code: string; expiresAt: Date }> {
  const code = newCode();
  const expiresAt = new Date(Date.now() + ENROLLMENT_MINUTES * 60_000);
  await db.query(
    "INSERT INTO enrollment_codes (code_hash, merchant_id, outlet_id, device_id, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [sha256(code), i.merchantId, i.outletId, i.deviceId ?? null, i.createdBy, expiresAt],
  );
  return { code, expiresAt };
}

/**
 * Trade a valid code for a device token. The code is consumed in the same statement that checks it,
 * so two devices racing with one code cannot both succeed.
 */
export async function enroll(db: Db, merchantId: string, code: string, name: string): Promise<{ token: string; device: Device; enrolledBy: string | null } | null> {
  const used = await db.query(
    `UPDATE enrollment_codes SET used_at = now()
     WHERE code_hash=$1 AND merchant_id=$2 AND used_at IS NULL AND expires_at > now()
     RETURNING outlet_id, device_id, created_by`,
    [sha256(code.toUpperCase().trim()), merchantId],
  );
  const c = used.rows[0];
  if (!c) return null;
  const token = randomBytes(32).toString("base64url");
  if (c.device_id) {
    // Re-issue for an existing device: same id (so its queued events still match), new token, old one dead.
    const r = await db.query("UPDATE devices SET token_hash=$2, active=true, name=$3 WHERE id=$1 RETURNING *", [c.device_id, sha256(token), name]);
    return r.rows[0] ? { token, device: toDevice(r.rows[0]), enrolledBy: c.created_by } : null;
  }
  const r = await db.query(
    "INSERT INTO devices (merchant_id, outlet_id, name, token_hash, enrolled_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [merchantId, c.outlet_id, name, sha256(token), c.created_by],
  );
  return { token, device: toDevice(r.rows[0]), enrolledBy: c.created_by };
}

/**
 * A device made without an enrollment code, for a browser opened from a one-time Telegram link. Older devices made the same way
 * for the same person are switched off, so there is one at a time and no pile of them.
 */
export async function createLinkedDevice(db: Db, merchantId: string, outletId: string, name: string, enrolledBy: string): Promise<{ token: string; device: Device }> {
  await db.query("UPDATE devices SET active=false WHERE merchant_id=$1 AND name=$2 AND enrolled_by=$3 AND active", [merchantId, name, enrolledBy]);
  const token = randomBytes(32).toString("base64url");
  const r = await db.query("INSERT INTO devices (merchant_id, outlet_id, name, token_hash, enrolled_by) VALUES ($1,$2,$3,$4,$5) RETURNING *", [merchantId, outletId, name, sha256(token), enrolledBy]);
  return { token, device: toDevice(r.rows[0]) };
}

export async function authenticateDevice(db: Db, token: string | undefined): Promise<Device | null> {
  if (!token) return null;
  const r = await db.query(
    "UPDATE devices SET last_seen_at = now() WHERE token_hash=$1 AND active RETURNING *",
    [sha256(token)],
  );
  return r.rows[0] ? toDevice(r.rows[0]) : null;
}

export async function listDevices(db: Db, merchantId: string) {
  const r = await db.query(
    "SELECT id, name, outlet_id, active, created_at, last_seen_at, last_print_poll_at FROM devices WHERE merchant_id=$1 ORDER BY created_at",
    [merchantId],
  );
  return r.rows;
}

/** A device asking for print jobs is a print hub that is alive. */
export const markPrintPoll = (db: Db, deviceId: string) => db.query("UPDATE devices SET last_print_poll_at = now() WHERE id=$1", [deviceId]).then(() => undefined);

export async function revokeDevice(db: Db, merchantId: string, deviceId: string): Promise<boolean> {
  const r = await db.query("UPDATE devices SET active=false WHERE id=$1 AND merchant_id=$2 AND active", [deviceId, merchantId]);
  return (r.rowCount ?? 0) > 0;
}

// ---- short-lived stream tickets ---------------------------------------------------------------
// EventSource cannot send headers, and tokens in URLs end up in logs. So a device first asks for a
// one-time ticket (valid ~30 s) with its real token, and opens the stream with that instead.

const TICKET_SECONDS = 30;
const tickets = new Map<string, { device: Device; expires: number }>();

export function issueStreamTicket(device: Device): string {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  const ticket = randomBytes(18).toString("base64url");
  tickets.set(ticket, { device, expires: now + TICKET_SECONDS * 1000 });
  return ticket;
}

export function redeemStreamTicket(ticket: string | undefined): Device | null {
  if (!ticket) return null;
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  return t && t.expires > Date.now() ? t.device : null;
}
