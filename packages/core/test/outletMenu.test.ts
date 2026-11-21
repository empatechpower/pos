import { describe, expect, it } from "vitest";
import { applyOutletMenu, menuFor, priceBuild, validateBuild, validateOutletOverride, type BuilderSpec, type Catalog } from "../src/index.js";

// Backend handout section 8 and fixture 10: the same product at two outlets has each outlet's own price and rules.
const bowlRules = (supplementMin: number): BuilderSpec => ({
  groups: [
    { id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar", value: 450 }, options: [{ id: "salmon", name: "Salmon", priceCents: 750 }, { id: "chicken", name: "Chicken", priceCents: 450 }] },
    { id: "supp", name: "Supplements", minSelect: supplementMin, maxSelect: 6, options: [{ id: "broc", name: "Broccoli", priceCents: 150 }, { id: "carr", name: "Carrots", priceCents: 150 }] },
  ],
});
const catalog: Catalog = {
  version: 5,
  defaultPricebookId: "std",
  products: [
    { id: "bowl", name: "Bowl", category: "Bowls", builder: bowlRules(1) },
    { id: "toast", name: "Toast", category: "Toast", options: [{ id: "temp", name: "Temp", kind: "single", required: true, choices: [{ id: "hot", name: "Hot", priceCents: 0 }, { id: "iced", name: "Iced", priceCents: 80 }] }] },
    { id: "soup", name: "Soup", category: "Mains", soldOut: true },
    { id: "tea", name: "Tea", category: "Drinks" },
  ],
  pricebooks: [
    { id: "std", name: "Standard", missing: "show", prices: { bowl: 1350, toast: 300, soup: 600, tea: 250 } },
    { id: "cbd", name: "CBD", missing: "show", prices: { bowl: 1550, toast: 350, soup: 650, tea: 280 } },
  ],
  channels: [{ id: "pickup", name: "Pickup", kind: "takeaway", serviceCharge: false, active: true }],
  assignments: [{ pricebookId: "cbd", outletId: "CBD" }],
};
const priceAt = (c: Catalog, outlet: string, id: string) => menuFor(c, { outletId: outlet, channelId: "pickup" }).find((m) => m.id === id)?.priceCents;

describe("per-outlet menus", () => {
  it("fixture 10: the same product has each outlet's own price and its own rules", () => {
    const north = applyOutletMenu(catalog, undefined);
    const cbd = applyOutletMenu(catalog, { bowl: { builder: bowlRules(2) } });
    expect(priceAt(north, "Heartland", "bowl")).toBe(1350);
    expect(priceAt(cbd, "CBD", "bowl")).toBe(1550);
    const pick = [{ groupId: "protein", optionId: "chicken" }, { groupId: "supp", optionId: "broc" }];
    const at = (c: Catalog) => c.products.find((p) => p.id === "bowl")!.builder!;
    expect(validateBuild(at(north), { picks: pick }).ok).toBe(true); // this outlet asks for 1 supplement
    expect(validateBuild(at(cbd), { picks: pick }).groups.find((g) => g.groupId === "supp")).toMatchObject({ state: "below_min", min: 2, shortfall: 1 }); // the other asks for 2
    expect(at(north).groups![1]!.minSelect).toBe(1); // the brand's own rules are untouched
  });

  it("an item switched off at an outlet is not on its menu; sold out is that outlet's state, and can differ from the brand", () => {
    const c = applyOutletMenu(catalog, { tea: { off: true }, toast: { soldOut: true }, soup: { soldOut: false } });
    const ids = c.products.map((p) => p.id);
    expect(ids).not.toContain("tea");
    expect(c.products.find((p) => p.id === "toast")!.soldOut).toBe(true);
    expect(c.products.find((p) => p.id === "soup")!.soldOut).toBeUndefined(); // the brand has it sold out, this outlet still has it
    expect(catalog.products.find((p) => p.id === "soup")!.soldOut).toBe(true);
    expect(catalog.products.map((p) => p.id)).toContain("tea");
    expect(applyOutletMenu(catalog, {})).toBe(catalog); // nothing to apply: the very same catalogue
  });

  it("an option sold out at one outlet cannot be selected there, while another outlet still has it", () => {
    const c = applyOutletMenu(catalog, { bowl: { soldOutOptions: ["salmon"] }, toast: { soldOutOptions: ["temp:iced"] } });
    const spec = c.products.find((p) => p.id === "bowl")!.builder!;
    const picks = [{ groupId: "protein", optionId: "salmon" }, { groupId: "supp", optionId: "broc" }];
    expect(validateBuild(spec, { picks }).groups.find((g) => g.groupId === "protein")).toMatchObject({ state: "unavailable_option", optionIds: ["salmon"] });
    expect(priceBuild(spec, { picks }, 1350).ok).toBe(false);
    expect(priceBuild(catalog.products.find((p) => p.id === "bowl")!.builder!, { picks }, 1350)).toMatchObject({ ok: true, unitCents: 1800 });
    expect(c.products.find((p) => p.id === "toast")!.options![0]!.choices.map((x) => !!x.soldOut)).toEqual([false, true]);
  });

  it("checks an outlet's override: unknown items and options, a bad rule set, a builder on an item with options", () => {
    expect(validateOutletOverride(catalog, "bowl", { soldOutOptions: ["salmon", "carr"] })).toEqual([]);
    expect(validateOutletOverride(catalog, "bowl", { soldOutOptions: ["pork"] }).join()).toContain('"pork" is not one of this item');
    expect(validateOutletOverride(catalog, "nope", { off: true }).join()).toContain("no such item");
    expect(validateOutletOverride(catalog, "bowl", { builder: { groups: [{ id: "g", name: "G", minSelect: 3, maxSelect: 1, options: [{ id: "o", name: "O", priceCents: 0 }] }] } }).join()).toContain("maximum must be at least the minimum");
    expect(validateOutletOverride(catalog, "toast", { builder: bowlRules(1) }).join()).toContain("cannot have a builder");
    expect(validateOutletOverride(catalog, "toast", { soldOutOptions: ["temp:iced"] })).toEqual([]);
  });
});
