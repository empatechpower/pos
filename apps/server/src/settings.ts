import type { BusinessConfig } from "@pos/core";
import type { Db } from "./db/pool.js";

/**
 * Options the owner can switch without a deploy. The service charge is OFF unless it is switched on here (or SERVICE_CHARGE=on is
 * set on the server as the starting value). Tax follows the shop's configuration until it is set here.
 */
export interface PricingOptions { serviceChargeOn: boolean; gstOn: boolean }

export const optionsOf = (config: BusinessConfig): PricingOptions => ({ serviceChargeOn: config.pricing.serviceOn !== false, gstOn: config.pricing.gstOn });

export async function loadSettings(db: Db | null, merchantId: string, config: BusinessConfig): Promise<void> {
  const rows = db ? (await db.query("SELECT key, value FROM merchant_settings WHERE merchant_id=$1", [merchantId])).rows : [];
  const get = (k: string): boolean | undefined => (typeof rows.find((r) => r.key === k)?.value === "boolean" ? (rows.find((r) => r.key === k)!.value as boolean) : undefined);
  config.pricing.serviceOn = get("serviceChargeOn") ?? /^(1|true|yes|on)$/i.test(process.env.SERVICE_CHARGE ?? "");
  const gst = get("gstOn");
  if (gst !== undefined) config.pricing.gstOn = gst;
}

export async function saveSetting(db: Db, merchantId: string, key: string, value: boolean): Promise<void> {
  await db.query(
    "INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
    [merchantId, key, JSON.stringify(value)],
  );
}
