import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING, priceOrder } from "../src/pricing.js";

const lines = [{ name: "Kaya Toast", unitCents: 200, qty: 1 }];
describe("service charge as an option", () => {
  it("is charged on dine-in by default", () => {
    expect(priceOrder({ lines, fulfilment: "dine_in", config: DEFAULT_PRICING }).service).toBeGreaterThan(0);
  });
  it("is not charged when the owner has switched it off, and the total follows", () => {
    const off = priceOrder({ lines, fulfilment: "dine_in", config: { ...DEFAULT_PRICING, serviceOn: false } });
    expect(off.service).toBe(0);
    expect(off.total).toBe(200);
  });
});
