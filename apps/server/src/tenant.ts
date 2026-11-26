import type { Db } from "./db/pool.js";
import type { Staff } from "./auth.js";

/** The brand is the merchant. Under it: franchises (optional groups) and outlets. */
export interface Franchise { id: string; name: string; active: boolean }
export interface Outlet { id: string; name: string; franchiseId: string | null; address: string | null; phone: string | null; hours: string | null; active: boolean;
  /** quick service (no table) or table service (a table is required); null until chosen, then the old SHOP_TABLES rule applies. */
  serviceMode: "qsr" | "tsr" | "retail" | null;
  /** Minutes to prepare an order here (a setting), shown before ordering. null = not set. */
  prepMinutes: number | null;
  /** Where the outlet is. Both or neither; with them, customers can sort outlets by distance. */
  latitude: number | null;
  longitude: number | null;
  /** The country the outlet is in (ISO code). It chooses the tax pack; nothing overrides it. */
  country: string;
  /** GST registration number and business number (UEN), printed on the receipt. With a GST number the receipt is a tax invoice. */
  gstRegNo: string | null;
  uen: string | null;
  /** Whether this outlet charges tax; null = it follows the brand's switch. */
  gstOn: boolean | null;
  /** The closing lines of this outlet's receipt (one per line), and its customer service line. Null = the defaults. */
  receiptFooter: string | null;
  customerService: string | null;
  /** Rounding by tender, in cents ({ cash: 5 }); empty = no rounding. And whether staff here may take tax off an order. */
  tenderRounding: Record<string, number>;
  taxRemovable: boolean }

const ID = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
export const validId = (s: unknown): s is string => typeof s === "string" && ID.test(s);

const toOutlet = (r: Record<string, unknown>): Outlet => ({
  id: r.id as string, name: r.name as string, franchiseId: (r.franchise_id as string | null) ?? null,
  address: (r.address as string | null) ?? null, phone: (r.phone as string | null) ?? null, hours: (r.hours as string | null) ?? null, active: r.active as boolean,
  serviceMode: r.service_mode === "qsr" || r.service_mode === "tsr" || r.service_mode === "retail" ? r.service_mode : null,
  prepMinutes: r.prep_minutes === null || r.prep_minutes === undefined ? null : Number(r.prep_minutes),
  latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
  longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
  country: typeof r.country === "string" && r.country ? r.country : "SG",
  gstRegNo: (r.gst_reg_no as string | null) ?? null, uen: (r.uen as string | null) ?? null, gstOn: typeof r.gst_on === "boolean" ? r.gst_on : null, receiptFooter: (r.receipt_footer as string | null) ?? null, customerService: (r.customer_service as string | null) ?? null,
  tenderRounding: r.tender_rounding && typeof r.tender_rounding === "object" ? (r.tender_rounding as Record<string, number>) : {}, taxRemovable: r.tax_removable === true,
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
export async function upsertOutlet(db: Db, merchantId: string, o: { id: string; name: string; franchiseId?: string | null; address?: string | null; phone?: string | null; hours?: string | null; active?: boolean; serviceMode?: "qsr" | "tsr" | "retail" | null; prepMinutes?: number | null; latitude?: number | null; longitude?: number | null; country?: string; gstRegNo?: string | null; uen?: string | null; gstOn?: boolean | null; receiptFooter?: string | null; customerService?: string | null; tenderRounding?: Record<string, number>; taxRemovable?: boolean }): Promise<void> {
  await db.query(
    `INSERT INTO outlets (merchant_id, id, name, franchise_id, address, phone, hours, active, service_mode, prep_minutes, latitude, longitude, country, gst_reg_no, uen, gst_on, receipt_footer, customer_service, tender_rounding, tax_removable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20)
     ON CONFLICT (merchant_id, id) DO UPDATE SET name=EXCLUDED.name, franchise_id=EXCLUDED.franchise_id, address=EXCLUDED.address, phone=EXCLUDED.phone, hours=EXCLUDED.hours, active=EXCLUDED.active, service_mode=COALESCE(EXCLUDED.service_mode, outlets.service_mode), prep_minutes=EXCLUDED.prep_minutes, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, country=EXCLUDED.country, gst_reg_no=EXCLUDED.gst_reg_no, uen=EXCLUDED.uen, gst_on=EXCLUDED.gst_on, receipt_footer=EXCLUDED.receipt_footer, customer_service=EXCLUDED.customer_service, tender_rounding=EXCLUDED.tender_rounding, tax_removable=EXCLUDED.tax_removable`,
    [merchantId, o.id, o.name, o.franchiseId ?? null, o.address ?? null, o.phone ?? null, o.hours ?? null, o.active ?? true, o.serviceMode ?? null, o.prepMinutes ?? null, o.latitude ?? null, o.longitude ?? null, o.country ?? "SG", o.gstRegNo ?? null, o.uen ?? null, o.gstOn ?? null, o.receiptFooter ?? null, o.customerService ?? null, JSON.stringify(o.tenderRounding ?? {}), o.taxRemovable === true],
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
