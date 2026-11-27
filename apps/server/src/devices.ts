import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db/pool.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const ENROLLMENT_MINUTES = 15;
export const TESTING_CODE_MINUTES = 240;
export const TESTING_CODE_USES = 25;
// A code for an app-store reviewer: reviewers cannot ask for a fresh one and may look days later, so it lasts weeks and takes many
// devices. Made only for a dedicated review outlet (never a real shop) and ended as soon as the review is over.
export const REVIEWER_CODE_DAYS = 60;
export const REVIEWER_CODE_USES = 200;
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
  i: { merchantId: string; outletId: string; createdBy: string | null; deviceId?: string; testing?: boolean; reviewer?: boolean },
): Promise<{ code: string; expiresAt: Date; maxUses: number }> {
  const code = newCode();
  // A testing code enrols many devices over a few hours, for setting up lots of phones and tablets at once. Never for a re-issue.
  const testing = !!i.testing && !i.deviceId;
  const reviewer = !!i.reviewer && !i.deviceId;
  const minutes = reviewer ? REVIEWER_CODE_DAYS * 24 * 60 : testing ? TESTING_CODE_MINUTES : ENROLLMENT_MINUTES;
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const maxUses = reviewer ? REVIEWER_CODE_USES : testing ? TESTING_CODE_USES : 1;
  await db.query(
    "INSERT INTO enrollment_codes (code_hash, merchant_id, outlet_id, device_id, created_by, expires_at, max_uses) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [sha256(code), i.merchantId, i.outletId, i.deviceId ?? null, i.createdBy, expiresAt, maxUses],
  );
  return { code, expiresAt, maxUses };
}

// ---- the licence: how many devices a shop may have connected ------------------------------------
// Set by Rezein, never by the shop (cli.ts set-device-limit); kept with the shop's settings under this key. No limit when unset.
export const LICENCE_KEY = "licence.devices";

export async function deviceLimit(db: Db, merchantId: string): Promise<number | null> {
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key=$2", [merchantId, LICENCE_KEY]);
  const n = Number(r.rows[0]?.value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
export async function setDeviceLimit(db: Db, merchantId: string, n: number | null): Promise<void> {
  if (n === null) await db.query("DELETE FROM merchant_settings WHERE merchant_id=$1 AND key=$2", [merchantId, LICENCE_KEY]);
  else await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value", [merchantId, LICENCE_KEY, JSON.stringify(n)]);
}
export async function activeDevices(db: Db, merchantId: string): Promise<number> {
  return Number((await db.query("SELECT count(*) FROM devices WHERE merchant_id=$1 AND active", [merchantId])).rows[0].count);
}
/** The licence's limit when one more device would go over it; null when there is room. */
async function full(db: Db, merchantId: string): Promise<number | null> {
  const limit = await deviceLimit(db, merchantId);
  return limit !== null && (await activeDevices(db, merchantId)) >= limit ? limit : null;
}
export class DeviceLimitReached extends Error {
  constructor(readonly limit: number) { super(`device limit ${limit} reached`); }
}

/**
 * Trade a valid code for a device token. The code is consumed in the same statement that checks it,
 * so two devices racing with one code cannot both succeed.
 */
export async function enroll(db: Db, merchantId: string, code: string, name: string): Promise<{ token: string; device: Device; enrolledBy: string | null } | null> {
  const used = await db.query(
    `UPDATE enrollment_codes SET uses = uses + 1, used_at = CASE WHEN uses + 1 >= max_uses THEN now() ELSE NULL END
     WHERE code_hash=$1 AND merchant_id=$2 AND used_at IS NULL AND expires_at > now()
     RETURNING outlet_id, device_id, created_by`,
    [sha256(code.toUpperCase().trim()), merchantId],
  );
  const c = used.rows[0];
  if (!c) return null;
  // A device that would go over the licence is refused, and the code is given back so it can be used once a device is disconnected.
  const wasActive = c.device_id ? (await db.query("SELECT active FROM devices WHERE id=$1", [c.device_id])).rows[0]?.active === true : false;
  const limit = wasActive ? null : await full(db, merchantId);
  if (limit !== null) {
    await db.query("UPDATE enrollment_codes SET uses = uses - 1, used_at = NULL WHERE code_hash=$1", [sha256(code.toUpperCase().trim())]);
    throw new DeviceLimitReached(limit);
  }
  const token = randomBytes(32).toString("base64url");
  if (c.device_id) {
    // Re-issue for an existing device: same id (so its queued events still match), new token, old one dead.
    const r = await db.query("UPDATE devices SET token_hash=$2, active=true, name=$3, wipe_requested=false WHERE id=$1 RETURNING *", [c.device_id, sha256(token), name]);
    return r.rows[0] ? { token, device: toDevice(r.rows[0]), enrolledBy: c.created_by } : null;
  }
  const r = await db.query(
    "INSERT INTO devices (merchant_id, outlet_id, name, token_hash, enrolled_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [merchantId, c.outlet_id, name, sha256(token), c.created_by],
  );
  return { token, device: toDevice(r.rows[0]), enrolledBy: c.created_by };
}

/** An owner or manager signed in on the new device itself and approved it: the same as enrolling with a code they made. */
export async function approveDevice(db: Db, merchantId: string, outletId: string, name: string, approvedBy: string): Promise<{ token: string; device: Device }> {
  const limit = await full(db, merchantId);
  if (limit !== null) throw new DeviceLimitReached(limit);
  const token = randomBytes(32).toString("base64url");
  const r = await db.query("INSERT INTO devices (merchant_id, outlet_id, name, token_hash, enrolled_by) VALUES ($1,$2,$3,$4,$5) RETURNING *", [merchantId, outletId, name, sha256(token), approvedBy]);
  return { token, device: toDevice(r.rows[0]) };
}

/** How many browsers one person can have signed in through Telegram at once. */
export const LINKED_DEVICES_PER_PERSON = 5;

/**
 * A device made without an enrollment code, for a browser opened from a one-time Telegram link. One person can use several
 * browsers at once (a laptop and a tablet, or a colleague helping from the same Telegram account); only when they have more than
 * five are the oldest switched off, so there is no pile of them. (It used to allow one, so opening a second link signed the
 * first browser out with "this device was removed".)
 */
export async function createLinkedDevice(db: Db, merchantId: string, outletId: string, name: string, enrolledBy: string): Promise<{ token: string; device: Device }> {
  await db.query(
    `UPDATE devices SET active=false WHERE id IN (
       SELECT id FROM devices WHERE merchant_id=$1 AND name=$2 AND enrolled_by=$3 AND active ORDER BY created_at DESC, id DESC OFFSET $4)`,
    [merchantId, name, enrolledBy, LINKED_DEVICES_PER_PERSON - 1],
  );
  const limit = await full(db, merchantId);
  if (limit !== null) throw new DeviceLimitReached(limit);
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
    "SELECT id, name, outlet_id, active, wipe_requested, created_at, last_seen_at, last_print_poll_at FROM devices WHERE merchant_id=$1 ORDER BY created_at",
    [merchantId],
  );
  return r.rows;
}

/** A device asking for print jobs is a print hub that is alive. */
export const markPrintPoll = (db: Db, deviceId: string) => db.query("UPDATE devices SET last_print_poll_at = now() WHERE id=$1", [deviceId]).then(() => undefined);

/** The tablet tells us the number of the SIM it receives texts on. */
export async function setSmsNumber(db: Db, deviceId: string, number: string | null): Promise<void> {
  await db.query("UPDATE devices SET sms_number=$2 WHERE id=$1", [deviceId, number]);
}

/** The number customers should text right now: that of a tablet running Rezein that has checked in within the last minute. */
export async function liveSmsNumber(db: Db, merchantId: string): Promise<string | null> {
  const r = await db.query(
    "SELECT sms_number FROM devices WHERE merchant_id=$1 AND active AND sms_number IS NOT NULL AND last_print_poll_at > now() - interval '60 seconds' ORDER BY last_print_poll_at DESC LIMIT 1",
    [merchantId],
  );
  return (r.rows[0]?.sms_number as string | undefined) ?? null;
}

/**
 * Disconnect a device. With reset, its browser is also told, the next time it calls, to clear this app's copy and everything the app
 * stored there (orders not yet sent from it are lost), so it opens fresh on the latest version. A device already disconnected can
 * still be reset.
 */
export async function revokeDevice(db: Db, merchantId: string, deviceId: string, reset = false): Promise<boolean> {
  const r = reset
    ? await db.query("UPDATE devices SET active=false, wipe_requested=true WHERE id=$1 AND merchant_id=$2", [deviceId, merchantId])
    : await db.query("UPDATE devices SET active=false WHERE id=$1 AND merchant_id=$2 AND active", [deviceId, merchantId]);
  return (r.rowCount ?? 0) > 0;
}

/** Is this the token of a device an owner disconnected and reset? */
export async function resetPending(db: Db, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const r = await db.query("SELECT 1 FROM devices WHERE token_hash=$1 AND NOT active AND wipe_requested", [sha256(token)]);
  return r.rows.length > 0;
}
/** What the server sends a reset device: its browser clears this site's cached app and stored data (and the app's service worker). */
export const CLEAR_SITE = '"cache", "storage"';

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

/** End every code still open for an outlet (used when an app-store review is over). Returns how many were ended. */
export async function revokeEnrollmentCodes(db: Db, merchantId: string, outletId: string): Promise<number> {
  const r = await db.query("UPDATE enrollment_codes SET expires_at = now() WHERE merchant_id=$1 AND outlet_id=$2 AND used_at IS NULL AND expires_at > now()", [merchantId, outletId]);
  return r.rowCount ?? 0;
}
