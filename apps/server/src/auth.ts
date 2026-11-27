import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db/pool.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = "cashier" | "manager" | "owner" | "agent";
export type Permission = "print.manage" | "print.reprint" | "catalog.manage" | "device.manage" | "wallet.read" | "wallet.topup" | "wallet.spend" | "wallet.refund" | "audit.read" | "staff.manage"
  /** Approving on the spot what a cashier otherwise needs a manager's PIN for: refunds and voids, discounts above the cashier's limit, closing a shift whose cash does not match. */
  | "order.refund" | "discount.approve" | "shift.approve";

const DEFAULTS: Record<Role, Permission[]> = {
  cashier: ["wallet.read", "wallet.topup", "wallet.spend", "print.reprint"],
  manager: ["wallet.read", "wallet.topup", "wallet.spend", "wallet.refund", "audit.read", "device.manage", "catalog.manage", "print.manage", "print.reprint", "order.refund", "discount.approve", "shift.approve"],
  owner: ["wallet.read", "wallet.topup", "wallet.spend", "wallet.refund", "audit.read", "device.manage", "catalog.manage", "print.manage", "print.reprint", "staff.manage", "order.refund", "discount.approve", "shift.approve"],
  // An AI helper or script: change the menu and prices, read reports and credit, reprint tickets. It can never move money,
  // freeze credit, manage devices or printers, or create staff.
  agent: ["wallet.read", "audit.read", "catalog.manage", "print.reprint"],
};
/**
 * What each role may do. Cashiers and managers can be changed by the owner (handout 4.10: staff roles and per-permission gates); the owner
 * and agents are fixed. One server runs one brand, so the shop's choice is held here for the life of the process and loaded at start.
 */
const PERMISSIONS: Record<Role, Permission[]> = { cashier: [...DEFAULTS.cashier], manager: [...DEFAULTS.manager], owner: [...DEFAULTS.owner], agent: [...DEFAULTS.agent] };
export const can = (role: Role, p: Permission) => PERMISSIONS[role].includes(p);
export const rolePermissions = (role: Role): Permission[] => [...PERMISSIONS[role]];

/** The permissions an owner can switch for a role, in the words the settings screen shows. Selling itself (signing in, taking payment) is never switched off. */
export const PERMISSION_OPTIONS: Array<{ id: Permission; label: string; help: string; roles: Array<"cashier" | "manager"> }> = [
  { id: "order.refund", label: "Refund and void orders", help: "Without it, a manager's code and PIN is asked for each time.", roles: ["cashier", "manager"] },
  { id: "discount.approve", label: "Give any discount or change a price", help: "Without it, discounts above the cashier's limit need a manager's code and PIN.", roles: ["cashier", "manager"] },
  { id: "shift.approve", label: "Close a shift whose cash does not match, and close other people's shifts", help: "Without it, a manager approves the difference.", roles: ["cashier", "manager"] },
  { id: "wallet.topup", label: "Top up member credit and add members", help: "", roles: ["cashier", "manager"] },
  { id: "print.reprint", label: "Reprint receipts and kitchen tickets, open the cash drawer", help: "", roles: ["cashier", "manager"] },
  { id: "audit.read", label: "See the back-office reports and the audit log", help: "", roles: ["cashier", "manager"] },
  { id: "catalog.manage", label: "Change the menu and prices", help: "", roles: ["cashier", "manager"] },
  { id: "wallet.refund", label: "Adjust member credit and points, freeze credit", help: "", roles: ["manager"] },
  { id: "device.manage", label: "Set up tills, outlets and the floor plan", help: "", roles: ["manager"] },
  { id: "print.manage", label: "Set up printers", help: "", roles: ["manager"] },
];
const ALWAYS: Permission[] = ["wallet.read", "wallet.spend"];

/**
 * What one person may do: their role's permissions, plus what they were given on top, less what was taken away from them. The owner is
 * never changed, selling is never taken away, and managing staff is never given. Takes a staff object or a raw staff row.
 */
type Who = { role: Role; permAllow?: readonly string[]; permDeny?: readonly string[]; perm_allow?: readonly string[] | null; perm_deny?: readonly string[] | null };
const GIVABLE = () => PERMISSION_OPTIONS.map((o) => o.id);
export function permissionsOf(s: Who): Permission[] {
  const base = rolePermissions(s.role);
  if (s.role === "owner" || s.role === "agent") return base;
  const allow = (s.permAllow ?? s.perm_allow ?? []).filter((p): p is Permission => GIVABLE().includes(p as Permission));
  const deny = new Set((s.permDeny ?? s.perm_deny ?? []).filter((p) => !ALWAYS.includes(p as Permission)));
  return [...new Set([...base, ...allow])].filter((p) => !deny.has(p));
}
export const canDo = (s: Who, p: Permission): boolean => permissionsOf(s).includes(p);
/** Tidy a person's own differences: only permissions that can be given or taken, and never the same one in both lists (taking away wins). */
export function cleanOverrides(allow: unknown, deny: unknown): { allow: Permission[]; deny: Permission[] } | null {
  const list = (v: unknown) => (Array.isArray(v) && v.length <= 40 && v.every((x) => typeof x === "string") ? [...new Set(v as string[])] : null);
  const a = list(allow ?? []), d = list(deny ?? []);
  if (!a || !d) return null;
  const ok = GIVABLE();
  const denyOut = d.filter((p): p is Permission => ok.includes(p as Permission));
  return { allow: a.filter((p): p is Permission => ok.includes(p as Permission) && !denyOut.includes(p as Permission)), deny: denyOut };
}

/** Set what a role may do. Only the options offered for that role count; anything else in the list is ignored. */
export function setRolePermissions(role: "cashier" | "manager", perms: readonly string[]): Permission[] {
  const allowed = PERMISSION_OPTIONS.filter((o) => o.roles.includes(role)).map((o) => o.id);
  PERMISSIONS[role] = [...ALWAYS, ...allowed.filter((p) => perms.includes(p))];
  return rolePermissions(role);
}
export function resetRolePermissions(): void { PERMISSIONS.cashier = [...DEFAULTS.cashier]; PERMISSIONS.manager = [...DEFAULTS.manager]; }
/** The shop's saved choice, read at start. Nothing saved = the defaults. */
export async function loadRolePermissions(db: Db, merchantId: string): Promise<void> {
  resetRolePermissions();
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='permissions'", [merchantId]);
  const v = (r.rows[0]?.value ?? null) as { cashier?: unknown; manager?: unknown } | null;
  if (Array.isArray(v?.cashier)) setRolePermissions("cashier", v!.cashier as string[]);
  if (Array.isArray(v?.manager)) setRolePermissions("manager", v!.manager as string[]);
}
export async function saveRolePermissions(db: Db, merchantId: string): Promise<void> {
  await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'permissions',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify({ cashier: rolePermissions("cashier"), manager: rolePermissions("manager") })]);
}

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
  /** Scope. Neither set = the whole brand; a franchise = that franchise's outlets; an outlet = that outlet only. */
  franchiseId?: string | null;
  outletId?: string | null;
  /** The sign-in phone number with the middle hidden, like "+65 •••• 1111", for the staff buttons on the sign-in screen. */
  phoneHint?: string | null;
  /** This person's own differences from their role: permissions given on top of it, and taken away from it. */
  permAllow?: Permission[];
  permDeny?: Permission[];
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

const COUNTRY_CODES = ["852", "65", "60", "62", "66", "63", "84", "86", "91", "61", "44", "1"];
/** "+6581111111" becomes "+65 •••• 1111": the country code and the last four digits only. */
export function phoneHint(phone: unknown): string | null {
  const n = normalisePhone(phone);
  if (!n) return null;
  const d = n.slice(1);
  const cc = COUNTRY_CODES.find((c) => d.startsWith(c)) ?? d.slice(0, 2);
  return `+${cc} •••• ${d.slice(-4)}`;
}

/** A phone number as "+" and digits (8 to 15 of them), or null when it is not one. Spaces, dashes and brackets are ignored. */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\s\-().]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
}

/** Sign in with a phone number and PIN: the number finds the person, then it is exactly a code sign-in (same lockout, same one generic failure). */
export async function loginByPhone(db: Db, merchantId: string, phone: string, pin: string): Promise<LoginResult> {
  const n = normalisePhone(phone);
  const r = n ? await db.query("SELECT code FROM staff WHERE merchant_id=$1 AND phone=$2 AND active", [merchantId, n]) : { rows: [] as Array<{ code: string }> };
  if (!r.rows[0]) { await hashPin(pin).catch(() => {}); return { ok: false, reason: "invalid" }; }
  return login(db, merchantId, r.rows[0].code as string, pin);
}

/** The right PIN for this staff code or sign-in phone number? Same rules as signing in, but no session is opened. Gives the person. */
export async function checkStaffBy(db: Db, merchantId: string, who: { code?: string; phone?: string }, pin: string): Promise<{ ok: true; staff: Staff } | { ok: false; reason: "invalid" | "locked" }> {
  let code = who.code?.trim();
  if (!code) {
    const n = normalisePhone(who.phone);
    const r = n ? await db.query("SELECT code FROM staff WHERE merchant_id=$1 AND phone=$2 AND active", [merchantId, n]) : { rows: [] as Array<{ code: string }> };
    if (!r.rows[0]) { await hashPin(pin).catch(() => {}); return { ok: false, reason: "invalid" }; }
    code = r.rows[0].code as string;
  }
  const v = await checkStaffPin(db, merchantId, code, pin);
  return v.ok ? { ok: true, staff: toStaff(v.row) } : v;
}

/** Set or clear a staff member's sign-in phone number. False when the number is taken by someone else or not a number. */
export async function setStaffPhone(db: Db, merchantId: string, code: string, phone: string | null): Promise<"ok" | "invalid" | "taken" | "unknown"> {
  const n = phone === null ? null : normalisePhone(phone);
  if (phone !== null && !n) return "invalid";
  try {
    const r = await db.query("UPDATE staff SET phone=$3 WHERE merchant_id=$1 AND code=$2", [merchantId, code, n]);
    return r.rowCount ? "ok" : "unknown";
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return "taken";
    throw e;
  }
}

// ---- accounts ---------------------------------------------------------------------------------

export async function createStaff(
  db: Db,
  i: { merchantId: string; code: string; name: string; role: Role; pin: string; franchiseId?: string | null; outletId?: string | null },
): Promise<Staff> {
  if (!/^\d{4,8}$/.test(i.pin)) throw new Error("PIN must be 4 to 8 digits");
  const r = await db.query(
    `INSERT INTO staff (merchant_id, code, name, role, pin_hash, franchise_id, outlet_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, merchant_id, code, name, role, franchise_id, outlet_id`,
    [i.merchantId, i.code, i.name, i.role, await hashPin(i.pin), i.franchiseId ?? null, i.outletId ?? null],
  );
  return toStaff(r.rows[0]);
}

const toStaff = (r: Record<string, unknown>): Staff => ({
  id: r.id as string,
  merchantId: r.merchant_id as string,
  code: r.code as string,
  name: r.name as string,
  role: r.role as Role,
  franchiseId: (r.franchise_id as string | null) ?? null,
  outletId: (r.outlet_id as string | null) ?? null,
  phoneHint: phoneHint(r.phone),
  ...(Array.isArray(r.perm_allow) && r.perm_allow.length ? { permAllow: r.perm_allow as Permission[] } : {}),
  ...(Array.isArray(r.perm_deny) && r.perm_deny.length ? { permDeny: r.perm_deny as Permission[] } : {}),
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
  const v = await checkStaffPin(db, merchantId, code, pin);
  if (!v.ok) return v;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.query("INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES ($1,$2,$3)", [sha256(token), v.row.id, expiresAt]);
  await audit(db, merchantId, v.row.id, "auth.login", {});
  return { ok: true, token, staff: toStaff(v.row), expiresAt };
}

/**
 * Is this the right PIN for this staff code? Same rules as signing in (one generic failure, five wrong PINs lock the account),
 * but no session is opened: used to let a manager approve something on someone else's till.
 */
export async function checkStaffPin(db: Db, merchantId: string, code: string, pin: string): Promise<{ ok: true; row: any } | { ok: false; reason: "invalid" | "locked" }> {
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
  return { ok: true, row };
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
