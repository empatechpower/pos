import { describe, expect, it } from "vitest";
import { plainText, tabPaymentReceipt } from "../src/index.js";

const ctx = { merchantName: "Bailey & Patch", outletName: "Enabling Village", now: Date.parse("2026-11-21T10:00:00+08:00") };

describe("a tab payment's receipt", () => {
  it("reproduces the quote: lines, components, who paid, who recorded it, and where the tab stands", () => {
    const doc = tabPaymentReceipt({
      spot: "Table 12", code: "EHVK9", payer: "Alex", forName: "Sam", recordedBy: "Cat", method: "cash", at: ctx.now,
      lines: [{ name: "Kaya Toast", units: 1, items: 200, deposit: 0 }, { name: "Coffee", units: 1, items: 220, deposit: 0 }],
      itemsCents: 420, discountCents: 20, serviceCents: 38, taxCents: 0, depositCents: 0, creditAppliedCents: 0, pointsUsed: 100, amountCents: 338,
      tab: { totalCents: 1918, paidCents: 458, remainingCents: 1460 },
    }, ctx);
    const text = plainText(doc, 42).join("\n");
    expect(text).toContain("Tab Table 12");
    expect(text).toContain("EHVK9");
    expect(text).toContain("Paid by");
    expect(text).toContain("Alex");
    expect(text).toContain("For");
    expect(text).toContain("Sam");
    expect(text).toContain("1 x Kaya Toast");
    expect(text).toContain("Coupon (your part)");
    expect(text).toContain("Points (100)");
    expect(text).toMatch(/PAID\s+\$?S?\$?3\.38/);
    expect(text).toContain("Recorded by");
    expect(text).toContain("Cat");
    expect(text).toContain("Remaining");
  });

  it("a bar tab, a value payment with no lines, and no staff line when a customer paid", () => {
    const text = plainText(tabPaymentReceipt({ spot: null, code: "AB3CD", payer: "Bo", method: "counter", at: ctx.now, lines: [], itemsCents: 0, discountCents: 0, serviceCents: 0, taxCents: 0, depositCents: 0, creditAppliedCents: 0, pointsUsed: 0, amountCents: 640, tab: { totalCents: 1918, paidCents: 640, remainingCents: 1278 } }, ctx), 42).join("\n");
    expect(text).toContain("Bar tab");
    expect(text).toContain("Toward the bill");
    expect(text).not.toContain("Recorded by");
  });
});
