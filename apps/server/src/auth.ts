import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db/pool.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = "cashier" | "manager" | "owner" | "agent";
export type Permission = "print.manage" | "print.reprint" | "catalog.manage" | "device.manage" | "wallet.read" | "wallet.topup" | "wallet.spend" | "wallet.refund" | "audit.read" | "staff.manage";

const PERMISSIONS: Record<Role, Permission[]> = {
  cashier: ["wallet.read", "wallet.topup", "wallet.spend", "print.reprint"],
  manager: ["wallet.read", "wallet.topup", "wallet.spend", "wallet.refund", "audit.read", "device.manage", "catalog.manage", "print.manage", "print.reprint"],
  owner: ["wallet.read", "wallet.topup", "wallet.spend", "wallet.refund", "audit.read", "device.manage", "catalog.manage", "print.manage", "print.reprint", "staff.manage"],
  // An AI helper or script: change the menu and prices, read reports and credit, reprint tickets. It can never move money,
  // freeze credit, manage devices or printers, or create staff.
  agent: ["wallet.read", "audit.read", "catalog.manage", "print.reprint"],
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

/** Open a staff session without a PIN, for a sign-in that has already been proven another way (a one-time code from Telegram). */
export async function startSessionFor(db: Db, merchantId: string, staffId: string, via: string): Promise<{ token: string; staff: Staff; expiresAt: Date } | null> {
  const r = await db.query("SELECT * FROM staff WHERE id=$1 AND merchant_id=$2 AND active", [staffId, merchantId]);
  if (!r.rows[0]) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.query("INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES ($1,$2,$3)", [sha256(token), staffId, expiresAt]);
  await audit(db, merchantId, staffId, "auth.login", { via });
  return { token, staff: toStaff(r.rows[0]), expiresAt };
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

// ---- agent keys -------------------------------------------------------------------------------

/** Make an agent (a limited login nobody can sign in to with a PIN) and its API key. The key is shown once and only its hash is kept. */
export async function createAgent(db: Db, merchantId: string, name: string, createdBy: string): Promise<{ id: string; name: string; key: string }> {
  const code = `AG${randomBytes(3).toString("hex").toUpperCase()}`;
  const staff = await createStaff(db, { merchantId, code, name: `Agent: ${name}`, role: "agent", pin: String(10_000_000 + (randomBytes(4).readUInt32BE() % 89_999_999)) });
  const key = `agt_${randomBytes(24).toString("base64url")}`;
  const r = await db.query("INSERT INTO agent_keys (merchant_id, staff_id, name, key_hash) VALUES ($1,$2,$3,$4) RETURNING id", [merchantId, staff.id, name, sha256(key)]);
  await audit(db, merchantId, createdBy, "agent.create", { agentId: r.rows[0].id, name });
  return { id: r.rows[0].id as string, name, key };
}

export async function listAgents(db: Db, merchantId: string) {
  const r = await db.query("SELECT id, name, created_at, last_used_at, revoked_at FROM agent_keys WHERE merchant_id=$1 ORDER BY created_at", [merchantId]);
  return r.rows.map((x) => ({ id: x.id as string, name: x.name as string, createdAt: x.created_at as Date, lastUsedAt: (x.last_used_at as Date | null) ?? null, revoked: !!x.revoked_at }));
}

export async function revokeAgent(db: Db, merchantId: string, id: string, by: string): Promise<boolean> {
  const r = await db.query("UPDATE agent_keys SET revoked_at = now() WHERE merchant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING staff_id", [merchantId, id]);
  if (!r.rowCount) return false;
  await db.query("UPDATE staff SET active=false WHERE id=$1", [r.rows[0].staff_id]);
  await audit(db, merchantId, by, "agent.revoke", { agentId: id });
  return true;
}

/** The agent behind an API key, or null. Revoked keys and deactivated agents never match. */
export async function authenticateAgent(db: Db, key: string | undefined): Promise<Staff | null> {
  if (!key || !key.startsWith("agt_")) return null;
  const r = await db.query(
    `SELECT s.* FROM agent_keys k JOIN staff s ON s.id = k.staff_id WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND s.active`,
    [sha256(key)],
  );
  if (!r.rows[0]) return null;
  void db.query("UPDATE agent_keys SET last_used_at = now() WHERE key_hash=$1", [sha256(key)]).catch(() => {});
  return toStaff(r.rows[0]);
}

// ---- connecting an agent with a one-time code -------------------------------------------------

export const CONNECT_CODE_MINUTES = 15;

/** A short code the merchant hands to the agent. It works once, for a few minutes, and only makes a new agent for this shop. */
export async function createConnectCode(db: Db, merchantId: string, createdBy: string): Promise<{ code: string; expiresAt: Date }> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
  const code = `${pick()}-${pick()}`;
  const expiresAt = new Date(Date.now() + CONNECT_CODE_MINUTES * 60_000);
  await db.query("INSERT INTO agent_connect_codes (code_hash, merchant_id, created_by, expires_at) VALUES ($1,$2,$3,$4)", [sha256(code), merchantId, createdBy, expiresAt]);
  await audit(db, merchantId, createdBy, "agent.connect_code", {});
  return { code, expiresAt };
}

/** The agent trades the code for its key. Null when the code is wrong, used or expired. */
export async function redeemConnectCode(db: Db, merchantId: string, code: string, name: string): Promise<{ id: string; name: string; key: string } | null> {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const dashed = `${norm.slice(0, 4)}-${norm.slice(4)}`;
  const used = await db.query(
    "UPDATE agent_connect_codes SET used_at = now() WHERE code_hash=$1 AND merchant_id=$2 AND used_at IS NULL AND expires_at > now() RETURNING created_by",
    [sha256(dashed), merchantId],
  );
  if (!used.rowCount) return null;
  return createAgent(db, merchantId, name, used.rows[0].created_by as string);
}
