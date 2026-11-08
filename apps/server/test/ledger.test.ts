import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balanceOf, rebuildBalance, refund, spend, topUp } from "../src/ledger.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;
beforeAll(async () => ({ db, stop } = await startTestDb()), 120_000);
afterAll(async () => stop?.());

const who = (n: string) => ({ merchantId: "m1", customerId: n });

describe("credit ledger", () => {
  it("tops up and spends", async () => {
    const c = who("basic");
    await topUp(db, { ...c, amountCents: 2000, idempotencyKey: "t1" });
    const r = await spend(db, { ...c, amountCents: 450, idempotencyKey: "s1", orderId: "o1" });
    expect(r.ok && r.entry.balanceAfter).toBe(1550);
    expect(await balanceOf(db, c.merchantId, c.customerId)).toBe(1550);
  });

  it("rejects a spend larger than the balance and leaves it untouched", async () => {
    const c = who("poor");
    await topUp(db, { ...c, amountCents: 500, idempotencyKey: "t1" });
    const r = await spend(db, { ...c, amountCents: 501, idempotencyKey: "s1" });
    expect(r).toEqual({ ok: false, reason: "insufficient_funds", balanceCents: 500 });
    expect(await balanceOf(db, c.merchantId, c.customerId)).toBe(500);
  });

  it("is idempotent: replaying the same key never posts twice", async () => {
    const c = who("idem");
    await topUp(db, { ...c, amountCents: 1000, idempotencyKey: "t1" });
    const a = await spend(db, { ...c, amountCents: 300, idempotencyKey: "s1" });
    const b = await spend(db, { ...c, amountCents: 300, idempotencyKey: "s1" });
    expect(a.ok && !a.replayed).toBe(true);
    expect(b.ok && b.replayed).toBe(true);
    expect(await balanceOf(db, c.merchantId, c.customerId)).toBe(700);
  });

  it("two simultaneous spends cannot both succeed on one balance", async () => {
    const c = who("race");
    await topUp(db, { ...c, amountCents: 2000, idempotencyKey: "t1" });
    const results = await Promise.all([
      spend(db, { ...c, amountCents: 1500, idempotencyKey: "deviceA", deviceId: "A" }),
      spend(db, { ...c, amountCents: 1500, idempotencyKey: "deviceB", deviceId: "B" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(await balanceOf(db, c.merchantId, c.customerId)).toBe(500);
  });

  it("50 concurrent spends: balance never goes negative and equals the rebuilt ledger", async () => {
    const c = who("storm");
    await topUp(db, { ...c, amountCents: 1000, idempotencyKey: "t1" });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, n) => spend(db, { ...c, amountCents: 100, idempotencyKey: `s${n}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(await balanceOf(db, c.merchantId, c.customerId)).toBe(0);
    expect(await rebuildBalance(db, c.merchantId, c.customerId)).toBe(0);
  });

  it("refunds add credit back", async () => {
    const c = who("refund");
    await topUp(db, { ...c, amountCents: 1000, idempotencyKey: "t1" });
    await spend(db, { ...c, amountCents: 400, idempotencyKey: "s1", orderId: "o9" });
    await refund(db, { ...c, amountCents: 400, idempotencyKey: "r1", orderId: "o9" });
    expect(await balanceOf(db, c.merchantId, c.customerId)).toBe(1000);
  });

  it("keeps merchants separate", async () => {
    await topUp(db, { merchantId: "mA", customerId: "same", amountCents: 100, idempotencyKey: "t1" });
    expect(await balanceOf(db, "mB", "same")).toBe(0);
  });

  it("refuses zero and fractional amounts", async () => {
    await expect(topUp(db, { ...who("bad"), amountCents: 0, idempotencyKey: "x" })).rejects.toThrow();
    await expect(topUp(db, { ...who("bad"), amountCents: 1.5, idempotencyKey: "y" })).rejects.toThrow();
  });
});
