import { describe, expect, it } from "vitest";
import { PRESETS, queueView, type OrderState } from "../src/index.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
const NOW = 10_000_000_000;
const MIN = 60_000;
let n = 0;
const order = (o: Partial<OrderState> & { at: number }): OrderState => ({
  orderId: `o${String(++n).padStart(3, "0")}`, fulfilment: "takeaway", source: "pos", openedAt: o.at, lines: [{ lineId: "l", productId: "p", name: "Toast", unitCents: 200, qty: 1 }],
  payments: [{ paymentId: "p", method: "cash", amountCents: 200, confirmed: true }], stage: "open", ...o,
});
const done = (at: number, tookMin: number) => order({ at, stage: "ready", readyAt: at + tookMin * MIN, paidAt: at });

describe("a customer's place in the queue", () => {
  it("counts only earlier orders still waiting, not ready, cancelled or later ones", () => {
    const mine = order({ at: NOW - 5 * MIN });
    const all = [order({ at: NOW - 9 * MIN }), order({ at: NOW - 8 * MIN, stage: "preparing" }), order({ at: NOW - 7 * MIN, stage: "cancelled" }), done(NOW - 20 * MIN, 6), order({ at: NOW - 1 * MIN }), mine];
    expect(queueView(all, mine, config, NOW)).toMatchObject({ ahead: 2 });
  });

  it("is not in the queue until staff accept an online order, and not once ready or collected", () => {
    const waitingForStaff = order({ at: NOW - MIN, source: "online" });
    expect(queueView([waitingForStaff], waitingForStaff, config, NOW)).toBeNull();
    const accepted = order({ at: NOW - MIN, source: "online", acceptedAt: NOW - MIN / 2 });
    expect(queueView([accepted], accepted, config, NOW)).toMatchObject({ ahead: 0 });
    expect(queueView([{ ...accepted, stage: "ready" }], { ...accepted, stage: "ready" }, config, NOW)).toBeNull();
    expect(queueView([{ ...accepted, stage: "completed" }], { ...accepted, stage: "completed" }, config, NOW)).toBeNull();
  });

  it("gives no time, rather than a made-up one, until it has seen 3 finished orders", () => {
    const mine = order({ at: NOW - MIN });
    expect(queueView([mine, done(NOW - 30 * MIN, 5), done(NOW - 25 * MIN, 6)], mine, config, NOW)).toEqual({ ahead: 0, etaMinutes: null });
  });

  it("when nobody is ahead, the wait is how long a typical recent order took", () => {
    const mine = order({ at: NOW - MIN });
    const past = [done(NOW - 60 * MIN, 4), done(NOW - 50 * MIN, 6), done(NOW - 40 * MIN, 8), done(NOW - 100 * MIN, 30)];
    expect(queueView([mine, ...past], mine, config, NOW)).toEqual({ ahead: 0, etaMinutes: 7 }); // the median of 4, 6, 8, 30 is (6 + 8) / 2
  });

  it("with people ahead, the wait follows how fast orders came out in the last half hour", () => {
    const mine = order({ at: NOW - MIN });
    const ahead = Array.from({ length: 5 }, (_, i) => order({ at: NOW - (10 - i) * MIN }));
    // 6 orders finished in the last 30 min => 1 every 5 min; 5 ahead + mine = 6 orders => about 30 min
    const recent = Array.from({ length: 6 }, (_, i) => ({ ...done(NOW - (28 - i) * MIN, 5), readyAt: NOW - (25 - i * 4) * MIN }));
    const v = queueView([mine, ...ahead, ...recent], mine, config, NOW)!;
    expect(v.ahead).toBe(5);
    expect(v.etaMinutes).toBe(30);
  });

  it("ignores orders that took longer than 90 minutes, and gives no time if the kitchen has gone quiet", () => {
    const mine = order({ at: NOW - MIN });
    const ahead = order({ at: NOW - 5 * MIN });
    const stale = [done(NOW - 150 * MIN, 5), done(NOW - 140 * MIN, 5), done(NOW - 130 * MIN, 5)]; // finished 2 hours ago: not the last half hour
    expect(queueView([mine, ahead, ...stale], mine, config, NOW)).toEqual({ ahead: 1, etaMinutes: null });
    const slow = [done(NOW - 120 * MIN, 200), done(NOW - 110 * MIN, 200), done(NOW - 100 * MIN, 200)];
    expect(queueView([mine, ...slow], mine, config, NOW)).toEqual({ ahead: 0, etaMinutes: null });
  });
});

describe("a typical time set by the merchant", () => {
  it("is used only while there is too little history, per order in line including this one", () => {
    const mine = order({ at: NOW - 2 * MIN, source: "online", acceptedAt: NOW - 2 * MIN });
    const first = order({ at: NOW - 5 * MIN, source: "online", acceptedAt: NOW - 5 * MIN });
    expect(queueView([first, mine], mine, config, NOW)).toMatchObject({ ahead: 1, etaMinutes: null });
    expect(queueView([first, mine], mine, config, NOW, 6)).toMatchObject({ ahead: 1, etaMinutes: 12 });
    expect(queueView([mine], mine, config, NOW, 6)).toMatchObject({ ahead: 0, etaMinutes: 6 });
    // With real history, the real figure wins over the setting.
    const hist = [done(NOW - 50 * MIN, 4), done(NOW - 40 * MIN, 4), done(NOW - 30 * MIN, 4)];
    expect(queueView([...hist, mine], mine, config, NOW, 30)!.etaMinutes).toBe(4);
  });
});
