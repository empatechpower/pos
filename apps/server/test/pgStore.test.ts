import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrderEvent } from "@pos/core";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;
beforeAll(async () => ({ db, stop } = await startTestDb()), 120_000);
afterAll(async () => stop?.());

let n = 0;
const ev = (orderId: string): OrderEvent =>
  ({ id: `e${++n}`, orderId, deviceId: "A", ts: n, seq: n, type: "StageSet", stage: "preparing" }) as OrderEvent;

describe("PgEventStore", () => {
  it("stores events and returns them after a cursor", async () => {
    const s = new PgEventStore(db, "m", "o1");
    const [a, b, c] = [ev("x"), ev("x"), ev("y")];
    await s.append([a, b]);
    const afterFirst = (await s.after(0))[0]!.serverSeq;
    await s.append([c]);
    const rest = await s.after(afterFirst);
    expect(rest.map((r) => r.event.id)).toEqual([b.id, c.id]);
    expect(await s.latestSeq()).toBe(rest[1]!.serverSeq);
  });

  it("is idempotent: the same event id is stored once and reported as new only once", async () => {
    const s = new PgEventStore(db, "m", "o2");
    const e = ev("z");
    expect(await s.append([e])).toHaveLength(1);
    expect(await s.append([e])).toHaveLength(0);
    expect(await s.after(0)).toHaveLength(1);
  });

  it("keeps outlets separate", async () => {
    const a = new PgEventStore(db, "m", "outletA");
    const b = new PgEventStore(db, "m", "outletB");
    await a.append([ev("p")]);
    expect(await b.after(0)).toHaveLength(0);
  });

  it("concurrent pushes never lose or duplicate events, and cursors see them in order", async () => {
    const s = new PgEventStore(db, "m", "busy");
    const batches = Array.from({ length: 20 }, () => [ev("q"), ev("q"), ev("q")]);
    await Promise.all(batches.map((b) => s.append(b)));
    const all = await s.after(0);
    expect(all).toHaveLength(60);
    const seqs = all.map((r) => r.serverSeq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });
});
