import { isHexColor, readableOn } from "@pos/core";
import type { Db } from "./db/pool.js";

export const MAX_IMAGE_BYTES = 300 * 1024;
export const MAX_LOGO_BYTES = MAX_IMAGE_BYTES;
export const DEFAULT_PRIMARY = "#ea7016";
export const DEFAULT_ACCENT = "#fdeee0";

export interface Brand {
  primary: string;
  accent: string;
  /** Text colour that reads well on the primary colour. */
  ink: string;
  logoVersion: number;
  hasLogo: boolean;
  heroVersion: number;
  hasHero: boolean;
  tagline: string | null;
  promoTitle: string | null;
  promoBody: string | null;
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
    const r = await this.db.query(
      `SELECT primary_color, accent_color, logo_version, logo IS NOT NULL AS has_logo, hero_version, hero IS NOT NULL AS has_hero, tagline, promo_title, promo_body
       FROM merchant_brand WHERE merchant_id=$1`,
      [this.merchantId],
    );
    const row = r.rows[0];
    const primary = row?.primary_color ?? DEFAULT_PRIMARY;
    return {
      primary,
      accent: row?.accent_color ?? DEFAULT_ACCENT,
      ink: readableOn(primary),
      logoVersion: row?.logo_version ?? 0,
      hasLogo: !!row?.has_logo,
      heroVersion: row?.hero_version ?? 0,
      hasHero: !!row?.has_hero,
      tagline: row?.tagline ?? null,
      promoTitle: row?.promo_title ?? null,
      promoBody: row?.promo_body ?? null,
    };
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

  /** Returns an error message, or null when saved. */
  async setHero(bytes: Buffer): Promise<string | null> {
    if (bytes.length === 0) return "empty file";
    if (bytes.length > MAX_IMAGE_BYTES) return "photo must be 300 KB or smaller";
    const type = sniffImage(bytes);
    if (!type) return "photo must be a PNG, JPEG or WebP image";
    await this.db.query(
      `INSERT INTO merchant_brand (merchant_id, hero, hero_type, hero_version) VALUES ($1,$2,$3,1)
       ON CONFLICT (merchant_id) DO UPDATE SET hero=EXCLUDED.hero, hero_type=EXCLUDED.hero_type, hero_version=merchant_brand.hero_version+1, updated_at=now()`,
      [this.merchantId, bytes, type],
    );
    return null;
  }

  async getHero(): Promise<{ bytes: Buffer; type: string } | null> {
    const r = await this.db.query("SELECT hero, hero_type FROM merchant_brand WHERE merchant_id=$1 AND hero IS NOT NULL", [this.merchantId]);
    return r.rows[0] ? { bytes: r.rows[0].hero, type: r.rows[0].hero_type } : null;
  }

  /** Tagline under the hero photo and an optional promotion. Plain text only; blank clears it. */
  async setContent(c: { tagline?: string; promoTitle?: string; promoBody?: string }): Promise<string | null> {
    const tidy = (s: string | undefined, max: number) => (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null;
    if ((c.tagline ?? "").length > 80 || (c.promoTitle ?? "").length > 80 || (c.promoBody ?? "").length > 400) return "tagline and promotion title: 80 characters at most; promotion text: 400";
    await this.db.query(
      `INSERT INTO merchant_brand (merchant_id, tagline, promo_title, promo_body) VALUES ($1,$2,$3,$4)
       ON CONFLICT (merchant_id) DO UPDATE SET tagline=EXCLUDED.tagline, promo_title=EXCLUDED.promo_title, promo_body=EXCLUDED.promo_body, updated_at=now()`,
      [this.merchantId, tidy(c.tagline, 80), tidy(c.promoTitle, 80), tidy(c.promoBody, 400)],
    );
    return null;
  }

  /** Give a brand-new shop a starting look. Does nothing if the merchant already has one. */
  async seedIfEmpty(b: { primary: string; accent: string; tagline?: string; logo?: Buffer; hero?: Buffer }): Promise<void> {
    const ins = await this.db.query(
      `INSERT INTO merchant_brand (merchant_id, primary_color, accent_color, tagline) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`,
      [this.merchantId, b.primary, b.accent, b.tagline ?? null],
    );
    if (!ins.rowCount) return;
    if (b.logo) await this.setLogo(b.logo);
    if (b.hero) await this.setHero(b.hero);
  }
}
