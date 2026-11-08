import { randomBytes } from "node:crypto";
import { validateCatalog, type Catalog, type Channel, type ChannelKind, type PricebookAssignment, type Product } from "@pos/core";
import type pg from "pg";
import type { Db } from "./db/pool.js";

export interface CatalogStore {
  load(): Promise<Catalog>;
}

export class StaticCatalogStore implements CatalogStore {
  constructor(private readonly catalog: Catalog) {}
  async load() {
    return this.catalog;
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

  /** Load the sample catalog the first time a merchant has none. */
  async ensureSeeded(seed: Catalog): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        "INSERT INTO catalog_meta (merchant_id, version, default_pricebook_id) VALUES ($1,1,$2) ON CONFLICT DO NOTHING RETURNING 1",
        [this.merchantId, seed.defaultPricebookId],
      );
      if (ins.rowCount) {
        const m = this.merchantId;
        for (const p of seed.products)
          await client.query("INSERT INTO products (merchant_id,id,name,category,sold_out,points_exempt) VALUES ($1,$2,$3,$4,$5,$6)", [m, p.id, p.name, p.category, !!p.soldOut, !!p.pointsExempt]);
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

  load(): Promise<Catalog> {
    return this.read(this.db);
  }

  private async read(q: Pick<pg.Pool, "query">): Promise<Catalog> {
    const m = this.merchantId;
    const [meta, products, books, prices, channels, assigns] = await Promise.all([
      q.query("SELECT version, default_pricebook_id FROM catalog_meta WHERE merchant_id=$1", [m]),
      q.query("SELECT id,name,category,sold_out,points_exempt FROM products WHERE merchant_id=$1 ORDER BY sort", [m]),
      q.query("SELECT id,name,missing FROM pricebooks WHERE merchant_id=$1 ORDER BY name", [m]),
      q.query("SELECT pricebook_id, product_id, price_cents FROM pricebook_prices WHERE merchant_id=$1", [m]),
      q.query("SELECT id,name,kind,service_charge,active FROM channels WHERE merchant_id=$1 ORDER BY sort", [m]),
      q.query("SELECT pricebook_id, outlet_id, channel_id FROM pricebook_assignments WHERE merchant_id=$1", [m]),
    ]);
    if (!meta.rows[0]) throw new Error("catalog not initialised");
    const pb = new Map<string, Record<string, number>>(books.rows.map((b) => [b.id as string, {}]));
    for (const r of prices.rows) {
      const book = pb.get(r.pricebook_id as string);
      if (book) book[r.product_id as string] = Number(r.price_cents);
    }
    return {
      version: Number(meta.rows[0].version),
      defaultPricebookId: meta.rows[0].default_pricebook_id,
      products: products.rows.map((p): Product => ({ id: p.id, name: p.name, category: p.category, soldOut: p.sold_out || undefined, pointsExempt: p.points_exempt || undefined })),
      pricebooks: books.rows.map((b) => ({ id: b.id, name: b.name, missing: b.missing, prices: pb.get(b.id)! })),
      channels: channels.rows.map((c): Channel => ({ id: c.id, name: c.name, kind: c.kind as ChannelKind, serviceCharge: c.service_charge, active: c.active })),
      assignments: assigns.rows.map((a): PricebookAssignment => ({ pricebookId: a.pricebook_id, outletId: a.outlet_id ?? undefined, channelId: a.channel_id ?? undefined })),
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

  createPricebook(name: string, missing: "fallback" | "hide") {
    return this.change(async (c) => {
      const id = shortId("pb");
      await c.query("INSERT INTO pricebooks (merchant_id,id,name,missing) VALUES ($1,$2,$3,$4)", [this.merchantId, id, name, missing]);
      return { id, name, missing };
    });
  }

  updatePricebook(id: string, patch: { name?: string; missing?: "fallback" | "hide" }) {
    return this.change(async (c) => {
      const r = await c.query(
        "UPDATE pricebooks SET name=COALESCE($3,name), missing=COALESCE($4,missing) WHERE merchant_id=$1 AND id=$2 RETURNING id",
        [this.merchantId, id, patch.name ?? null, patch.missing ?? null],
      );
      if (!r.rowCount) throw new ChangeError("pricebook not found");
      return { ...patch, id };
    });
  }

  upsertChannel(ch: { id?: string; name: string; kind: ChannelKind; serviceCharge: boolean; active: boolean }) {
    return this.change(async (c) => {
      const id = ch.id ?? shortId("ch");
      await c.query(
        `INSERT INTO channels (merchant_id,id,name,kind,service_charge,active) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (merchant_id,id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, service_charge=EXCLUDED.service_charge, active=EXCLUDED.active`,
        [this.merchantId, id, ch.name, ch.kind, ch.serviceCharge, ch.active],
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

  /** Add a product (with its price in the default pricebook) or edit an existing one. */
  upsertProduct(p: { id?: string; name: string; category: string; soldOut?: boolean; pointsExempt?: boolean; priceCents?: number }) {
    return this.change(async (c) => {
      const m = this.merchantId;
      const id = p.id ?? shortId("item");
      const existing = await c.query("SELECT 1 FROM products WHERE merchant_id=$1 AND id=$2", [m, id]);
      if (!existing.rowCount && p.priceCents === undefined) throw new ChangeError("a new product needs a price");
      await c.query(
        `INSERT INTO products (merchant_id,id,name,category,sold_out,points_exempt) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (merchant_id,id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, sold_out=EXCLUDED.sold_out, points_exempt=EXCLUDED.points_exempt`,
        [m, id, p.name, p.category, !!p.soldOut, !!p.pointsExempt],
      );
      if (p.priceCents !== undefined) {
        const def = (await c.query("SELECT default_pricebook_id FROM catalog_meta WHERE merchant_id=$1", [m])).rows[0].default_pricebook_id as string;
        await c.query(
          `INSERT INTO pricebook_prices (merchant_id,pricebook_id,product_id,price_cents) VALUES ($1,$2,$3,$4)
           ON CONFLICT (merchant_id,pricebook_id,product_id) DO UPDATE SET price_cents=EXCLUDED.price_cents`,
          [m, def, id, p.priceCents],
        );
      }
      return { ...p, id, created: !existing.rowCount };
    });
  }
}

class ChangeError extends Error {}
