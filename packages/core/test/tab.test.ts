import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, payMineShares, shareProRata, splitEqual, tabRemaining, tabRewards, tabTotals, type TabLine } from "../src/index.js";

// Spec 12.7 seed tab (test data): Alex Tornado 10.80 / Sam Kaya 2.00 + Coffee 2.20 / Guest Coke BCRS 2.50
const seed: TabLine[] = [
  { id: "1", name: "Tornado Egg Rice", unitCents: 1080, qty: 1, owner: "alex" },
  { id: "2", name: "Kaya Toast", unitCents: 200, qty: 1, owner: "sam" },
  { id: "3", name: "Coffee", unitCents: 220, qty: 1, owner: "sam" },
  { id: "4", name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1, owner: "guest" },
];
// These are the prototype's worked examples, which use a 9% service charge; the shop itself now charges 8%.
const dine = { serviceCharge: true, pricing: { ...DEFAULT_PRICING, serviceRate: 0.09 } };

describe("tab totals", () => {
  it("seed tab: S$17.50 + S$1.58 service + S$0.10 BCRS = S$19.18", () => {
    expect(tabTotals(seed, dine)).toEqual({ items: 1750, service: 158, bcrs: 10, total: 1918 });
  });
  it("combined with the S$7.40 default bag: service is S$2.18 on the whole bill, total S$26.58", () => {
    const bag: TabLine[] = [
      { id: "5", name: "Kaya Toast", unitCents: 200, qty: 1, owner: "alex" },
      { id: "6", name: "Coffee", unitCents: 220, qty: 1, owner: "alex" },
      { id: "7", name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1, owner: "alex" },
    ];
    expect(tabTotals([...seed, ...bag], dine)).toEqual({ items: 2420, service: 218, bcrs: 20, total: 2658 });
  });
  it("no service charge when the channel has none", () => {
    expect(tabTotals(seed, { serviceCharge: false }).total).toBe(1760);
  });
});

describe("Pay mine", () => {
  it("shares are Alex S$11.77, Sam S$4.58, Guest S$2.83 and add up to the tab", () => {
    const s = payMineShares(seed, dine);
    expect(s.alex!.total).toBe(1177);
    expect(s.sam!.total).toBe(458);
    expect(s.guest!.total).toBe(283);
    expect(s.guest).toMatchObject({ items: 250, service: 23, bcrs: 10 }); // the deposit stays with the Coke
    expect(Object.values(s).reduce((n, x) => n + x.total, 0)).toBe(1918);
  });
  it("shares add up on the combined S$26.58 tab too (no S$26.59 from per-line rounding)", () => {
    const lines = [...seed, { id: "5", name: "Kaya Toast", unitCents: 200, qty: 1, owner: "alex" }, { id: "6", name: "Coffee", unitCents: 220, qty: 1, owner: "alex" }, { id: "7", name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1, owner: "alex" }];
    const s = payMineShares(lines, dine);
    expect(Object.values(s).reduce((n, x) => n + x.total, 0)).toBe(2658);
  });
  it("a deposit follows its item to whoever pays for it, per unit", () => {
    const s = payMineShares([{ id: "a", name: "Cola BCRS", unitCents: 250, qty: 3, owner: "x" }, { id: "b", name: "Tea", unitCents: 200, qty: 1, owner: "y" }], { serviceCharge: false });
    expect(s.x!.bcrs).toBe(30);
    expect(s.y!.bcrs).toBe(0);
  });
});

describe("shareProRata", () => {
  it("always adds up exactly, the largest share absorbing the cent", () => {
    for (const amount of [1, 2, 7, 158, 218, 999]) {
      const r = shareProRata(amount, { a: 333, b: 333, c: 334 });
      expect(Object.values(r).reduce((n, v) => n + v, 0)).toBe(amount);
    }
  });
  it("handles nothing to share", () => {
    expect(shareProRata(100, {})).toEqual({});
    expect(shareProRata(0, { a: 1 })).toEqual({ a: 0 });
  });
});

describe("Split equally", () => {
  it("S$19.18 / 3 = S$6.40 for the Host and S$6.39 each for the others", () => {
    expect(splitEqual(1918, ["alex", "sam", "guest"], "alex")).toEqual({ alex: 640, sam: 639, guest: 639 });
  });
  it("adds up exactly for any count", () => {
    for (const n of [1, 2, 3, 4, 7]) {
      const r = splitEqual(1918, Array.from({ length: n }, (_, i) => `p${i}`), "p0");
      expect(Object.values(r).reduce((a, b) => a + b, 0)).toBe(1918);
    }
  });
});

describe("remaining and rewards", () => {
  it("remaining never goes below zero", () => {
    expect(tabRemaining(1918, [{ payer: "a", amountCents: 1000 }])).toBe(918);
    expect(tabRemaining(1918, [{ payer: "a", amountCents: 2000 }])).toBe(0);
  });
  it("nothing is credited until the whole tab is paid", () => {
    expect(tabRewards([{ payer: "alex", amountCents: 1177 }], { remainingCents: 741, hostId: "alex", pointsPerDollar: 100 })).toEqual({});
  });
  it("each payer earns on what they paid (indicative 100 pts per S$1)", () => {
    const pays = [{ payer: "alex", amountCents: 1177 }, { payer: "sam", amountCents: 458 }, { payer: "guest", amountCents: 283 }];
    expect(tabRewards(pays, { remainingCents: 0, hostId: "alex", pointsPerDollar: 100 })).toEqual({ alex: 1177, sam: 458, guest: 283 });
  });
  it("'let the host keep the reward' routes that payment's points to the Host", () => {
    const pays = [{ payer: "alex", amountCents: 1177 }, { payer: "sam", amountCents: 458, hostKeeps: true }, { payer: "guest", amountCents: 283 }];
    expect(tabRewards(pays, { remainingCents: 0, hostId: "alex", pointsPerDollar: 100 })).toEqual({ alex: 1635, guest: 283 });
  });
  it("Alex paying the whole tab earns 1,918 points", () => {
    expect(tabRewards([{ payer: "alex", amountCents: 1918 }], { remainingCents: 0, hostId: "alex", pointsPerDollar: 100 })).toEqual({ alex: 1918 });
  });
});
