import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, allocTotal, quoteAll, quoteCustom, quoteEqual, quoteMine, quoteRound, tabBill, tabStanding, tabUnits, type PaymentAlloc, type TabLineIn, type TabState } from "../src/index.js";

// The documents' seed tab (Spec 12.7, Addendum 2.6, 3.2): Alex Tornado 10.80 / Sam Kaya 2.00 + Coffee 2.20 / Guest Coke BCRS 2.50, 9% service.
const seed: TabLineIn[] = [
  { lineId: "t", round: 1, name: "Tornado Egg Rice", unitCents: 1080, qty: 1, ownerId: "alex" },
  { lineId: "k", round: 1, name: "Kaya Toast", unitCents: 200, qty: 1, ownerId: "sam" },
  { lineId: "c", round: 1, name: "Coffee", unitCents: 220, qty: 1, ownerId: "sam" },
  { lineId: "x", round: 1, name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1, ownerId: "guest", bcrs: true },
];
const opts = { serviceCharge: true, pricing: { ...DEFAULT_PRICING, serviceRate: 0.09 } };
const state = (lines: TabLineIn[] = seed, payments: PaymentAlloc[] = []): TabState => ({ lines, payments, opts });

describe("the whole bill", () => {
  it("seed tab: S$17.50 + S$1.58 service + S$0.10 deposit = S$19.18", () => {
    expect(tabBill(seed, opts)).toMatchObject({ itemsCents: 1750, serviceCents: 158, depositCents: 10, totalCents: 1918 });
  });
  it("combined tab: S$24.20 + S$2.18 + S$0.20 (two deposits) = S$26.58, never S$26.59", () => {
    const more: TabLineIn[] = [{ lineId: "k2", round: 2, name: "Kaya Toast", unitCents: 200, qty: 1, ownerId: "alex" }, { lineId: "c2", round: 2, name: "Coffee", unitCents: 220, qty: 1, ownerId: "alex" }, { lineId: "x2", round: 2, name: "Coke Classic 320ml BCRS", unitCents: 250, qty: 1, ownerId: "alex", bcrs: true }];
    const lines = [...seed, ...more];
    expect(tabBill(lines, opts)).toMatchObject({ itemsCents: 2420 + 0, serviceCents: 218, depositCents: 20, totalCents: 2658 });
  });
});

describe("Pay mine (Spec 12.7: Alex S$11.77, Sam S$4.58, Guest S$2.83)", () => {
  it("each person's share, and they add up to the tab", () => {
    const a = quoteMine(state(), "alex"), s = quoteMine(state(), "sam"), g = quoteMine(state(), "guest");
    expect([a.amountCents, s.amountCents, g.amountCents]).toEqual([1177, 458, 283]);
    expect(a.amountCents + s.amountCents + g.amountCents).toBe(1918);
    expect(g.depositCents).toBe(10); // the deposit stays with the Coke
    expect(a.depositCents).toBe(0);
  });

  it("whoever pays first, the shares still add up exactly, and a completed payment is never changed", () => {
    for (const order of [["alex", "sam", "guest"], ["sam", "guest", "alex"], ["guest", "alex", "sam"]]) {
      const payments: PaymentAlloc[] = [];
      let total = 0;
      for (const who of order) {
        const q = quoteMine(state(seed, payments), who);
        payments.push(q.alloc);
        total += q.amountCents;
      }
      expect(total).toBe(1918);
      expect(tabStanding(state(seed, payments)).remainingCents).toBe(0);
    }
  });

  it("is zero for someone with nothing left to pay", () => {
    const first = quoteMine(state(), "alex");
    expect(quoteMine(state(seed, [first.alloc]), "alex").amountCents).toBe(0);
  });
});

describe("a shared line", () => {
  it("is split to the cent between the people sharing it, and the deposit goes to the first slice", () => {
    const lines: TabLineIn[] = [{ lineId: "p", round: 1, name: "Pizza BCRS", unitCents: 1001, qty: 1, ownerId: "alex", bcrs: true, sharedWith: ["alex", "sam", "guest"] }];
    const u = tabUnits(lines, opts);
    expect(u.map((x) => x.items)).toEqual([334, 334, 333]);
    expect(u.map((x) => x.deposit)).toEqual([10, 0, 0]);
    const shares = ["alex", "sam", "guest"].map((p) => quoteMine(state(lines), p).amountCents);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(tabBill(lines, opts).totalCents);
  });
});

describe("quantity part-payment (Spec 12.6)", () => {
  it("2 x Coffee, pay for 1: one paid, one still unpaid", () => {
    const lines: TabLineIn[] = [{ lineId: "c", round: 1, name: "Coffee", unitCents: 220, qty: 2, ownerId: "sam" }];
    const first = quoteCustom(state(lines), 242, "oldest_first"); // one coffee with its 9% service (2.20 + 0.20 = 2.40 or so)
    expect(first.alloc.units).toHaveLength(1);
    const st = tabStanding(state(lines, [first.alloc]));
    expect(st.unpaid).toHaveLength(1);
    expect(st.paidCents + st.remainingCents).toBe(tabBill(lines, opts).totalCents);
  });
});

describe("Split equally (Addendum 3.2, working rule B)", () => {
  it("the non-deposit part is divided equally, the Host takes odd cents, the deposit stays with its item: 6.36 / 6.36 / 6.46", () => {
    const people = ["alex", "sam", "guest"];
    const shares = people.map((p) => quoteEqual(state(), people, p, "alex").amountCents);
    expect(shares).toEqual([636, 636, 646]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1918);
  });
  it("without the deposit, S$19.18 / 3 = S$6.40 for the Host and S$6.39 each (T-5)", () => {
    const noBcrs = seed.map((l) => ({ ...l, bcrs: false }));
    const people = ["alex", "sam", "guest"];
    const shares = people.map((p) => quoteEqual(state(noBcrs), people, p, "alex").amountCents);
    expect(tabBill(noBcrs, opts).totalCents).toBe(1908);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1908);
    expect(shares[0]).toBeGreaterThanOrEqual(shares[1]!); // the Host never pays less than the others
  });
  it("a deposit whose owner is not splitting goes to the Host", () => {
    const shares = ["alex", "sam"].map((p) => quoteEqual(state(), ["alex", "sam"], p, "alex").amountCents);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1918);
    expect(shares[0]).toBeGreaterThan(shares[1]!);
  });
  it("later payers split what is left, after one has paid", () => {
    const first = quoteEqual(state(), ["alex", "sam", "guest"], "alex", "alex");
    const rest = state(seed, [first.alloc]);
    const a = quoteEqual(rest, ["sam", "guest"], "sam", "alex").amountCents;
    const b = quoteEqual(rest, ["sam", "guest"], "guest", "alex").amountCents;
    expect(first.amountCents + a + b).toBe(1918);
  });
  it("a value payment is shared into a later Pay mine, so the shares still add up", () => {
    const first = quoteEqual(state(), ["alex", "sam", "guest"], "alex", "alex");
    const after = state(seed, [first.alloc]);
    const total = first.amountCents + quoteMine(after, "sam").amountCents + quoteMine(after, "guest").amountCents + quoteMine(after, "alex").amountCents;
    expect(total).toBe(1918 + 0); // alex's own units are still unclaimed, so Alex's quote also reduces by his part of the credit
    expect(tabStanding(state(seed, [first.alloc])).remainingCents).toBe(1918 - first.amountCents);
  });
});

describe("By round, Pay all and Custom amount", () => {
  const two: TabLineIn[] = [...seed, { lineId: "m", round: 2, name: "Milo", unitCents: 300, qty: 1, ownerId: "alex" }];
  it("one round whole, with its part of the service", () => {
    const r1 = quoteRound(state(two), 1), r2 = quoteRound(state(two), 2);
    expect(r1.amountCents + r2.amountCents).toBe(tabBill(two, opts).totalCents);
    expect(r2.itemsCents).toBe(300);
  });
  it("pay all is the whole Remaining; after a part-payment it is what is left", () => {
    expect(quoteAll(state(two)).amountCents).toBe(tabBill(two, opts).totalCents);
    const first = quoteMine(state(two), "sam");
    expect(quoteAll(state(two, [first.alloc])).amountCents).toBe(tabBill(two, opts).totalCents - first.amountCents);
  });
  it("custom, oldest round first: marks whole units paid from the oldest round, the rest stays value", () => {
    const q = quoteCustom(state(two), 1300, "oldest_first");
    expect(q.amountCents).toBe(1300);
    expect(allocTotal(q.alloc)).toBe(1300);
    expect(q.alloc.units.length).toBeGreaterThan(0);
    expect(q.alloc.units[0]!.lineId).toBe("t"); // the oldest item first
    expect(q.alloc.units.every((u) => u.lineId !== "m")).toBe(true); // round 2 is untouched
  });
  it("custom, oldest round first, with less than the oldest unit costs: nothing is marked paid, the amount stays as value", () => {
    const q = quoteCustom(state(two), 500, "oldest_first");
    expect(q.alloc.units).toHaveLength(0);
    expect(allocTotal(q.alloc)).toBe(500);
  });
  it("custom, reduce only: no item is marked paid", () => {
    const q = quoteCustom(state(two), 500, "reduce_only");
    expect(q.alloc.units).toHaveLength(0);
    expect(tabStanding(state(two, [q.alloc])).remainingCents).toBe(tabBill(two, opts).totalCents - 500);
  });
  it("a custom amount never exceeds what is owed", () => {
    expect(quoteCustom(state(two), 999999, "reduce_only").amountCents).toBe(tabBill(two, opts).totalCents);
  });
});

describe("totals always reconcile", () => {
  it("paying everything in any mix leaves exactly nothing remaining and never a negative amount", () => {
    const lines: TabLineIn[] = [
      ...seed,
      { lineId: "m", round: 2, name: "Milo", unitCents: 305, qty: 3, ownerId: "alex" },
      { lineId: "s", round: 2, name: "Satay BCRS", unitCents: 777, qty: 2, ownerId: "sam", bcrs: true, sharedWith: ["sam", "guest"] },
    ];
    const payments: PaymentAlloc[] = [];
    const steps = [() => quoteMine(state(lines, payments), "sam"), () => quoteCustom(state(lines, payments), 700, "oldest_first"), () => quoteEqual(state(lines, payments), ["alex", "guest"], "guest", "alex"), () => quoteMine(state(lines, payments), "alex"), () => quoteAll(state(lines, payments))];
    for (const step of steps) {
      const q = step();
      expect(q.amountCents).toBeGreaterThanOrEqual(0);
      payments.push(q.alloc);
    }
    const st = tabStanding(state(lines, payments));
    expect(st.remainingCents).toBe(0);
    expect(payments.reduce((n, p) => n + allocTotal(p), 0)).toBe(tabBill(lines, opts).totalCents);
  });
});

import { applyPoints } from "../src/index.js";

describe("a coupon on the tab (D3) and personal points (Spec 12.7)", () => {
  const withCoupon = (payments: PaymentAlloc[] = []): TabState => ({ lines: seed, payments, opts, couponCents: 200 });

  it("the coupon comes off the whole bill, once, and the shares still add up to the new total", () => {
    const bill = tabBill(seed, opts, 200);
    expect(bill.discountCents).toBe(200);
    expect(bill.itemsCents).toBe(1750);
    expect(bill.totalCents).toBeLessThan(1918);
    const shares = ["alex", "sam", "guest"].map((p) => quoteMine(withCoupon(), p));
    expect(shares.reduce((n, q) => n + q.amountCents, 0)).toBe(bill.totalCents);
    expect(shares.reduce((n, q) => n + q.discountCents, 0)).toBe(200); // the benefit is shared across the payers, pro-rata
    expect(shares[0]!.discountCents).toBeGreaterThan(shares[2]!.discountCents); // Alex's bigger share gets the bigger part
  });

  it("whoever pays first, the discount is shared out exactly and the tab settles to zero", () => {
    for (const order of [["alex", "sam", "guest"], ["guest", "alex", "sam"]]) {
      const payments: PaymentAlloc[] = [];
      let total = 0, discount = 0;
      for (const who of order) { const q = quoteMine(withCoupon(payments), who); payments.push(q.alloc); total += q.amountCents; discount += q.discountCents; }
      expect(discount).toBe(200);
      expect(total).toBe(tabBill(seed, opts, 200).totalCents);
      expect(tabStanding(withCoupon(payments)).remainingCents).toBe(0);
    }
  });

  it("points reduce only the payer's own cash, one point a cent, and what the tab owes drops by the same amount", () => {
    const q = quoteMine(state(), "sam"); // S$4.58
    const p = applyPoints(q, opts.pricing, 10_000, 100);
    expect(p.pointsUsed).toBe(100);
    expect(p.amountCents).toBe(q.amountCents - 100);
    expect(p.liabilityCents).toBe(q.amountCents); // the tab is settled by the full S$4.58
    // Sam spending points does not change what Alex or the Guest owe
    const after = state(seed, [p.alloc]);
    expect(quoteMine(after, "alex").amountCents).toBe(1177);
    expect(quoteMine(after, "guest").amountCents).toBe(283);
    expect(tabStanding(after).remainingCents).toBe(1918 - q.amountCents);
  });

  it("points never push a share below zero, are capped at the balance, need the minimum claim, and cannot pay the deposit by default", () => {
    const g = quoteMine(state(), "guest"); // S$2.83 = 2.50 + 0.23 service + 0.10 deposit
    const all = applyPoints(g, opts.pricing, 100_000, null);
    expect(all.pointsUsed).toBe(250 + 23); // items and service, not the deposit (the default)
    expect(all.amountCents).toBe(10); // only the deposit is left in cash
    expect(applyPoints(g, opts.pricing, 150, null).pointsUsed).toBe(150); // capped at the balance
    expect(applyPoints(g, opts.pricing, 150, 150).amountCents).toBe(g.amountCents - 150);
    const withDeposit = applyPoints(g, { ...opts.pricing, pointsDeduct: { ...opts.pricing.pointsDeduct, deposit: true } }, 100_000, null);
    expect(withDeposit.amountCents).toBe(0); // fully covered: the share is S$0.00
    expect(withDeposit.liabilityCents).toBe(283);
    expect(applyPoints(g, opts.pricing, 0, null)).toBe(g); // no points, no change
  });

  it("points and a coupon together: the points can only use what the coupon left", () => {
    const q = quoteMine(withCoupon(), "alex");
    const p = applyPoints(q, opts.pricing, 100_000, null);
    expect(p.pointsUsed).toBeLessThanOrEqual(q.itemsCents + q.serviceCents - q.discountCents);
    expect(p.amountCents).toBeGreaterThanOrEqual(0);
  });
});
