import { describe, expect, it } from "vitest";
import { buildTicketLines, priceBuild, selectionRefundCap } from "../src/index.js";

describe("ticket lines and refund cap", () => {
  const spec = {
    groups: [
      { id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar" as const, value: 450 }, options: [{ id: "salmon", name: "Salmon", priceCents: 750 }] },
      { id: "supp", name: "Supplements", minSelect: 0, maxSelect: 4, options: [{ id: "broc", name: "Broccoli", priceCents: 150, maxQty: 2 }] },
    ],
  };
  const built = priceBuild(spec, { picks: [{ groupId: "protein", optionId: "salmon" }, { groupId: "supp", optionId: "broc", qty: 2 }] }, 1350);
  const m = (c: number) => `$${(c / 100).toFixed(2)}`;

  it("groups by builder group, with charged amounts on a receipt only", () => {
    if (!built.ok) throw new Error("build should be valid");
    expect(buildTicketLines(built, true, m)).toEqual(["Protein:", "  Salmon (+$3.00)", "Supplements:", "  2 x Broccoli (+$3.00)"]);
    expect(buildTicketLines(built, false, m)).toEqual(["Protein:", "  Salmon", "Supplements:", "  2 x Broccoli"]);
  });

  it("a refund for a selection never exceeds what was charged for it", () => {
    if (!built.ok) throw new Error("build should be valid");
    expect(selectionRefundCap(built, "protein", "salmon")).toBe(300); // full price 750, of which 450 the allowance covered
    expect(selectionRefundCap(built, "supp", "broc")).toBe(300);
    expect(selectionRefundCap(built, "supp", "nothing")).toBe(0);
  });
});
