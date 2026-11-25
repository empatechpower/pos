import { randomBytes } from "node:crypto";
import { validateCatalog, withComboAvailability, type BuilderSpec, type Catalog, type Channel, type ChannelKind, type OptionGroup, type PricebookAssignment, type PriceOverride, type PriceZone, type Product, type ProductStock } from "@pos/core";
import { MAX_IMAGE_BYTES, sniffImage } from "./brand.js";
import type pg from "pg";
import type { Db } from "./db/pool.js";

export interface CatalogStore {
  load(): Promise<Catalog>;
  /** Just the version number: one small query, for devices to ask "has the menu changed?" */
  version(): Promise<number>;
}

export class StaticCatalogStore implements CatalogStore {
  constructor(private readonly catalog: Catalog) {}
  async load() {
    return this.catalog;
  }
  async version() {
    return this.catalog.version;
  }
}

export type ChangeResult = { ok: true; version: number; detail: Record<string, unknown> } | { ok: false; problems: string[] };

const shortId = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`;

/**
 * Postgres catalog for one merchant. Every change runs in one transaction that locks the catalog,
 * applies the edit, re-validates the whole result, and bumps the version. A change that would leave
 * the catalog inconsistent is rolled back and reported, never half-applied.
 */
export class PgCatalogStore implements CatalogStore {
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
  ) {}

  /** Load a starting catalog (and photos, if given) the first time a merchant has none. */
  async ensureSeeded(seed: Catalog, images?: ReadonlyMap<string, { bytes: Buffer; type: string }>): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        "INSERT INTO catalog_meta (merchant_id, version, default_pricebook_id) VALUES ($1,1,$2) ON CONFLICT DO NOTHING RETURNING 1",
        [this.merchantId, seed.defaultPricebookId],
      );
      if (ins.rowCount) {
        const m = this.merchantId;
        for (const p of seed.products) {
          const img = images?.get(p.id);
          await client.query(
            "INSERT INTO products (merchant_id,id,name,category,sold_out,points_exempt,description,alt_name,options,image_version,bcrs,names,builder,tax_inclusive,tax_group) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)",
            [m, p.id, p.name, p.category, !!p.soldOut, !!p.pointsExempt, p.description ?? null, p.altName ?? null, p.options ? JSON.stringify(p.options) : null, img ? 1 : 0, !!p.bcrs, p.names && Object.keys(p.names).length ? JSON.stringify(p.names) : null, p.builder ? JSON.stringify(p.builder) : null, p.taxInclusive ?? null, p.taxGroup ?? null],
          );
          if (img) await client.query("INSERT INTO product_images (merchant_id,product_id,bytes,type,version) VALUES ($1,$2,$3,$4,1)", [m, p.id, img.bytes, img.type]);
        }
        for (const b of seed.pricebooks) {
          await client.query("INSERT INTO pricebooks (merchant_id,id,name,missing) VALUES ($1,$2,$3,$4)", [m, b.id, b.name, b.missing]);
          for (const [pid, cents] of Object.entries(b.prices))
            await client.query("INSERT INTO pricebook_prices (merchant_id,pricebook_id,product_id,price_cents) VALUES ($1,$2,$3,$4)", [m, b.id, pid, cents]);
        }
        for (const c of seed.channels)
          await client.query("INSERT INTO channels (merchant_id,id,name,kind,service_charge,active) VALUES ($1,$2,$3,$4,$5,$6)", [m, c.id, c.name, c.kind, c.serviceCharge, c.active]);
        for (const a of seed.assignments)
          await client.query("INSERT INTO pricebook_assignments (merchant_id,pricebook_id,outlet_id,channel_id) VALUES ($1,$2,$3,$4)", [m, a.pricebookId, a.outletId ?? null, a.channelId ?? null]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async load(): Promise<Catalog> {
    return withComboAvailability(await this.read(this.db));
  }

  async version(): Promise<number> {
    const r = await this.db.query("SELECT version FROM catalog_meta WHERE merchant_id=$1", [this.merchantId]);
    return Number(r.rows[0]?.version ?? 0);
  }

  private async read(q: Pick<pg.Pool, "query">): Promise<Catalog> {
    const m = this.merchantId;
    const [meta, products, books, prices, channels, assigns, offs, catNames, zoneRows, zoneOutlets, zoneBooks, overrideRows] = await Promise.all([
      q.query("SELECT version, default_pricebook_id FROM catalog_meta WHERE merchant_id=$1", [m]),
      q.query("SELECT id,name,category,sold_out,points_exempt,description,alt_name,options,image_version,bcrs,names,builder,tax_inclusive,tax_group,stock FROM products WHERE merchant_id=$1 ORDER BY sort", [m]),
      q.query("SELECT id,name,missing FROM pricebooks WHERE merchant_id=$1 ORDER BY name", [m]),
      q.query("SELECT pricebook_id, product_id, price_cents, member_price_cents FROM pricebook_prices WHERE merchant_id=$1", [m]),
      q.query("SELECT id,name,kind,service_charge,active,commission_rate_pct FROM channels WHERE merchant_id=$1 ORDER BY sort", [m]),
      q.query("SELECT pricebook_id, outlet_id, channel_id FROM pricebook_assignments WHERE merchant_id=$1", [m]),
      q.query("SELECT pricebook_id, product_id FROM pricebook_off WHERE merchant_id=$1", [m]),
      q.query("SELECT category, names FROM category_names WHERE merchant_id=$1", [m]),
      q.query("SELECT id, name FROM price_zones WHERE merchant_id=$1 ORDER BY name", [m]),
      q.query("SELECT outlet_id, zone_id FROM price_zone_outlets WHERE merchant_id=$1 ORDER BY outlet_id", [m]),
      q.query("SELECT zone_id, channel_id, pricebook_id FROM price_zone_books WHERE merchant_id=$1", [m]),
      q.query("SELECT id, title, product_id, pricebook_id, price_cents, starts_at, ends_at FROM price_overrides WHERE merchant_id=$1 ORDER BY starts_at, id", [m]),
    ]);
    const liveCategories = new Set(products.rows.map((p) => p.category as string));
    const categoryNames: Record<string, Record<string, string>> = {};
    for (const r of catNames.rows) if (liveCategories.has(r.category as string) && r.names && Object.keys(r.names).length) categoryNames[r.category as string] = r.names as Record<string, string>;
    const offBy = new Map<string, string[]>();
    for (const r of offs.rows) offBy.set(r.pricebook_id as string, [...(offBy.get(r.pricebook_id as string) ?? []), r.product_id as string]);
    if (!meta.rows[0]) throw new Error("catalog not initialised");
    const pb = new Map<string, Record<string, number>>(books.rows.map((b) => [b.id as string, {}]));
    const memberBy = new Map<string, Record<string, number>>();
    for (const r of prices.rows) {
      const book = pb.get(r.pricebook_id as string);
      if (book) book[r.product_id as string] = Number(r.price_cents);
      if (book && r.member_price_cents !== null && r.member_price_cents !== undefined) { const mb = memberBy.get(r.pricebook_id as string) ?? {}; mb[r.product_id as string] = Number(r.member_price_cents); memberBy.set(r.pricebook_id as string, mb); }
    }
    return {
      version: Number(meta.rows[0].version),
      defaultPricebookId: meta.rows[0].default_pricebook_id,
      products: products.rows.map(
        (p): Product => ({
          id: p.id,
          name: p.name,
          category: p.category,
          soldOut: p.sold_out || undefined,
          pointsExempt: p.points_exempt || undefined,
          bcrs: p.bcrs || undefined,
          description: p.description ?? undefined,
          altName: p.alt_name ?? undefined,
          ...(p.names && Object.keys(p.names).length ? { names: p.names as Record<string, string> } : {}),
          imageVersion: p.image_version || undefined,
          options: (p.options as OptionGroup[] | null) ?? undefined,
          ...(p.builder ? { builder: p.builder as BuilderSpec } : {}),
          ...(p.tax_inclusive !== null && p.tax_inclusive !== undefined ? { taxInclusive: p.tax_inclusive as boolean } : {}),
          ...(p.tax_group ? { taxGroup: p.tax_group as string } : {}),
          ...(p.stock ? { stock: p.stock as ProductStock } : {}),
        }),
      ),
      pricebooks: books.rows.map((b) => ({ id: b.id, name: b.name, missing: b.missing, prices: pb.get(b.id)!, ...(offBy.get(b.id)?.length ? { off: offBy.get(b.id)! } : {}), ...(memberBy.get(b.id) ? { memberPrices: memberBy.get(b.id)! } : {}) })),
      channels: channels.rows.map((c): Channel => ({ id: c.id, name: c.name, kind: c.kind as ChannelKind, serviceCharge: c.service_charge, active: c.active, ...(c.commission_rate_pct !== null && c.commission_rate_pct !== undefined ? { commission: { ratePct: Number(c.commission_rate_pct) } } : {}) })),
      assignments: assigns.rows.map((a): PricebookAssignment => ({ pricebookId: a.pricebook_id, outletId: a.outlet_id ?? undefined, channelId: a.channel_id ?? undefined })),
      ...(zoneRows.rows.length
        ? {
            zones: zoneRows.rows.map((z): PriceZone => ({
              id: z.id,
              name: z.name,
              outletIds: zoneOutlets.rows.filter((o) => o.zone_id === z.id).map((o) => o.outlet_id as string),
              books: zoneBooks.rows.filter((b) => b.zone_id === z.id).map((b) => ({ ...(b.channel_id ? { channelId: b.channel_id as string } : {}), pricebookId: b.pricebook_id as string })),
            })),
          }
        : {}),
      ...(overrideRows.rows.length
        ? { overrides: overrideRows.rows.map((o): PriceOverride => ({ id: o.id, title: o.title, productId: o.product_id, ...(o.pricebook_id ? { pricebookId: o.pricebook_id as string } : {}), priceCents: Number(o.price_cents), startsAt: new Date(o.starts_at).getTime(), endsAt: new Date(o.ends_at).getTime() })) }
        : {}),
      ...(Object.keys(categoryNames).length ? { categoryNames } : {}),
    };
  }

  /** Lock, edit, validate the result, bump the version. */
  private async change(edit: (c: pg.PoolClient) => Promise<Record<string, unknown>>): Promise<ChangeResult> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM catalog_meta WHERE merchant_id=$1 FOR UPDATE", [this.merchantId]);
      const detail = await edit(client);
      const problems = validateCatalog(await this.read(client));
      if (problems.length) {
        await client.query("ROLLBACK");
        return { ok: false, problems };
      }
      const v = await client.query("UPDATE catalog_meta SET version = version + 1 WHERE merchant_id=$1 RETURNING version", [this.merchantId]);
      await client.query("COMMIT");
      return { ok: true, version: Number(v.rows[0].version), detail };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e instanceof ChangeError) return { ok: false, problems: [e.message] };
      throw e;
    } finally {
      client.release();
    }
  }

  /** Set a product's price in a pricebook, or remove it (null) so it falls through to the next book. */
  setPrice(pricebookId: string, productId: string, priceCents: number | null) {
    return this.change(async (c) => {
      const m = this.merchantId;
      const old = await c.query("SELECT price_cents FROM pricebook_prices WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, productId]);
      const previous = old.rows[0] ? Number(old.rows[0].price_cents) : null;
      if (priceCents === null) {
        await c.query("DELETE FROM pricebook_prices WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, productId]);
      } else {
        if (!(await c.query("SELECT 1 FROM pricebooks WHERE merchant_id=$1 AND id=$2", [m, pricebookId])).rowCount) throw new ChangeError("pricebook not found");
        if (!(await c.query("SELECT 1 FROM products WHERE merchant_id=$1 AND id=$2", [m, productId])).rowCount) throw new ChangeError("product not found");
        await c.query(
          `INSERT INTO pricebook_prices (merchant_id,pricebook_id,product_id,price_cents) VALUES ($1,$2,$3,$4)
           ON CONFLICT (merchant_id,pricebook_id,product_id) DO UPDATE SET price_cents=EXCLUDED.price_cents`,
          [m, pricebookId, productId, priceCents],
        );
      }
      return { pricebookId, productId, previous, priceCents };
    });
  }

  /** Switch an item off (or back on) in one pricebook. It keeps its price there. */
  setOff(pricebookId: string, productId: string, off: boolean) {
    return this.change(async (c) => {
      const m = this.merchantId;
      if (!(await c.query("SELECT 1 FROM pricebooks WHERE merchant_id=$1 AND id=$2", [m, pricebookId])).rowCount) throw new ChangeError("pricebook not found");
      if (!(await c.query("SELECT 1 FROM products WHERE merchant_id=$1 AND id=$2", [m, productId])).rowCount) throw new ChangeError("product not found");
      if (off) await c.query("INSERT INTO pricebook_off (merchant_id,pricebook_id,product_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [m, pricebookId, productId]);
      else await c.query("DELETE FROM pricebook_off WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, productId]);
      return { pricebookId, productId, off };
    });
  }

  /**
   * Change many items in one pricebook in one step: a price in cents (0 is a real price), null to remove the price, and/or
   * on or off. Either everything is applied or nothing is.
   */
  bulkUpdate(pricebookId: string, edits: { prices?: Record<string, number | null>; off?: Record<string, boolean>; memberPrices?: Record<string, number | null> }) {
    return this.change(async (c) => {
      const m = this.merchantId;
      if (!(await c.query("SELECT 1 FROM pricebooks WHERE merchant_id=$1 AND id=$2", [m, pricebookId])).rowCount) throw new ChangeError("pricebook not found");
      const known = new Set((await c.query("SELECT id FROM products WHERE merchant_id=$1", [m])).rows.map((r) => r.id as string));
      let priced = 0, cleared = 0, switched = 0;
      for (const [pid, cents] of Object.entries(edits.prices ?? {})) {
        if (!known.has(pid)) throw new ChangeError(`unknown item ${pid}`);
        if (cents === null) {
          await c.query("DELETE FROM pricebook_prices WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, pid]);
          cleared++;
        } else {
          if (!Number.isSafeInteger(cents) || cents < 0) throw new ChangeError(`invalid price for ${pid}`);
          await c.query(
            `INSERT INTO pricebook_prices (merchant_id,pricebook_id,product_id,price_cents) VALUES ($1,$2,$3,$4)
             ON CONFLICT (merchant_id,pricebook_id,product_id) DO UPDATE SET price_cents=EXCLUDED.price_cents`,
            [m, pricebookId, pid, cents],
          );
          priced++;
        }
      }
      // A member price sits on an item that has a price here, and is never above it (it only ever lowers what a member pays).
      for (const [pid, cents] of Object.entries(edits.memberPrices ?? {})) {
        if (!known.has(pid)) throw new ChangeError(`unknown item ${pid}`);
        const row = await c.query("SELECT price_cents FROM pricebook_prices WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, pid]);
        if (cents === null) { await c.query("UPDATE pricebook_prices SET member_price_cents=NULL WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, pid]); continue; }
        if (!row.rows[0]) throw new ChangeError(`give ${pid} a price before a member price`);
        if (!Number.isSafeInteger(cents) || cents < 0 || cents > Number(row.rows[0].price_cents)) throw new ChangeError(`the member price for ${pid} must be between 0 and its price`);
        await c.query("UPDATE pricebook_prices SET member_price_cents=$4 WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, pid, cents]);
        priced++;
      }
      for (const [pid, off] of Object.entries(edits.off ?? {})) {
        if (!known.has(pid)) throw new ChangeError(`unknown item ${pid}`);
        if (off) await c.query("INSERT INTO pricebook_off (merchant_id,pricebook_id,product_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [m, pricebookId, pid]);
        else await c.query("DELETE FROM pricebook_off WHERE merchant_id=$1 AND pricebook_id=$2 AND product_id=$3", [m, pricebookId, pid]);
        switched++;
      }
      return { pricebookId, priced, cleared, switched };
    });
  }

  /**
   * Make a new pricebook that is a copy of another (the default, "Dine in", unless told otherwise): every price and every
   * on/off switch. It also makes a new channel with the new name, copied from the channel that uses the source book
   * (its kind and service charge, or the kind asked for), and points that channel at the new book.
   */
  clonePricebook(name: string, o: { fromPricebookId?: string; kind?: ChannelKind } = {}) {
    return this.change(async (c) => {
      const m = this.merchantId;
      const from = o.fromPricebookId ?? ((await c.query("SELECT default_pricebook_id FROM catalog_meta WHERE merchant_id=$1", [m])).rows[0].default_pricebook_id as string);
      const src = await c.query("SELECT missing FROM pricebooks WHERE merchant_id=$1 AND id=$2", [m, from]);
      if (!src.rows[0]) throw new ChangeError("pricebook to copy not found");
      const id = shortId("pb");
      await c.query("INSERT INTO pricebooks (merchant_id,id,name,missing) VALUES ($1,$2,$3,$4)", [m, id, name, src.rows[0].missing]);
      const prices = await c.query("INSERT INTO pricebook_prices (merchant_id,pricebook_id,product_id,price_cents,member_price_cents) SELECT merchant_id, $3, product_id, price_cents, member_price_cents FROM pricebook_prices WHERE merchant_id=$1 AND pricebook_id=$2", [m, from, id]);
      await c.query("INSERT INTO pricebook_off (merchant_id,pricebook_id,product_id) SELECT merchant_id, $3, product_id FROM pricebook_off WHERE merchant_id=$1 AND pricebook_id=$2", [m, from, id]);
      // The channel to copy: the one that uses the source book, else a dine-in channel, else any.
      const srcChannel = (
        await c.query(
          `SELECT ch.* FROM channels ch
            WHERE ch.merchant_id=$1 AND (ch.id IN (SELECT channel_id FROM pricebook_assignments WHERE merchant_id=$1 AND pricebook_id=$2 AND channel_id IS NOT NULL) OR ch.kind='dine_in')
            ORDER BY (ch.id IN (SELECT channel_id FROM pricebook_assignments WHERE merchant_id=$1 AND pricebook_id=$2 AND channel_id IS NOT NULL)) DESC, ch.sort LIMIT 1`,
          [m, from],
        )
      ).rows[0];
      const channelId = shortId("ch");
      const kind = (o.kind ?? srcChannel?.kind ?? "dine_in") as ChannelKind;
      await c.query("INSERT INTO channels (merchant_id,id,name,kind,service_charge,active) VALUES ($1,$2,$3,$4,$5,true)", [m, channelId, name, kind, o.kind && srcChannel && o.kind !== srcChannel.kind ? kind === "dine_in" : !!srcChannel?.service_charge]);
      await c.query("INSERT INTO pricebook_assignments (merchant_id,pricebook_id,outlet_id,channel_id) VALUES ($1,$2,NULL,$3)", [m, id, channelId]);
      return { id, name, channelId, kind, copiedPrices: prices.rowCount ?? 0 };
    });
  }

  createPricebook(name: string, missing: "show" | "hide") {
    return this.change(async (c) => {
      const id = shortId("pb");
      await c.query("INSERT INTO pricebooks (merchant_id,id,name,missing) VALUES ($1,$2,$3,$4)", [this.merchantId, id, name, missing]);
      return { id, name, missing };
    });
  }

  updatePricebook(id: string, patch: { name?: string; missing?: "show" | "hide" }) {
    return this.change(async (c) => {
      const r = await c.query(
        "UPDATE pricebooks SET name=COALESCE($3,name), missing=COALESCE($4,missing) WHERE merchant_id=$1 AND id=$2 RETURNING id",
        [this.merchantId, id, patch.name ?? null, patch.missing ?? null],
      );
      if (!r.rowCount) throw new ChangeError("pricebook not found");
      return { ...patch, id };
    });
  }

  /** `commission`: undefined keeps what is there, null stops recording commission for the channel, { ratePct } starts it. */
  upsertChannel(ch: { id?: string; name: string; kind: ChannelKind; serviceCharge: boolean; active: boolean; commission?: { ratePct: number } | null }) {
    return this.change(async (c) => {
      const id = ch.id ?? shortId("ch");
      await c.query(
        `INSERT INTO channels (merchant_id,id,name,kind,service_charge,active,commission_rate_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (merchant_id,id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, service_charge=EXCLUDED.service_charge, active=EXCLUDED.active,
           commission_rate_pct = CASE WHEN $8 THEN EXCLUDED.commission_rate_pct ELSE channels.commission_rate_pct END`,
        [this.merchantId, id, ch.name, ch.kind, ch.serviceCharge, ch.active, ch.commission ? ch.commission.ratePct : null, ch.commission !== undefined],
      );
      return { ...ch, id };
    });
  }

  assign(pricebookId: string, outletId?: string, channelId?: string) {
    return this.change(async (c) => {
      await c.query(
        `INSERT INTO pricebook_assignments (merchant_id,pricebook_id,outlet_id,channel_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (merchant_id, COALESCE(outlet_id,''), COALESCE(channel_id,'')) DO UPDATE SET pricebook_id=EXCLUDED.pricebook_id`,
        [this.merchantId, pricebookId, outletId ?? null, channelId ?? null],
      );
      return { pricebookId, outletId: outletId ?? null, channelId: channelId ?? null };
    });
  }

  /** Create or replace a Price Zone: its name, its outlets (taken from any other zone) and its pricebook per channel. HQ only (the route checks). */
  saveZone(z: { id?: string; name: string; outletIds: string[]; books: Array<{ channelId?: string; pricebookId: string }> }) {
    return this.change(async (c) => {
      const m = this.merchantId;
      const id = z.id?.trim() || z.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `zone-${Date.now().toString(36)}`;
      await c.query("INSERT INTO price_zones (merchant_id,id,name) VALUES ($1,$2,$3) ON CONFLICT (merchant_id,id) DO UPDATE SET name=EXCLUDED.name", [m, id, z.name.trim()]);
      await c.query("DELETE FROM price_zone_outlets WHERE merchant_id=$1 AND (zone_id=$2 OR outlet_id = ANY($3::text[]))", [m, id, z.outletIds]);
      for (const o of [...new Set(z.outletIds)]) await c.query("INSERT INTO price_zone_outlets (merchant_id,outlet_id,zone_id) VALUES ($1,$2,$3)", [m, o, id]);
      await c.query("DELETE FROM price_zone_books WHERE merchant_id=$1 AND zone_id=$2", [m, id]);
      for (const b of z.books) await c.query("INSERT INTO price_zone_books (merchant_id,zone_id,channel_id,pricebook_id) VALUES ($1,$2,$3,$4)", [m, id, b.channelId ?? null, b.pricebookId]);
      return { id };
    });
  }

  /** Create or replace a promotional price. */
  saveOverride(o: { id?: string; title: string; productId: string; pricebookId?: string; priceCents: number; startsAt: number; endsAt: number }) {
    return this.change(async (c) => {
      const id = o.id?.trim() || shortId("promo");
      await c.query(
        `INSERT INTO price_overrides (merchant_id,id,title,product_id,pricebook_id,price_cents,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($8/1000.0))
         ON CONFLICT (merchant_id,id) DO UPDATE SET title=EXCLUDED.title, product_id=EXCLUDED.product_id, pricebook_id=EXCLUDED.pricebook_id, price_cents=EXCLUDED.price_cents, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at`,
        [this.merchantId, id, o.title.trim(), o.productId, o.pricebookId ?? null, o.priceCents, o.startsAt, o.endsAt],
      );
      return { id };
    });
  }

  deleteOverride(id: string) {
    return this.change(async (c) => {
      await c.query("DELETE FROM price_overrides WHERE merchant_id=$1 AND id=$2", [this.merchantId, id]);
      return { id };
    });
  }

  deleteZone(id: string) {
    return this.change(async (c) => {
      const m = this.merchantId;
      await c.query("DELETE FROM price_zone_books WHERE merchant_id=$1 AND zone_id=$2", [m, id]);
      await c.query("DELETE FROM price_zone_outlets WHERE merchant_id=$1 AND zone_id=$2", [m, id]);
      await c.query("DELETE FROM price_zones WHERE merchant_id=$1 AND id=$2", [m, id]);
      return { id };
    });
  }

  unassign(outletId?: string, channelId?: string) {
    return this.change(async (c) => {
      await c.query(
        "DELETE FROM pricebook_assignments WHERE merchant_id=$1 AND COALESCE(outlet_id,'')=COALESCE($2,'') AND COALESCE(channel_id,'')=COALESCE($3,'')",
        [this.merchantId, outletId ?? null, channelId ?? null],
      );
      return { outletId: outletId ?? null, channelId: channelId ?? null };
    });
  }

  setDefaultPricebook(id: string) {
    return this.change(async (c) => {
      await c.query("UPDATE catalog_meta SET default_pricebook_id=$2 WHERE merchant_id=$1", [this.merchantId, id]);
      return { id };
    });
  }

  /**
   * Add a product (with its price in the default pricebook) or edit an existing one. Fields that are not
   * sent are left as they are, so a quick "mark sold out" can never wipe a description or its options.
   * To clear one, send an empty string (text) or an empty list (options).
   */
  upsertProduct(p: { id?: string; name: string; category: string; soldOut?: boolean; pointsExempt?: boolean; bcrs?: boolean; priceCents?: number; description?: string; altName?: string; names?: Record<string, string>; builder?: BuilderSpec | null; taxInclusive?: boolean | null; taxGroup?: string | null; stock?: ProductStock | null; options?: OptionGroup[] }) {
    return this.change(async (c) => {
      const m = this.merchantId;
      const id = p.id ?? shortId("item");
      const existing = await c.query("SELECT 1 FROM products WHERE merchant_id=$1 AND id=$2", [m, id]);
      if (!existing.rowCount && p.priceCents === undefined) throw new ChangeError("a new product needs a price");
      const text = (v: string | undefined) => (v === undefined ? [false, null] : [true, v.trim() === "" ? null : v.trim()]);
      const [descGiven, desc] = text(p.description);
      const [altGiven, alt] = text(p.altName);
      const optsGiven = p.options !== undefined;
      // Names in other languages: sent = the whole list is replaced (a blank one is dropped); not sent = left as it is.
      const namesGiven = p.names !== undefined;
      const cleanNames = Object.fromEntries(Object.entries(p.names ?? {}).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([k, v]) => /^[a-z]{2,3}$/.test(k as string) && v));
      // A NEW item whose name says BCRS gets the container deposit switched on (handover 8); for an existing item, not sent = left as it is,
      // so a rename or a sold-out toggle never switches the deposit off. (An explicit true/false always wins.)
      const autoBcrs = !existing.rowCount && p.bcrs === undefined && /bcrs/i.test(p.name);
      const bcrsGiven = p.bcrs !== undefined || autoBcrs;
      // A builder spec sent replaces the old one (null removes it); not sent = left as it is. Its rules are checked with the whole catalogue before it is kept.
      const builderGiven = p.builder !== undefined;
      // Tax: sent = set (null clears back to the merchant default), not sent = left as it is.
      const taxGiven = p.taxInclusive !== undefined;
      const groupGiven = p.taxGroup !== undefined;
      // Stock basis: sent = set (null stops tracking), not sent = left as it is.
      const stockGiven = p.stock !== undefined;
      await c.query(
        `INSERT INTO products (merchant_id,id,name,category,sold_out,points_exempt,description,alt_name,options,bcrs,names,builder,tax_inclusive,tax_group,stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$13,$15::jsonb,$17::jsonb,$19,$21,$23::jsonb)
         ON CONFLICT (merchant_id,id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, sold_out=EXCLUDED.sold_out, points_exempt=EXCLUDED.points_exempt,
           description = CASE WHEN $10 THEN EXCLUDED.description ELSE products.description END,
           alt_name    = CASE WHEN $11 THEN EXCLUDED.alt_name    ELSE products.alt_name    END,
           options     = CASE WHEN $12 THEN EXCLUDED.options     ELSE products.options     END,
           bcrs        = CASE WHEN $14 THEN EXCLUDED.bcrs        ELSE products.bcrs        END,
           names       = CASE WHEN $16 THEN EXCLUDED.names       ELSE products.names       END,
           builder     = CASE WHEN $18 THEN EXCLUDED.builder     ELSE products.builder     END,
           tax_inclusive = CASE WHEN $20 THEN EXCLUDED.tax_inclusive ELSE products.tax_inclusive END,
           tax_group   = CASE WHEN $22 THEN EXCLUDED.tax_group   ELSE products.tax_group   END,
           stock       = CASE WHEN $24 THEN EXCLUDED.stock       ELSE products.stock       END`,
        [m, id, p.name, p.category, !!p.soldOut, !!p.pointsExempt, desc, alt, optsGiven && p.options!.length ? JSON.stringify(p.options) : null, descGiven, altGiven, optsGiven, !!(p.bcrs ?? autoBcrs), bcrsGiven, Object.keys(cleanNames).length ? JSON.stringify(cleanNames) : null, namesGiven, p.builder ? JSON.stringify(p.builder) : null, builderGiven, p.taxInclusive ?? null, taxGiven, (p.taxGroup ?? "").trim() || null, groupGiven, p.stock ? JSON.stringify(p.stock) : null, stockGiven],
      );
      if (p.priceCents !== undefined) {
        const def = (await c.query("SELECT default_pricebook_id FROM catalog_meta WHERE merchant_id=$1", [m])).rows[0].default_pricebook_id as string;
        await c.query(
          `INSERT INTO pricebook_prices (merchant_id,pricebook_id,product_id,price_cents) VALUES ($1,$2,$3,$4)
           ON CONFLICT (merchant_id,pricebook_id,product_id) DO UPDATE SET price_cents=EXCLUDED.price_cents`,
          [m, def, id, p.priceCents],
        );
      }
      return { id, created: !existing.rowCount, name: p.name, category: p.category };
    });
  }

  /** Rename a category: every item in it moves, and printers that list it keep printing it. Naming an existing category merges the two. */
  renameCategory(from: string, to: string, names?: Record<string, string>) {
    return this.change(async (c) => {
      const m = this.merchantId;
      const r = await c.query("UPDATE products SET category=$3 WHERE merchant_id=$1 AND category=$2", [m, from, to]);
      if (!r.rowCount) throw new ChangeError("category not found");
      await c.query("UPDATE printers SET categories = array_replace(categories, $3, $2) WHERE merchant_id=$1 AND $3 = ANY(categories)", [m, to, from]);
      if (from !== to) {
        // The names follow the category; merging into an existing one keeps that one's own names where both have the same language.
        const old = (await c.query("DELETE FROM category_names WHERE merchant_id=$1 AND category=$2 RETURNING names", [m, from])).rows[0]?.names as Record<string, string> | undefined;
        if (old) {
          const there = (await c.query("SELECT names FROM category_names WHERE merchant_id=$1 AND category=$2", [m, to])).rows[0]?.names as Record<string, string> | undefined;
          await c.query("INSERT INTO category_names (merchant_id, category, names) VALUES ($1,$2,$3::jsonb) ON CONFLICT (merchant_id, category) DO UPDATE SET names=EXCLUDED.names", [m, to, JSON.stringify({ ...old, ...(there ?? {}) })]);
        }
      }
      // Names sent with the rename replace the whole list (a blank one is dropped); not sent = left as they are.
      if (names !== undefined) {
        const clean = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([k, v]) => /^[a-z]{2,3}$/.test(k as string) && v));
        if (Object.keys(clean).length) await c.query("INSERT INTO category_names (merchant_id, category, names) VALUES ($1,$2,$3::jsonb) ON CONFLICT (merchant_id, category) DO UPDATE SET names=EXCLUDED.names", [m, to, JSON.stringify(clean)]);
        else await c.query("DELETE FROM category_names WHERE merchant_id=$1 AND category=$2", [m, to]);
      }
      return { from, to, items: r.rowCount };
    });
  }

  /** Replace an item's photo. PNG, JPEG or WebP up to 300 KB, checked by content, not by the label. */
  setImage(productId: string, bytes: Buffer) {
    return this.change(async (c) => {
      if (!bytes.length) throw new ChangeError("empty file");
      if (bytes.length > MAX_IMAGE_BYTES) throw new ChangeError("photo must be 300 KB or smaller");
      const type = sniffImage(bytes);
      if (!type) throw new ChangeError("photo must be a PNG, JPEG or WebP image");
      if (!(await c.query("SELECT 1 FROM products WHERE merchant_id=$1 AND id=$2", [this.merchantId, productId])).rowCount) throw new ChangeError("product not found");
      const v = await c.query(
        `INSERT INTO product_images (merchant_id,product_id,bytes,type,version) VALUES ($1,$2,$3,$4,1)
         ON CONFLICT (merchant_id,product_id) DO UPDATE SET bytes=EXCLUDED.bytes, type=EXCLUDED.type, version=product_images.version+1 RETURNING version`,
        [this.merchantId, productId, bytes, type],
      );
      await c.query("UPDATE products SET image_version=$3 WHERE merchant_id=$1 AND id=$2", [this.merchantId, productId, v.rows[0].version]);
      return { productId, bytes: bytes.length, imageVersion: v.rows[0].version };
    });
  }

  async getImage(productId: string): Promise<{ bytes: Buffer; type: string } | null> {
    const r = await this.db.query("SELECT bytes, type FROM product_images WHERE merchant_id=$1 AND product_id=$2", [this.merchantId, productId]);
    return r.rows[0] ? { bytes: r.rows[0].bytes, type: r.rows[0].type } : null;
  }
}

class ChangeError extends Error {}
