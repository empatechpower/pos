import { describe, expect, it } from "vitest";
import { comboSaving, defaultSelection, isCombo, resolveOptions, splitComboLine, validateCatalog, withComboAvailability, type Catalog, type OptionGroup } from "../src/index.js";

const slot = (id: string, name: string, choices: Array<[string, string, number, boolean?]>): OptionGroup => ({
  id, name, kind: "single", required: true,
  choices: choices.map(([pid, n, extra, d]) => ({ id: pid, name: n, priceCents: extra, productId: pid, ...(d ? { default: true } : {}) })),
});
// A $5 chicken burger combo: burger fixed, fries by default (other sides cost more), coke by default.
const combo: OptionGroup[] = [
  slot("main", "Main", [["chicken-burger", "Chicken Burger", 0, true]]),
  slot("side", "Side", [["fries", "Fries", 0, true], ["nuggets", "Nuggets", 150]]),
  slot("drink", "Drink", [["coke", "Coke", 0, true], ["sprite", "Sprite", 0], ["latte", "Latte", 200]]),
];
const cat = (): Catalog => ({
  version: 1, defaultPricebookId: "std",
  products: [
    { id: "chicken-burger", name: "Chicken Burger", category: "Burgers" },
    { id: "fries", name: "Fries", category: "Sides" }, { id: "nuggets", name: "Nuggets", category: "Sides" },
    { id: "coke", name: "Coke", category: "Drinks" }, { id: "sprite", name: "Sprite", category: "Drinks" }, { id: "latte", name: "Latte", category: "Drinks" },
    { id: "cb-combo", name: "Chicken Burger Combo", category: "Combos", options: combo },
  ],
  pricebooks: [{ id: "std", name: "Standard", missing: "hide", prices: { "chicken-burger": 450, fries: 250, nuggets: 400, coke: 220, sprite: 220, latte: 400, "cb-combo": 500 } }],
  channels: [], assignments: [],
});

describe("combos", () => {
  it("is a combo when its choices stand for menu items", () => {
    expect(isCombo(combo)).toBe(true);
    expect(isCombo([{ id: "t", name: "Temp", kind: "single", required: true, choices: [{ id: "h", name: "Hot", priceCents: 0 }] }])).toBe(false);
  });

  it("starts from the default of every slot, and a fixed part needs no choosing", () => {
    const r = resolveOptions(combo, defaultSelection(combo));
    expect(r).toMatchObject({ ok: true, extraCents: 0 });
    expect(r.ok && r.options.map((o) => o.name)).toEqual(["Chicken Burger", "Fries", "Coke"]);
    expect(r.ok && r.options.map((o) => o.productId)).toEqual(["chicken-burger", "fries", "coke"]);
  });

  it("charges the top-up for a swapped side and drink", () => {
    const r = resolveOptions(combo, [{ groupId: "main", choiceId: "chicken-burger" }, { groupId: "side", choiceId: "nuggets" }, { groupId: "drink", choiceId: "latte" }]);
    expect(r).toMatchObject({ ok: true, extraCents: 350 });
  });

  it("works out the saving against buying the default parts alone", () => {
    const price = (id: string) => cat().pricebooks[0]!.prices[id] ?? null;
    expect(comboSaving(500, combo, price)).toBe(450 + 250 + 220 - 500); // 420
    expect(comboSaving(500, combo, () => null)).toBe(0); // unknown part price: no claim
    expect(comboSaving(2000, combo, price)).toBe(0); // never negative
  });

  it("a choice follows its item: switching Sprite off marks the choice sold out, but only when serving", () => {
    const c = cat();
    c.products.find((p) => p.id === "sprite")!.soldOut = true;
    expect(validateCatalog(c)).toEqual([]); // validation is not tripped by it
    const served = withComboAvailability(c).products.find((p) => p.id === "cb-combo")!.options!.find((g) => g.id === "drink")!;
    expect(served.choices.find((x) => x.id === "sprite")!.soldOut).toBe(true);
    expect(served.choices.find((x) => x.id === "coke")!.soldOut).toBeUndefined();
    expect(c.products.find((p) => p.id === "cb-combo")!.options![2]!.choices[1]!.soldOut).toBeUndefined(); // the stored catalog is not changed
    // A catalog with no combo comes back as is.
    const plain = { ...cat(), products: cat().products.filter((p) => p.id !== "cb-combo") };
    expect(withComboAvailability(plain)).toBe(plain);
  });

  it("refuses a combo that points at nothing, itself, or another combo", () => {
    const point = (productId: string, id = "cb-combo") => {
      const c = cat();
      c.products.push({ id: "cb2", name: "Another", category: "Combos", options: [slot("x", "X", [["coke", "Coke", 0, true]])] });
      c.products.find((p) => p.id === id)!.options = [slot("x", "X", [[productId, "Part", 0, true]])];
      return validateCatalog(c).join();
    };
    expect(point("ghost")).toMatch(/does not exist/);
    expect(point("cb-combo")).toMatch(/cannot contain itself/);
    expect(point("cb2")).toMatch(/cannot contain another combo/);
    expect(point("coke")).toBe("");
  });

  it("splits into one line per part, each with its own item, keeping extras with the first part", () => {
    const r = resolveOptions([...combo, { id: "ice", name: "Ice", kind: "single", required: false, choices: [{ id: "none", name: "No ice", priceCents: 0 }] }], [
      { groupId: "main", choiceId: "chicken-burger" }, { groupId: "side", choiceId: "nuggets" }, { groupId: "drink", choiceId: "coke" }, { groupId: "ice", choiceId: "none" },
    ]);
    if (!r.ok) throw new Error("should resolve");
    const line = { lineId: "L1", productId: "cb-combo", name: "Chicken Burger Combo", qty: 2, unitCents: 650, options: r.options };
    const parts = splitComboLine(line);
    expect(parts.map((p) => [p.lineId, p.productId, p.name, p.qty])).toEqual([["L1#0", "chicken-burger", "Chicken Burger", 2], ["L1#1", "nuggets", "Nuggets", 2], ["L1#2", "coke", "Coke", 2]]);
    expect(parts[0]!.options!.map((o) => o.name)).toEqual(["Chicken Burger Combo", "No ice"]);
    expect(parts[1]!.options!.map((o) => o.name)).toEqual(["Chicken Burger Combo"]);
    const plain = { lineId: "L2", productId: "coke", name: "Coke", qty: 1, unitCents: 220 };
    expect(splitComboLine(plain)).toEqual([plain]);
  });
});
