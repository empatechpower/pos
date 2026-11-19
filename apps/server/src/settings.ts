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

export async function saveSetting(db: Db, merchantId: string, key: string, value: unknown): Promise<void> {
  await db.query(
    "INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
    [merchantId, key, JSON.stringify(value)],
  );
}

/**
 * The kiosk's operator settings, set once for the brand in Manager (not on each tablet): how long a quiet kiosk waits before it
 * clears itself, whether the member sign-in block shows, and which of the three reward chips show on the start screen.
 */
export interface KioskSettings { idleMinutes: number; signinBlock: boolean; chips: { earn: boolean; rate: boolean; stamps: boolean } }
export const KIOSK_IDLE_CHOICES = [1, 2, 3, 5];
export const KIOSK_DEFAULTS: KioskSettings = { idleMinutes: 1, signinBlock: true, chips: { earn: true, rate: true, stamps: true } };

/** Applies a (possibly partial, possibly wrong) patch on top of current settings. Anything invalid is ignored, never trusted. */
export function mergeKiosk(current: KioskSettings, patch: unknown): KioskSettings {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const chipsIn = (p.chips && typeof p.chips === "object" ? p.chips : {}) as Record<string, unknown>;
  const pick = (k: "earn" | "rate" | "stamps") => (typeof chipsIn[k] === "boolean" ? (chipsIn[k] as boolean) : current.chips[k]);
  return {
    idleMinutes: typeof p.idleMinutes === "number" && KIOSK_IDLE_CHOICES.includes(p.idleMinutes) ? p.idleMinutes : current.idleMinutes,
    signinBlock: typeof p.signinBlock === "boolean" ? p.signinBlock : current.signinBlock,
    chips: { earn: pick("earn"), rate: pick("rate"), stamps: pick("stamps") },
  };
}

export async function loadKiosk(db: Db | null, merchantId: string): Promise<KioskSettings> {
  const row = db ? (await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='kiosk'", [merchantId])).rows[0] : undefined;
  return mergeKiosk(KIOSK_DEFAULTS, row?.value);
}

export async function saveKiosk(db: Db, merchantId: string, patch: unknown): Promise<KioskSettings> {
  const next = mergeKiosk(await loadKiosk(db, merchantId), patch);
  await saveSetting(db, merchantId, "kiosk", next);
  return next;
}
