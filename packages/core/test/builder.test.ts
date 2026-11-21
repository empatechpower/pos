import { describe, expect, it } from "vitest";
import { groupedBuild, priceBuild, validateBuild, validateBuilderSpec, type BuilderGroup, type BuilderSpec } from "../src/index.js";

// A bowl in the shape of the audited one: three sizes, each with its OWN rule set. Prices are cents.
const proteins = (half: boolean): BuilderGroup["options"] => [
  { id: "salmon", name: "Salmon", priceCents: half ? 375 : 750 },
  { id: "chicken", name: "Chicken", priceCents: half ? 225 : 450 },
  { id: "tofu", name: "Tofu", priceCents: half ? 225 : 450 },
];
const supplements = (min: number, allowance: number): BuilderGroup => ({
  id: "supp", name: "Supplements", minSelect: min, maxSelect: 6, allowance: { mode: "dollar", value: allowance },
  options: [
    { id: "broccoli", name: "Charred Broccoli", priceCents: 150, maxQty: 2 },
    { id: "brussels", name: "Brussels Sprouts", priceCents: 150, maxQty: 2 },
    { id: "carrots", name: "Roasted Carrots", priceCents: 150, maxQty: 2 },
    { id: "egg", name: "Soft Egg", priceCents: 200 },
  ],
});
const spec: BuilderSpec = {
  variants: [
    { id: "petite", name: "Petite", priceDeltaCents: -300, groups: [{ id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar", value: 225 }, options: proteins(true) }, supplements(2, 0)] },
    { id: "regular", name: "Regular", priceDeltaCents: 0, groups: [{ id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar", value: 450 }, options: proteins(false) }, supplements(3, 450)] },
    { id: "large", name: "Large", priceDeltaCents: 450, groups: [{ id: "protein", name: "Proteins", minSelect: 2, maxSelect: 2, allowance: { mode: "dollar", value: 900 }, options: proteins(false) }, supplements(3, 450)] },
    { id: "noprotein", name: "No Protein", priceDeltaCents: 0, groups: [supplements(6, 900)] },
  ],
};
const BASE = 1350; // the Regular bowl's price
const pick = (groupId: string, optionId: string, qty?: number) => ({ groupId, optionId, ...(qty ? { qty } : {}) });
const threeVeg = [pick("supp", "broccoli"), pick("supp", "brussels"), pick("supp", "carrots")];

describe("builder fixtures (backend handout section 13)", () => {
  it("1. dollar allowance, excess only: Salmon S$7.50 against a S$4.50 allowance charges S$3.00 (bowl S$16.50)", () => {
    const r = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg] }, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const salmon = r.selections.find((s) => s.optionId === "salmon")!;
    expect(salmon).toMatchObject({ fullCents: 750, coveredCents: 450, chargedCents: 300 });
    expect(r.unitCents).toBe(1650);
    // a protein at exactly the allowance is free
    const chicken = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "chicken"), ...threeVeg] }, BASE);
    expect(chicken.ok && chicken.selections[0]).toMatchObject({ fullCents: 450, coveredCents: 450, chargedCents: 0 });
    expect(chicken.ok && chicken.unitCents).toBe(1350);
  });

  it("2. allowance is used up in selection order, per unit: doubling Broccoli charges the second unit (bowl S$18.00)", () => {
    const r = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), pick("supp", "broccoli", 2), pick("supp", "brussels"), pick("supp", "carrots")] }, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // S$4.50 allowance: broccoli x2 uses S$3.00, brussels S$1.50 uses the rest, carrots (S$1.50) is then charged in full.
    const by = Object.fromEntries(r.selections.map((s) => [s.optionId, s]));
    expect(by.broccoli).toMatchObject({ qty: 2, fullCents: 300, coveredCents: 300, chargedCents: 0 });
    expect(by.brussels).toMatchObject({ coveredCents: 150, chargedCents: 0 });
    expect(by.carrots).toMatchObject({ coveredCents: 0, chargedCents: 150 });
    expect(r.unitCents).toBe(1350 + 300 + 150);
    // the handout's own wording: three veg fill the allowance exactly, then doubling Broccoli (a 4th unit) is S$1.50 more
    const doubled = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg, pick("supp", "broccoli")] }, BASE);
    expect(doubled.ok && doubled.unitCents).toBe(1800);
  });

  it("the order of the picks decides who is covered: the same veg picked in another order moves the charge", () => {
    const a = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "chicken"), pick("supp", "egg"), pick("supp", "broccoli"), pick("supp", "brussels")] }, BASE);
    const b = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "chicken"), pick("supp", "broccoli"), pick("supp", "brussels"), pick("supp", "egg")] }, BASE);
    // 4.50 allowance: egg 2.00 + broccoli 1.50 + brussels 1.50 = 5.00 either way, but WHICH one pays differs
    expect(a.ok && a.selections.find((s) => s.optionId === "brussels")!.chargedCents).toBe(50);
    expect(b.ok && b.selections.find((s) => s.optionId === "egg")!.chargedCents).toBe(50);
    expect(a.ok && a.unitCents).toBe(b.ok && b.unitCents);
  });

  it("3. a variant swaps the whole rule set", () => {
    const petite = priceBuild(spec, { variantId: "petite", picks: [pick("protein", "salmon"), pick("supp", "broccoli"), pick("supp", "brussels")] }, BASE);
    expect(petite.ok).toBe(true);
    if (!petite.ok) return;
    // half-portion prices, protein allowance S$2.25, Supplements minimum 2 and no allowance
    expect(petite.selections.find((s) => s.optionId === "salmon")).toMatchObject({ unitFullCents: 375, coveredCents: 225, chargedCents: 150 });
    expect(petite.unitCents).toBe(1350 - 300 + 150 + 300);
    expect(validateBuild(spec, { variantId: "petite", picks: [pick("protein", "chicken"), pick("supp", "broccoli")] }).groups.find((g) => g.groupId === "supp")).toMatchObject({ state: "below_min", shortfall: 1, min: 2 });

    // No Protein: there is no Protein group, Supplements needs 6 and has a S$9.00 allowance
    const np = validateBuild(spec, { variantId: "noprotein", picks: [pick("supp", "broccoli", 2), pick("supp", "brussels", 2), pick("supp", "carrots", 2)] });
    expect(np.ok).toBe(true);
    expect(np.groups.map((g) => g.groupId)).toEqual(["supp"]);
    expect(validateBuild(spec, { variantId: "noprotein", picks: [pick("protein", "salmon"), pick("supp", "broccoli", 2), pick("supp", "brussels", 2), pick("supp", "carrots", 2)] }).groups.some((g) => g.groupId === "protein" && g.state === "unknown_option")).toBe(true);
    const npPrice = priceBuild(spec, { variantId: "noprotein", picks: [pick("supp", "broccoli", 2), pick("supp", "brussels", 2), pick("supp", "carrots", 2)] }, BASE);
    expect(npPrice.ok && npPrice.chargedCents).toBe(0); // S$9.00 of veg, S$9.00 allowance

    // Large: Proteins choose exactly 2, allowance S$9.00
    const large = priceBuild(spec, { variantId: "large", picks: [pick("protein", "salmon"), pick("protein", "chicken"), ...threeVeg] }, BASE);
    expect(large.ok).toBe(true);
    expect(large.ok && large.chargedCents).toBe(750 + 450 - 900); // 3.00 over the S$9.00 allowance
    expect(validateBuild(spec, { variantId: "large", picks: [pick("protein", "salmon"), ...threeVeg] }).groups.find((g) => g.groupId === "protein")).toMatchObject({ state: "below_min", shortfall: 1 });
  });

  it("4. a build under a minimum is rejected with the group named and the shortfall stated", () => {
    const v = validateBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), pick("supp", "broccoli")] });
    expect(v.ok).toBe(false);
    expect(v.groups.find((g) => g.groupId === "supp")).toMatchObject({ groupName: "Supplements", state: "below_min", selected: 1, min: 3, shortfall: 2 });
    expect(v.groups.find((g) => g.groupId === "protein")!.state).toBe("satisfied");
    // and an empty build says what every required group is missing
    const empty = validateBuild(spec, { variantId: "regular", picks: [] });
    expect(empty.groups.filter((g) => g.state === "below_min").map((g) => g.groupName)).toEqual(["Protein", "Supplements"]);
    // pricing refuses an invalid build instead of guessing
    expect(priceBuild(spec, { variantId: "regular", picks: [] }, BASE).ok).toBe(false);
  });

  it("5. selections above a group's maximum are rejected, counting quantities", () => {
    const v = validateBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), pick("protein", "chicken"), ...threeVeg] });
    expect(v.groups.find((g) => g.groupId === "protein")).toMatchObject({ state: "above_max", selected: 2, max: 1, excess: 1 });
    const six = validateBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), pick("supp", "broccoli", 2), pick("supp", "brussels", 2), pick("supp", "carrots", 2), pick("supp", "egg")] });
    expect(six.groups.find((g) => g.groupId === "supp")).toMatchObject({ state: "above_max", selected: 7, max: 6, excess: 1 });
    // more of one option than it allows is its own error
    expect(validateBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), pick("supp", "egg", 2), pick("supp", "broccoli"), pick("supp", "brussels")] }).groups.find((g) => g.groupId === "supp")).toMatchObject({ state: "bad_quantity", optionIds: ["egg"] });
  });

  it("6. a sold-out option cannot be selected, and a stored line keeps its allocation when one sells out later", () => {
    const sold = new Set(["salmon"]);
    const v = validateBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg] }, sold);
    expect(v.ok).toBe(false);
    expect(v.groups.find((g) => g.groupId === "protein")).toMatchObject({ state: "unavailable_option", optionIds: ["salmon"] });
    expect(priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg] }, BASE, { unavailable: sold }).ok).toBe(false);
    // a line built earlier is flagged at re-validation but its stored prices are not touched
    const built = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg] }, BASE, { ruleVersion: 7 });
    expect(built.ok && built.ruleVersion).toBe(7);
    const before = JSON.stringify(built);
    expect(validateBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg] }, sold).ok).toBe(false);
    expect(JSON.stringify(built)).toBe(before);
  });

  it("7. editing a build re-prices it: a different protein changes the total, in one line", () => {
    const first = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), ...threeVeg] }, BASE);
    const edited = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "chicken"), ...threeVeg] }, BASE);
    expect(first.ok && first.unitCents).toBe(1650);
    expect(edited.ok && edited.unitCents).toBe(1350);
  });
});

describe("builder details", () => {
  it("count allowance makes the first N selections free", () => {
    const s: BuilderSpec = { groups: [{ id: "top", name: "Toppings", minSelect: 0, maxSelect: null, allowance: { mode: "count", value: 2 }, options: [{ id: "a", name: "A", priceCents: 100 }, { id: "b", name: "B", priceCents: 300 }, { id: "c", name: "C", priceCents: 200 }] }] };
    const r = priceBuild(s, { picks: [pick("top", "b"), pick("top", "a"), pick("top", "c")] }, 800);
    expect(r.ok && r.selections.map((x) => x.chargedCents)).toEqual([0, 0, 200]);
    expect(r.ok && r.unitCents).toBe(1000);
  });

  it("mode none charges every selection in full, and a variant is required when variants exist", () => {
    const s: BuilderSpec = { groups: [{ id: "g", name: "Extras", minSelect: 0, maxSelect: 2, options: [{ id: "x", name: "X", priceCents: 250 }] }] };
    expect(priceBuild(s, { picks: [pick("g", "x")] }, 1000)).toMatchObject({ ok: true, unitCents: 1250 });
    expect(validateBuild(spec, { picks: [] }).variantError).toBe("variant_required");
    expect(validateBuild(spec, { variantId: "huge", picks: [] }).variantError).toBe("unknown_variant");
    expect(validateBuild(s, { variantId: "regular", picks: [] }).variantError).toBe("variant_not_allowed");
  });

  it("the stored build is grouped for the receipt and the kitchen, with the allocation frozen per selection", () => {
    const r = priceBuild(spec, { variantId: "regular", picks: [pick("protein", "salmon"), pick("supp", "broccoli", 2), pick("supp", "carrots")] }, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(groupedBuild(r)).toEqual([
      { group: "Protein", items: [{ name: "Salmon", qty: 1, chargedCents: 300 }] },
      { group: "Supplements", items: [{ name: "Charred Broccoli", qty: 2, chargedCents: 0 }, { name: "Roasted Carrots", qty: 1, chargedCents: 0 }] },
    ]);
    for (const s of r.selections) expect(s.coveredCents + s.chargedCents).toBe(s.fullCents);
  });

  it("checks a spec: minimum above maximum, bad prices and allowances, repeated ids, linked items with options", () => {
    expect(validateBuilderSpec(spec, "Bowl")).toEqual([]);
    const bad: BuilderSpec = { groups: [{ id: "g", name: "G", minSelect: 3, maxSelect: 2, allowance: { mode: "dollar", value: -5 }, options: [{ id: "o", name: "O", priceCents: -1, maxQty: 0, productId: "dish" }, { id: "o", name: "O2", priceCents: 100 }] }, { id: "g", name: "", minSelect: 0, maxSelect: null, options: [] }] };
    const p = validateBuilderSpec(bad, "Bad", (id) => ({ exists: id === "dish", hasOptions: true })).join("\n");
    for (const part of ["maximum must be at least the minimum", "allowance must be a whole number", "bad price", "most per selection", "must not have options", "repeated", "has no name", "at least one option"]) expect(p).toContain(part);
    expect(validateBuilderSpec({ groups: [{ id: "g", name: "G", minSelect: 0, maxSelect: 1, options: [{ id: "o", name: "O", priceCents: 0, productId: "gone" }] }] }, "L", () => ({ exists: false, hasOptions: false })).join()).toContain("does not exist");
  });
});
