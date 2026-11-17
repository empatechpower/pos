import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OrderEvent } from "@pos/core";

/** An event plus the server's own monotonically increasing sequence number. */
export interface StoredEvent {
  serverSeq: number;
  event: OrderEvent;
  /** The outlet the event was recorded at. Absent in the single-outlet JSON file. */
  outletId?: string;
}

/** Storage seam: swap this JSON-file implementation for Postgres without touching routes. */
export interface EventStore {
  /** `outletId` is the outlet the events belong to; the default outlet when left out. */
  append(events: OrderEvent[], outletId?: string): Promise<StoredEvent[]>;
  /** One outlet's events (the default outlet when left out): what a device of that outlet syncs. */
  after(serverSeq: number, outletId?: string): Promise<StoredEvent[]>;
  /** Every outlet's events, each tagged with its outlet: for reports across a brand or franchise. */
  afterAll(serverSeq: number): Promise<StoredEvent[]>;
  latestSeq(outletId?: string): Promise<number>;
  /** The outlet that recorded an order, when the store keeps outlets. */
  outletOfOrder?(orderId: string): Promise<string | null>;
  /** Every event of one order, for rebuilding its state. */
  eventsForOrder(orderId: string): Promise<OrderEvent[]>;
}

export class JsonFileEventStore implements EventStore {
  private items: StoredEvent[] = [];
  private ids = new Set<string>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      this.items = JSON.parse(readFileSync(path, "utf8")) as StoredEvent[];
      for (const s of this.items) this.ids.add(s.event.id);
    }
  }

  /** Idempotent: events already stored (same id) are skipped. Returns only the newly stored ones. */
  async append(events: OrderEvent[]): Promise<StoredEvent[]> {
    const added: StoredEvent[] = [];
    for (const event of events) {
      if (this.ids.has(event.id)) continue;
      const stored = { serverSeq: this.lastSeq() + 1, event };
      this.items.push(stored);
      this.ids.add(event.id);
      added.push(stored);
    }
    if (added.length) this.flush();
    return added;
  }

  async after(serverSeq: number): Promise<StoredEvent[]> {
    return this.items.filter((s) => s.serverSeq > serverSeq);
  }

  async afterAll(serverSeq: number): Promise<StoredEvent[]> {
    return this.after(serverSeq);
  }

  async latestSeq(): Promise<number> {
    return this.lastSeq();
  }

  async eventsForOrder(orderId: string): Promise<OrderEvent[]> {
    return this.items.filter((s) => s.event.orderId === orderId).map((s) => s.event);
  }

  private lastSeq(): number {
    return this.items.length ? this.items[this.items.length - 1]!.serverSeq : 0;
  }

  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.items));
  }
}
