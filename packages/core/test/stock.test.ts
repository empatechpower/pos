import { describe, expect, it } from "vitest";
import { applyStockToMenu, consumptionPlan, orderConsumption, shortfalls, validateProductStock, unitUse, type Product } from "../src/index.js";

const kaya: Product = { id: "kaya", name: "Kaya Toast", category: "Toast", stock: { basis: "recipe", recipe: [{ itemId: "bread", qty: 2 }, { itemId: "kaya-jam", qty: 30 }] } };
const coke: Product = { id: "coke", name: "Coke", category: "Drinks", stock: { basis: "finished", itemId: "coke-can" } };
const fries: Product = { id: "fries", name: "Fries", category: "Sides", stock: { basis: "recipe", recipe: [{ itemId: "potato", qty: 150 }] } };
const meal: Product = { id: "meal", name: "Burger Meal", category: "Meals", options: [{ id: "drink", name: "Drink", kind: "single", required: true, choices: [{ id: "c", name: "Coke", priceCents: 0, productId: "coke", default: true }] }] as any };
const bowl: Product = { id: "bowl", name: "Bowl", category: "Bowls", builder: { groups: [{ id: "side", name: "Side", minSelect: 0, maxSelect: 2, options: [{ id: "f", name: "Fries", priceCents: 200, productId: "fries" }] }] } };
const catalog = { products: [kaya, coke, fries, meal, bowl] };

describe("stock", () => {
  it("one unit: finished stock uses its own item, a recipe uses its ingredients, an untracked product nothing", () => {
    expect(unitUse(coke)).toEqual([{ itemId: "coke-can", qty: 1 }]);
    expect(unitUse(kaya)).toEqual([{ itemId: "bread", qty: 2 }, { itemId: "kaya-jam", qty: 30 }]);
    expect(unitUse(meal)).toEqual([]);
    expect(unitUse(undefined)).toEqual([]);
  });

  it("a line multiplies by its quantity", () => {
    expect(consumptionPlan(catalog, { productId: "kaya", qty: 3 })).toEqual([{ itemId: "bread", qty: 6 }, { itemId: "kaya-jam", qty: 90 }]);
    expect(consumptionPlan(catalog, { productId: "kaya", qty: 0 })).toEqual([]);
  });

  it("a combo's shell never consumes; the chosen part deducts its own product's stock, once", () => {
    const line = { productId: "meal", qty: 2, options: [{ group: "Drink", name: "Coke", qty: 1, priceCents: 0, productId: "coke" }] };
    expect(consumptionPlan(catalog, line)).toEqual([{ itemId: "coke-can", qty: 2 }]);
  });

  it("a build-your-own option linked to a product deducts that product's stock per unit picked", () => {
    const build = { selections: [{ groupId: "side", groupName: "Side", optionId: "f", name: "Fries", qty: 2, unitFullCents: 200, fullCents: 400, coveredCents: 0, chargedCents: 400, productId: "fries" }] };
    expect(consumptionPlan(catalog, { productId: "bowl", qty: 3, build })).toEqual([{ itemId: "potato", qty: 900 }]);
  });

  it("an order merges the same item across lines", () => {
    const need = orderConsumption(catalog, [{ productId: "coke", qty: 2 }, { productId: "meal", qty: 1, options: [{ group: "Drink", name: "Coke", qty: 1, priceCents: 0, productId: "coke" }] }]);
    expect(need).toEqual([{ itemId: "coke-can", qty: 3 }]);
  });

  it("lists exactly what is short", () => {
    const need = [{ itemId: "bread", qty: 6 }, { itemId: "kaya-jam", qty: 90 }];
    expect(shortfalls(need, new Map([["bread", 6], ["kaya-jam", 100]]))).toEqual([]);
    expect(shortfalls(need, new Map([["bread", 5], ["kaya-jam", 100]]))).toEqual([{ itemId: "bread", needed: 6, onHand: 5 }]);
    expect(shortfalls(need, new Map())).toHaveLength(2);
  });

  it("86: a product that cannot make one more is sold out, and so is anything that links to it", () => {
    const menu = applyStockToMenu(catalog, new Map([["coke-can", 0], ["bread", 10], ["kaya-jam", 100], ["potato", 1000]]));
    expect(menu.products.find((p) => p.id === "coke")!.soldOut).toBe(true);
    expect(menu.products.find((p) => p.id === "kaya")!.soldOut).toBeUndefined();
    expect((menu.products.find((p) => p.id === "meal")!.options![0]!.choices[0] as any).soldOut).toBe(true);
    expect(menu.products.find((p) => p.id === "bowl")!.builder!.groups![0]!.options[0]!.soldOut).toBeUndefined(); // fries are fine
    const out2 = applyStockToMenu(catalog, new Map([["coke-can", 5], ["bread", 1], ["kaya-jam", 100], ["potato", 100]]));
    expect(out2.products.find((p) => p.id === "kaya")!.soldOut).toBe(true); // one short of bread for a unit
    expect(out2.products.find((p) => p.id === "bowl")!.builder!.groups![0]!.options[0]!.soldOut).toBe(true);
    expect(applyStockToMenu(catalog, new Map([["coke-can", 5], ["bread", 5], ["kaya-jam", 50], ["potato", 500]]))).toBe(catalog); // nothing out: untouched
  });

  it("checks the set-up: one basis, real quantities, no duplicates", () => {
    expect(validateProductStock({ basis: "finished", itemId: "x" }, "p")).toEqual([]);
    expect(validateProductStock({ basis: "finished" }, "p")[0]).toContain("needs a stock item");
    expect(validateProductStock({ basis: "finished", itemId: "x", recipe: [{ itemId: "y", qty: 1 }] }, "p")[0]).toContain("never both");
    expect(validateProductStock({ basis: "recipe", recipe: [] }, "p")[0]).toContain("at least one");
    expect(validateProductStock({ basis: "recipe", recipe: [{ itemId: "a", qty: 0 }] }, "p")[0]).toContain("whole number");
    expect(validateProductStock({ basis: "recipe", recipe: [{ itemId: "a", qty: 1 }, { itemId: "a", qty: 2 }] }, "p")[0]).toContain("twice");
    expect(validateProductStock({ basis: "recipe", recipe: [{ itemId: "a", qty: 1 }] }, "p", () => false)[0]).toContain("does not exist");
    expect(validateProductStock(undefined, "p")).toEqual([]);
  });
});
