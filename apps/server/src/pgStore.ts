import type { OrderEvent } from "@pos/core";
import type { Db } from "./db/pool.js";
import type { EventStore, StoredEvent } from "./store.js";

/** Postgres-backed event log for one outlet. Devices only ever see their own outlet's events. */
export class PgEventStore implements EventStore {
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
    private readonly outletId: string,
  ) {}

  /** Idempotent on event id. Returns only the events that were new. */
  async append(events: OrderEvent[]): Promise<StoredEvent[]> {
    if (!events.length) return [];
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.merchantId}/${this.outletId}`]);
      const added: StoredEvent[] = [];
      for (const e of events) {
        const r = await client.query(
          `INSERT INTO events (id, merchant_id, outlet_id, order_id, device_id, type, body)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING server_seq`,
          [e.id, this.merchantId, this.outletId, e.orderId, e.deviceId, e.type, JSON.stringify(e)],
        );
        if (r.rowCount) added.push({ serverSeq: Number(r.rows[0].server_seq), event: e });
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

  async after(serverSeq: number): Promise<StoredEvent[]> {
    const r = await this.db.query(
      "SELECT server_seq, body FROM events WHERE merchant_id=$1 AND outlet_id=$2 AND server_seq > $3 ORDER BY server_seq",
      [this.merchantId, this.outletId, serverSeq],
    );
    return r.rows.map((row) => ({ serverSeq: Number(row.server_seq), event: row.body as OrderEvent }));
  }

  async latestSeq(): Promise<number> {
    const r = await this.db.query("SELECT COALESCE(MAX(server_seq),0) AS m FROM events WHERE merchant_id=$1 AND outlet_id=$2", [
      this.merchantId,
      this.outletId,
    ]);
    return Number(r.rows[0].m);
  }

  async eventsForOrder(orderId: string): Promise<OrderEvent[]> {
    const r = await this.db.query("SELECT body FROM events WHERE merchant_id=$1 AND outlet_id=$2 AND order_id=$3 ORDER BY server_seq", [
      this.merchantId,
      this.outletId,
      orderId,
    ]);
    return r.rows.map((row) => row.body as OrderEvent);
  }
}
