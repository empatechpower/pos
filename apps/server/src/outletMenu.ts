import { isEmptyOverride, type OutletMenu, type OutletProductOverride } from "@pos/core";
import type { Db } from "./db/pool.js";

/** One outlet's overrides of the brand's menu, and a version that rises whenever they change (so a phone knows to fetch the menu again). */
export async function loadOutletMenu(db: Db | null, merchantId: string, outletId: string): Promise<{ menu: OutletMenu; version: number }> {
  if (!db) return { menu: {}, version: 0 };
  const [rows, v] = await Promise.all([
    db.query("SELECT product_id, data FROM outlet_menu_overrides WHERE merchant_id=$1 AND outlet_id=$2", [merchantId, outletId]),
    db.query("SELECT menu_version FROM outlets WHERE merchant_id=$1 AND id=$2", [merchantId, outletId]),
  ]);
  const menu: OutletMenu = {};
  for (const r of rows.rows) menu[r.product_id as string] = r.data as OutletProductOverride;
  return { menu, version: Number(v.rows[0]?.menu_version ?? 0) };
}

/** Save one item's override at an outlet. An override with nothing left in it is deleted. */
export async function saveOutletOverride(db: Db, merchantId: string, outletId: string, productId: string, o: OutletProductOverride): Promise<void> {
  if (isEmptyOverride(o)) await db.query("DELETE FROM outlet_menu_overrides WHERE merchant_id=$1 AND outlet_id=$2 AND product_id=$3", [merchantId, outletId, productId]);
  else
    await db.query(
      "INSERT INTO outlet_menu_overrides (merchant_id, outlet_id, product_id, data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (merchant_id, outlet_id, product_id) DO UPDATE SET data=EXCLUDED.data",
      [merchantId, outletId, productId, JSON.stringify(o)],
    );
  await db.query("UPDATE outlets SET menu_version = menu_version + 1 WHERE merchant_id=$1 AND id=$2", [merchantId, outletId]);
}
