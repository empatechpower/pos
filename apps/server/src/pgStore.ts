import type { OrderEvent } from "@pos/core";
import type { Db } from "./db/pool.js";
import type { EventStore, StoredEvent } from "./store.js";

/** Postgres-backed event log. Each event belongs to an outlet; a device syncs only its own outlet's events, reports can read them all. */
export class PgEventStore implements EventStore {
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
    private readonly outletId: string,
  ) {}

  /** Idempotent on event id. Returns only the events that were new. */
  async append(events: OrderEvent[], outletId: string = this.outletId): Promise<StoredEvent[]> {
    if (!events.length) return [];
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.merchantId}/${outletId}`]);
      const added: StoredEvent[] = [];
      for (const e of events) {
        const r = await client.query(
          `INSERT INTO events (id, merchant_id, outlet_id, order_id, device_id, type, body)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING server_seq`,
          [e.id, this.merchantId, outletId, e.orderId, e.deviceId, e.type, JSON.stringify(e)],
        );
        if (r.rowCount) added.push({ serverSeq: Number(r.rows[0].server_seq), event: e, outletId });
      }
      await client.query("COMMIT");
      return added;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async after(serverSeq: number, outletId: string = this.outletId): Promise<StoredEvent[]> {
    const r = await this.db.query(
      "SELECT server_seq, body FROM events WHERE merchant_id=$1 AND outlet_id=$2 AND server_seq > $3 ORDER BY server_seq",
      [this.merchantId, outletId, serverSeq],
    );
    return r.rows.map((row) => ({ serverSeq: Number(row.server_seq), event: row.body as OrderEvent, outletId }));
  }

  async afterAll(serverSeq: number): Promise<StoredEvent[]> {
    const r = await this.db.query("SELECT server_seq, outlet_id, body FROM events WHERE merchant_id=$1 AND server_seq > $2 ORDER BY server_seq", [this.merchantId, serverSeq]);
    return r.rows.map((row) => ({ serverSeq: Number(row.server_seq), event: row.body as OrderEvent, outletId: row.outlet_id as string }));
  }

  async latestSeq(outletId: string = this.outletId): Promise<number> {
    const r = await this.db.query("SELECT COALESCE(MAX(server_seq),0) AS m FROM events WHERE merchant_id=$1 AND outlet_id=$2", [
      this.merchantId,
      outletId,
    ]);
    return Number(r.rows[0].m);
  }

  async outletOfOrder(orderId: string): Promise<string | null> {
    const r = await this.db.query("SELECT outlet_id FROM events WHERE merchant_id=$1 AND order_id=$2 ORDER BY server_seq LIMIT 1", [this.merchantId, orderId]);
    return (r.rows[0]?.outlet_id as string | undefined) ?? null;
  }

  /** An order is found whichever outlet recorded it: order ids are unique across the brand. */
  async eventsForOrder(orderId: string): Promise<OrderEvent[]> {
    const r = await this.db.query("SELECT body FROM events WHERE merchant_id=$1 AND order_id=$2 ORDER BY server_seq", [
      this.merchantId,
      orderId,
    ]);
    return r.rows.map((row) => row.body as OrderEvent);
  }
}
