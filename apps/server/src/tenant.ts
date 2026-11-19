import type { Db } from "./db/pool.js";
import type { Staff } from "./auth.js";

/** The brand is the merchant. Under it: franchises (optional groups) and outlets. */
export interface Franchise { id: string; name: string; active: boolean }
export interface Outlet { id: string; name: string; franchiseId: string | null; address: string | null; phone: string | null; hours: string | null; active: boolean;
  /** quick service (no table) or table service (a table is required); null until chosen, then the old SHOP_TABLES rule applies. */
  serviceMode: "qsr" | "tsr" | null }

const ID = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
export const validId = (s: unknown): s is string => typeof s === "string" && ID.test(s);

const toOutlet = (r: Record<string, unknown>): Outlet => ({
  id: r.id as string, name: r.name as string, franchiseId: (r.franchise_id as string | null) ?? null,
  address: (r.address as string | null) ?? null, phone: (r.phone as string | null) ?? null, hours: (r.hours as string | null) ?? null, active: r.active as boolean,
  serviceMode: r.service_mode === "qsr" || r.service_mode === "tsr" ? r.service_mode : null,
});

/** The outlet this server has always run becomes the first outlet. Safe to call at every start. */
export async function ensureDefaultOutlet(db: Db, merchantId: string, outletId: string, name: string): Promise<void> {
  await db.query("INSERT INTO outlets (merchant_id, id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [merchantId, outletId, name]);
}

export async function listFranchises(db: Db, merchantId: string): Promise<Franchise[]> {
  const r = await db.query("SELECT id, name, active FROM franchises WHERE merchant_id=$1 ORDER BY name", [merchantId]);
  return r.rows.map((x) => ({ id: x.id, name: x.name, active: x.active }));
}

export async function listOutlets(db: Db, merchantId: string): Promise<Outlet[]> {
  const r = await db.query("SELECT * FROM outlets WHERE merchant_id=$1 ORDER BY name", [merchantId]);
  return r.rows.map(toOutlet);
}

export async function upsertFranchise(db: Db, merchantId: string, f: { id: string; name: string; active?: boolean }): Promise<void> {
  await db.query(
    "INSERT INTO franchises (merchant_id, id, name, active) VALUES ($1,$2,$3,$4) ON CONFLICT (merchant_id, id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active",
    [merchantId, f.id, f.name, f.active ?? true],
  );
}

/** A franchise that does not exist is refused by the foreign key; callers check first for a friendly message. */
export async function upsertOutlet(db: Db, merchantId: string, o: { id: string; name: string; franchiseId?: string | null; address?: string | null; phone?: string | null; hours?: string | null; active?: boolean; serviceMode?: "qsr" | "tsr" | null }): Promise<void> {
  await db.query(
    `INSERT INTO outlets (merchant_id, id, name, franchise_id, address, phone, hours, active, service_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (merchant_id, id) DO UPDATE SET name=EXCLUDED.name, franchise_id=EXCLUDED.franchise_id, address=EXCLUDED.address, phone=EXCLUDED.phone, hours=EXCLUDED.hours, active=EXCLUDED.active, service_mode=COALESCE(EXCLUDED.service_mode, outlets.service_mode)`,
    [merchantId, o.id, o.name, o.franchiseId ?? null, o.address ?? null, o.phone ?? null, o.hours ?? null, o.active ?? true, o.serviceMode ?? null],
  );
}

/**
 * The outlets a staff member may see: `null` means all of them (the brand owner), otherwise the list.
 * No franchise and no outlet on the login = the whole brand. A franchise = that franchise's outlets. An outlet = just it.
 * A scope that points at something that no longer exists sees nothing, never everything.
 */
export async function visibleOutletIds(db: Db, merchantId: string, staff: Pick<Staff, "franchiseId" | "outletId">): Promise<string[] | null> {
  if (staff.outletId) return [staff.outletId];
  if (staff.franchiseId) {
    const r = await db.query("SELECT id FROM outlets WHERE merchant_id=$1 AND franchise_id=$2", [merchantId, staff.franchiseId]);
    return r.rows.map((x) => x.id as string);
  }
  return null;
}

export const outletAllowed = (visible: string[] | null, outletId: string): boolean => visible === null || visible.includes(outletId);
