import { isHexColor, readableOn } from "@pos/core";
import type { Db } from "./db/pool.js";

export const MAX_LOGO_BYTES = 300 * 1024;
export const DEFAULT_PRIMARY = "#ea7016";
export const DEFAULT_ACCENT = "#fdeee0";

export interface Brand {
  primary: string;
  accent: string;
  /** Text colour that reads well on the primary colour. */
  ink: string;
  logoVersion: number;
  hasLogo: boolean;
}

/** What the file really is, from its first bytes, not from what the uploader claims. */
export function sniffImage(b: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null; // SVG is deliberately not accepted: it can carry scripts
}

/** The merchant's shop look: two colours and a logo. Only PNG, JPEG and WebP logos, up to 300 KB. */
export class BrandStore {
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
  ) {}

  async get(): Promise<Brand> {
    const r = await this.db.query("SELECT primary_color, accent_color, logo_version, logo IS NOT NULL AS has_logo FROM merchant_brand WHERE merchant_id=$1", [this.merchantId]);
    const row = r.rows[0];
    const primary = row?.primary_color ?? DEFAULT_PRIMARY;
    return { primary, accent: row?.accent_color ?? DEFAULT_ACCENT, ink: readableOn(primary), logoVersion: row?.logo_version ?? 0, hasLogo: !!row?.has_logo };
  }

  async setColors(primary: string, accent: string): Promise<string | null> {
    if (!isHexColor(primary) || !isHexColor(accent)) return "colours must look like #ea7016";
    await this.db.query(
      `INSERT INTO merchant_brand (merchant_id, primary_color, accent_color) VALUES ($1,$2,$3)
       ON CONFLICT (merchant_id) DO UPDATE SET primary_color=EXCLUDED.primary_color, accent_color=EXCLUDED.accent_color, updated_at=now()`,
      [this.merchantId, primary.toLowerCase(), accent.toLowerCase()],
    );
    return null;
  }

  /** Returns an error message, or null when saved. */
  async setLogo(bytes: Buffer): Promise<string | null> {
    if (bytes.length === 0) return "empty file";
    if (bytes.length > MAX_LOGO_BYTES) return "logo must be 300 KB or smaller";
    const type = sniffImage(bytes);
    if (!type) return "logo must be a PNG, JPEG or WebP image";
    await this.db.query(
      `INSERT INTO merchant_brand (merchant_id, logo, logo_type, logo_version) VALUES ($1,$2,$3,1)
       ON CONFLICT (merchant_id) DO UPDATE SET logo=EXCLUDED.logo, logo_type=EXCLUDED.logo_type, logo_version=merchant_brand.logo_version+1, updated_at=now()`,
      [this.merchantId, bytes, type],
    );
    return null;
  }

  async getLogo(): Promise<{ bytes: Buffer; type: string } | null> {
    const r = await this.db.query("SELECT logo, logo_type FROM merchant_brand WHERE merchant_id=$1 AND logo IS NOT NULL", [this.merchantId]);
    return r.rows[0] ? { bytes: r.rows[0].logo, type: r.rows[0].logo_type } : null;
  }
}
