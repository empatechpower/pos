import type { BusinessConfig } from "@pos/core";
import type { Db } from "./db/pool.js";

/**
 * Options the owner can switch without a deploy. The service charge is OFF unless it is switched on here (or SERVICE_CHARGE=on is
 * set on the server as the starting value). Tax follows the shop's configuration until it is set here.
 */
export interface PricingOptions {
  serviceChargeOn: boolean;
  gstOn: boolean;
  /** A coupon/voucher and points can be used on the same order (Spec 8.2). */
  stackable: boolean;
  /** What points may pay for, besides items: items "all" or only the "eligible" ones, service charge, tax. The container deposit is never payable in points. */
  pointsItemsEligibleOnly: boolean;
  pointsDeductService: boolean;
  pointsDeductTax: boolean;
  /** Points may also pay the container deposit (off by default: the deposit is refundable cash). */
  pointsDeductDeposit: boolean;
}

export const optionsOf = (config: BusinessConfig): PricingOptions => ({
  serviceChargeOn: config.pricing.serviceOn !== false,
  gstOn: config.pricing.gstOn,
  stackable: config.pricing.stackable,
  pointsItemsEligibleOnly: config.pricing.pointsDeduct.items === "eligible",
  pointsDeductService: config.pricing.pointsDeduct.service,
  pointsDeductTax: config.pricing.pointsDeduct.tax,
  pointsDeductDeposit: config.pricing.pointsDeduct.deposit,
});

/** Applies one owner setting to the live config. Returns false for a key that is not a pricing option. */
export function applyOption(config: BusinessConfig, key: string, value: boolean): boolean {
  switch (key) {
    case "serviceChargeOn": config.pricing.serviceOn = value; return true;
    case "gstOn": config.pricing.gstOn = value; return true;
    case "stackable": config.pricing.stackable = value; return true;
    case "pointsItemsEligibleOnly": config.pricing.pointsDeduct = { ...config.pricing.pointsDeduct, items: value ? "eligible" : "all" }; return true;
    case "pointsDeductService": config.pricing.pointsDeduct = { ...config.pricing.pointsDeduct, service: value }; return true;
    case "pointsDeductTax": config.pricing.pointsDeduct = { ...config.pricing.pointsDeduct, tax: value }; return true;
    case "pointsDeductDeposit": config.pricing.pointsDeduct = { ...config.pricing.pointsDeduct, deposit: value }; return true;
    default: return false;
  }
}
export const OPTION_KEYS = ["serviceChargeOn", "gstOn", "stackable", "pointsItemsEligibleOnly", "pointsDeductService", "pointsDeductTax", "pointsDeductDeposit"] as const;

/** A service charge percentage: 0 to 30, to one decimal place. */
export const validServiceRatePct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 30 && Math.round(v * 10) === v * 10;

export async function loadSettings(db: Db | null, merchantId: string, config: BusinessConfig): Promise<void> {
  const rows = db ? (await db.query("SELECT key, value FROM merchant_settings WHERE merchant_id=$1", [merchantId])).rows : [];
  const get = (k: string): boolean | undefined => (typeof rows.find((r) => r.key === k)?.value === "boolean" ? (rows.find((r) => r.key === k)!.value as boolean) : undefined);
  config.pricing.serviceOn = get("serviceChargeOn") ?? /^(1|true|yes|on)$/i.test(process.env.SERVICE_CHARGE ?? "");
  // The service charge rate is the shop's own (standing rule 2): the owner's saved percentage, else the built-in one.
  const rate = rows.find((r) => r.key === "serviceRatePct")?.value;
  if (validServiceRatePct(rate)) config.pricing.serviceRate = (rate as number) / 100;
  for (const k of OPTION_KEYS) {
    if (k === "serviceChargeOn") continue;
    const v = get(k);
    if (v !== undefined) applyOption(config, k, v);
  }
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

/** Which outside sign-in providers the shop offers its customers. Both are off until the owner switches them on; a provider also needs its app registration on the server. */
export interface SigninProviders { google: boolean; microsoft: boolean }
export const DEFAULT_SIGNIN: SigninProviders = { google: false, microsoft: false };
export function cleanSignin(v: unknown, base: SigninProviders = DEFAULT_SIGNIN): SigninProviders | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const one = (x: unknown, d: boolean): boolean | null => (x === undefined ? d : typeof x === "boolean" ? x : null);
  const google = one(o.google, base.google), microsoft = one(o.microsoft, base.microsoft);
  return google === null || microsoft === null ? null : { google, microsoft };
}
export async function loadSignin(db: Db, merchantId: string): Promise<SigninProviders> {
  const r = await db.query("SELECT value FROM merchant_settings WHERE merchant_id=$1 AND key='signin'", [merchantId]);
  return cleanSignin(r.rows[0]?.value) ?? DEFAULT_SIGNIN;
}
export async function saveSignin(db: Db, merchantId: string, v: SigninProviders): Promise<void> {
  await db.query("INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'signin',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [merchantId, JSON.stringify(v)]);
}
