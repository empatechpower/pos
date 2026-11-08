import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db/pool.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = "cashier" | "manager" | "owner";
export type Permission = "print.manage" | "print.reprint" | "catalog.manage" | "device.manage" | "wallet.read" | "wallet.topup" | "wallet.spend" | "wallet.refund" | "audit.read" | "staff.manage";

const PERMISSIONS: Record<Role, Permission[]> = {
  cashier: ["wallet.read", "wallet.topup", "wallet.spend", "print.reprint"],
  manager: ["wallet.read", "wallet.topup", "wallet.spend", "wallet.refund", "audit.read", "device.manage", "catalog.manage", "print.manage", "print.reprint"],
  owner: ["wallet.read", "wallet.topup", "wallet.spend", "wallet.refund", "audit.read", "device.manage", "catalog.manage", "print.manage", "print.reprint", "staff.manage"],
};
export const can = (role: Role, p: Permission) => PERMISSIONS[role].includes(p);

/** Largest single top-up a cashier may add. Managers and owners are not capped. An assumption to confirm with the client. */
export const CASHIER_TOPUP_LIMIT_CENTS = 20_000;

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 5;
export const SESSION_HOURS = 12;

export interface Staff {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  role: Role;
}

// ---- PIN hashing ------------------------------------------------------------------------------

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, 32);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(pin, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- accounts ---------------------------------------------------------------------------------

export async function createStaff(
  db: Db,
  i: { merchantId: string; code: string; name: string; role: Role; pin: string },
): Promise<Staff> {
  if (!/^\d{4,8}$/.test(i.pin)) throw new Error("PIN must be 4 to 8 digits");
  const r = await db.query(
    `INSERT INTO staff (merchant_id, code, name, role, pin_hash) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, merchant_id, code, name, role`,
    [i.merchantId, i.code, i.name, i.role, await hashPin(i.pin)],
  );
  return toStaff(r.rows[0]);
}

const toStaff = (r: Record<string, unknown>): Staff => ({
  id: r.id as string,
  merchantId: r.merchant_id as string,
  code: r.code as string,
  name: r.name as string,
  role: r.role as Role,
});

// ---- login / sessions -------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; token: string; staff: Staff; expiresAt: Date }
  | { ok: false; reason: "invalid" | "locked" };

/**
 * One generic failure ("invalid") for unknown code, wrong PIN and inactive account, so the
 * response never reveals which staff codes exist. Five wrong PINs lock the account for a few minutes.
 */
export async function login(db: Db, merchantId: string, code: string, pin: string): Promise<LoginResult> {
  const r = await db.query("SELECT * FROM staff WHERE merchant_id=$1 AND code=$2", [merchantId, code]);
  const row = r.rows[0];
  if (!row || !row.active) {
    await hashPin(pin).catch(() => {}); // similar work either way, so timing doesn't leak which codes exist
    return { ok: false, reason: "invalid" };
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false, reason: "locked" };

  if (!(await verifyPin(pin, row.pin_hash))) {
    const failed = Number(row.failed_attempts) + 1;
    const lock = failed >= MAX_FAILED_ATTEMPTS;
    await db.query(
      `UPDATE staff SET failed_attempts=$2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id=$1`,
      [row.id, lock ? 0 : failed, lock, LOCKOUT_MINUTES],
    );
    await audit(db, merchantId, row.id, lock ? "auth.locked" : "auth.failed", {});
    return { ok: false, reason: lock ? "locked" : "invalid" };
  }

  await db.query("UPDATE staff SET failed_attempts=0, locked_until=NULL WHERE id=$1", [row.id]);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.query("INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES ($1,$2,$3)", [sha256(token), row.id, expiresAt]);
  await audit(db, merchantId, row.id, "auth.login", {});
  return { ok: true, token, staff: toStaff(row), expiresAt };
}

export async function authenticate(db: Db, token: string | undefined): Promise<Staff | null> {
  if (!token) return null;
  const r = await db.query(
    `SELECT s.* FROM sessions x JOIN staff s ON s.id = x.staff_id
     WHERE x.token_hash=$1 AND x.expires_at > now() AND s.active`,
    [sha256(token)],
  );
  return r.rows[0] ? toStaff(r.rows[0]) : null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(token)]);
}

// ---- audit ------------------------------------------------------------------------------------

export async function audit(db: Db, merchantId: string, staffId: string | null, action: string, detail: object): Promise<void> {
  await db.query("INSERT INTO audit_log (merchant_id, staff_id, action, detail) VALUES ($1,$2,$3,$4)", [
    merchantId,
    staffId,
    action,
    JSON.stringify(detail),
  ]);
}

export async function recentAudit(db: Db, merchantId: string, limit = 100) {
  const r = await db.query(
    `SELECT a.id, a.action, a.detail, a.created_at, s.code AS staff_code, s.name AS staff_name
     FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.merchant_id=$1 ORDER BY a.id DESC LIMIT $2`,
    [merchantId, Math.min(limit, 500)],
  );
  return r.rows;
}
