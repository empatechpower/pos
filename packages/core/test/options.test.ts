import { describe, expect, it } from "vitest";
import {
  PRESETS, defaultSelection, itemLabel, kitchenTicket, newId, optionLines, plainText, priceRange, quoteOrder, receipt, reduceOrder, resolveOptions, validateCatalog,
  type Catalog, type OptionGroup, type OrderEvent,
} from "../src/index.js";

const coffee: OptionGroup[] = [{ id: "temp", name: "Hot or cold", kind: "single", required: true, choices: [{ id: "hot", name: "Hot", priceCents: 0, default: true }, { id: "cold", name: "Cold", priceCents: 80 }] }];
const rice: OptionGroup[] = [
  { id: "egg", name: "Egg style", kind: "single", required: true, choices: [{ id: "tornado", name: "Tornado", priceCents: 0, default: true }, { id: "sunny", name: "Sunny side", priceCents: 0 }, { id: "scrambled", name: "Scrambled", priceCents: 0 }] },
  { id: "extras", name: "Extras", kind: "qty", required: false, max: 6, maxEach: 3, choices: [{ id: "egg", name: "Sunny Side Egg", priceCents: 200 }, { id: "rice", name: "Jasmine Rice", priceCents: 160 }] },
];
const meat: OptionGroup[] = [
  { id: "protein", name: "Protein", kind: "single", required: true, choices: [{ id: "beef", name: "Beef", priceCents: 0 }, { id: "kangaroo", name: "Kangaroo", priceCents: 100 }, { id: "gone", name: "Salmon", priceCents: 0, soldOut: true }] },
  { id: "ice", name: "Ice cream add-on", kind: "multi", required: false, choices: [{ id: "pb", name: "Peanut Butter", priceCents: 540 }, { id: "yo", name: "Yogurt", priceCents: 540 }] },
];

describe("resolveOptions", () => {
  it("prices a selection and freezes names and deltas", () => {
    const r = resolveOptions(coffee, [{ groupId: "temp", choiceId: "cold" }]);
    expect(r).toMatchObject({ ok: true, extraCents: 80, options: [{ group: "Hot or cold", name: "Cold", qty: 1, priceCents: 80 }] });
  });

  it("requires a choice in required groups", () => {
    expect(resolveOptions(coffee, [])).toMatchObject({ ok: false, error: "missing_required", groupId: "temp" });
    expect(resolveOptions(coffee, undefined)).toMatchObject({ ok: false, error: "missing_required" });
  });

  it("an item with no options needs none, and rejects options it does not have", () => {
    expect(resolveOptions(undefined, [])).toMatchObject({ ok: true, extraCents: 0, options: [] });
    expect(resolveOptions(undefined, [{ groupId: "x", choiceId: "y" }])).toMatchObject({ ok: false, error: "unknown_option" });
  });

  it("rejects unknown groups and choices, and sold-out choices", () => {
    expect(resolveOptions(coffee, [{ groupId: "nope", choiceId: "hot" }])).toMatchObject({ ok: false, error: "unknown_option" });
    expect(resolveOptions(coffee, [{ groupId: "temp", choiceId: "lukewarm" }])).toMatchObject({ ok: false, error: "unknown_option" });
    expect(resolveOptions(meat, [{ groupId: "protein", choiceId: "gone" }])).toMatchObject({ ok: false, error: "option_sold_out" });
  });

  it("a single group takes exactly one, even if the same choice is sent twice", () => {
    expect(resolveOptions(coffee, [{ groupId: "temp", choiceId: "hot" }, { groupId: "temp", choiceId: "cold" }])).toMatchObject({ ok: false, error: "too_many_options" });
    expect(resolveOptions(coffee, [{ groupId: "temp", choiceId: "hot" }, { groupId: "temp", choiceId: "hot" }])).toMatchObject({ ok: false, error: "too_many_options" });
  });

  it("qty groups price each unit, and enforce per-choice and total limits", () => {
    const base = [{ groupId: "egg", choiceId: "tornado" }];
    const ok = resolveOptions(rice, [...base, { groupId: "extras", choiceId: "egg", qty: 2 }, { groupId: "extras", choiceId: "rice", qty: 1 }]);
    expect(ok).toMatchObject({ ok: true, extraCents: 2 * 200 + 160 });
    expect(resolveOptions(rice, [...base, { groupId: "extras", choiceId: "egg", qty: 4 }])).toMatchObject({ ok: false, error: "bad_option_quantity" });
    expect(resolveOptions(rice, [...base, { groupId: "extras", choiceId: "egg", qty: 3 }, { groupId: "extras", choiceId: "rice", qty: 3 }, { groupId: "extras", choiceId: "rice", qty: 1 }])).toMatchObject({ ok: false });
  });

  it("multi groups take each choice at most once", () => {
    const b = [{ groupId: "protein", choiceId: "beef" }];
    expect(resolveOptions(meat, [...b, { groupId: "ice", choiceId: "pb" }, { groupId: "ice", choiceId: "yo" }])).toMatchObject({ ok: true, extraCents: 1080 });
    expect(resolveOptions(meat, [...b, { groupId: "ice", choiceId: "pb", qty: 2 }])).toMatchObject({ ok: false, error: "bad_option_quantity" });
  });

  it("rejects zero, negative and fractional option quantities", () => {
    for (const qty of [0, -1, 1.5]) expect(resolveOptions(rice, [{ groupId: "egg", choiceId: "tornado" }, { groupId: "extras", choiceId: "egg", qty }])).toMatchObject({ ok: false, error: "bad_option_quantity" });
  });

  it("the same selection always gives the same key, whatever order it was sent in", () => {
    const a = resolveOptions(rice, [{ groupId: "egg", choiceId: "sunny" }, { groupId: "extras", choiceId: "rice" }, { groupId: "extras", choiceId: "egg" }]);
    const b = resolveOptions(rice, [{ groupId: "extras", choiceId: "egg" }, { groupId: "extras", choiceId: "rice" }, { groupId: "egg", choiceId: "sunny" }]);
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });
});

describe("defaults and price ranges", () => {
  it("starts on the default (or first available) choice of each required single group", () => {
    expect(defaultSelection(coffee)).toEqual([{ groupId: "temp", choiceId: "hot" }]);
    expect(defaultSelection(meat)).toEqual([{ groupId: "protein", choiceId: "beef" }]);
    const allGone: OptionGroup[] = [{ ...coffee[0]!, choices: coffee[0]!.choices.map((c) => ({ ...c, soldOut: true })) }];
    expect(defaultSelection(allGone)).toEqual([]);
  });

  it("gives the range the prototype shows on a card: Coffee S$2.20 to S$3.00", () => {
    expect(priceRange(220, coffee)).toEqual([220, 300]);
    expect(priceRange(880, meat)).toEqual([880, 980]); // sold-out choices and add-ons do not count
    expect(priceRange(1080, rice)).toEqual([1080, 1080]); // extras are not part of the range
    expect(priceRange(500, undefined)).toEqual([500, 500]);
  });
});

describe("options in a quote", () => {
  const catalog = (): Catalog => ({
    version: 1,
    defaultPricebookId: "std",
    products: [{ id: "kopi", name: "Coffee", category: "Coffee & Tea", options: coffee }, { id: "rice", name: "Karaage Rice", category: "Rice", options: rice }, { id: "kaya", name: "Kaya Toast", category: "Toast" }],
    pricebooks: [{ id: "std", name: "Standard", missing: "show", prices: { kopi: 220, rice: 1080, kaya: 200 } }],
    channels: [{ id: "take", name: "Take away", kind: "takeaway", serviceCharge: false, active: true }],
    assignments: [],
  });
  const config = PRESETS.fastServe("b", "B", "O");
  const q = (items: Parameters<typeof quoteOrder>[3]) => quoteOrder(catalog(), config, { outletId: "O", channelId: "take" }, items);

  it("adds option prices on the server", () => {
    const r = q([{ productId: "kopi", qty: 2, options: [{ groupId: "temp", choiceId: "cold" }] }]);
    expect(r.ok && r.priced.total).toBe(2 * 300);
    expect(r.ok && r.lines[0]!.options).toEqual([{ group: "Hot or cold", name: "Cold", qty: 1, priceCents: 80 }]);
  });

  it("hot and cold of the same item are separate lines; identical choices merge", () => {
    const r = q([
      { productId: "kopi", qty: 1, options: [{ groupId: "temp", choiceId: "hot" }] },
      { productId: "kopi", qty: 1, options: [{ groupId: "temp", choiceId: "cold" }] },
      { productId: "kopi", qty: 2, options: [{ groupId: "temp", choiceId: "hot" }] },
    ]);
    expect(r.ok && r.lines.map((l) => [l.unitCents, l.qty])).toEqual([[220, 3], [300, 1]]);
  });

  it("refuses an item that needs a choice when none is given, and a client-supplied price", () => {
    expect(q([{ productId: "kopi", qty: 1 }])).toMatchObject({ ok: false, error: "missing_required" });
    const r = q([{ productId: "kopi", qty: 1, options: [{ groupId: "temp", choiceId: "cold", priceCents: 0 } as never] }]);
    expect(r.ok && r.priced.total).toBe(300);
  });

  it("extras are priced per unit", () => {
    const r = q([{ productId: "rice", qty: 1, options: [{ groupId: "egg", choiceId: "sunny" }, { groupId: "extras", choiceId: "egg", qty: 2 }] }]);
    expect(r.ok && r.priced.total).toBe(1080 + 400);
  });

  it("an item without options is unaffected", () => {
    expect(q([{ productId: "kaya", qty: 1 }])).toMatchObject({ ok: true });
  });
});

describe("options on tickets, receipts and labels", () => {
  const config = PRESETS.fastServe("b", "B", "O");
  const ctx = { merchantName: "B&P", outletName: "EV", now: Date.UTC(2026, 10, 7, 4, 5) };
  const orderId = newId();
  const ev = [
    { id: "e1", orderId, deviceId: "A", ts: 1, seq: 1, type: "OrderOpened", fulfilment: "takeaway", queueNumber: "A001" },
    { id: "e2", orderId, deviceId: "A", ts: 2, seq: 2, type: "ItemAdded", lineId: "l1", productId: "rice", name: "Karaage Rice", unitCents: 1480, qty: 1, options: [{ group: "Egg style", name: "Sunny side", qty: 1, priceCents: 0 }, { group: "Extras", name: "Sunny Side Egg", qty: 2, priceCents: 200 }] },
  ] as OrderEvent[];
  const order = reduceOrder(orderId, ev)!;

  it("keeps the options on the order line", () => {
    expect(optionLines(order.lines[0]!.options)).toEqual(["Sunny side", "Sunny Side Egg x2"]);
  });

  it("the kitchen sees every choice, including the free ones, but no prices", () => {
    const t = plainText(kitchenTicket(order, ctx), 42).join("\n");
    expect(t).toContain("1 x Karaage Rice");
    expect(t).toContain("- Sunny side");
    expect(t).toContain("- Sunny Side Egg x2");
    expect(t).not.toContain("S$");
  });

  it("the receipt lists the options under the item and the line price includes them", () => {
    const t = plainText(receipt(order, config, ctx), 42).join("\n");
    expect(t).toMatch(/1 x Karaage Rice\s+S\$14\.80/);
    expect(t).toContain("- Sunny Side Egg x2");
  });

  it("a cup label shows the options", () => {
    const l = itemLabel(order, order.lines[0]!, ctx);
    expect(l.fields.some((f) => f.t === "text" && f.text.includes("Sunny side"))).toBe(true);
  });
});

describe("validating option groups", () => {
  const base: Catalog = {
    version: 1, defaultPricebookId: "std", pricebooks: [{ id: "std", name: "S", missing: "show", prices: { p: 100 } }], channels: [], assignments: [],
    products: [{ id: "p", name: "P", category: "C" }],
  };
  const withGroups = (options: OptionGroup[]) => validateCatalog({ ...base, products: [{ id: "p", name: "P", category: "C", options }] });

  it("accepts the real shapes", () => {
    expect(withGroups(coffee)).toEqual([]);
    expect(withGroups(rice)).toEqual([]);
    expect(withGroups(meat)).toEqual([]);
  });

  it("rejects duplicate ids, empty groups, bad prices, bad limits and misplaced flags", () => {
    const g = (over: Partial<OptionGroup>): OptionGroup => ({ id: "g", name: "G", kind: "single", required: false, choices: [{ id: "a", name: "A", priceCents: 0 }], ...over });
    expect(withGroups([g({}), g({})]).join()).toMatch(/repeated/);
    expect(withGroups([g({ choices: [] })]).join()).toMatch(/1 to 30 choices/);
    expect(withGroups([g({ choices: [{ id: "a", name: "A", priceCents: -1 }] })]).join()).toMatch(/invalid price/);
    expect(withGroups([g({ choices: [{ id: "a", name: "A", priceCents: 1.5 }] })]).join()).toMatch(/invalid price/);
    expect(withGroups([g({ choices: [{ id: "a", name: "A", priceCents: 0 }, { id: "a", name: "B", priceCents: 0 }] })]).join()).toMatch(/repeated/);
    expect(withGroups([g({ kind: "multi", required: true })]).join()).toMatch(/only a choose-one group can be required/);
    expect(withGroups([g({ kind: "qty", max: 0 })]).join()).toMatch(/max must be/);
    expect(withGroups([g({ choices: [{ id: "a", name: "A", priceCents: 0, default: true }, { id: "b", name: "B", priceCents: 0, default: true }] })]).join()).toMatch(/one default/);
    expect(withGroups([g({ required: true, choices: [{ id: "a", name: "A", priceCents: 0, soldOut: true }] })]).join()).toMatch(/every choice is sold out/);
    expect(withGroups([g({ name: "  " })]).join()).toMatch(/needs a name/);
    expect(withGroups([g({ kind: "weird" as never })]).join()).toMatch(/unknown kind/);
  });

  it("limits description and alternative name length", () => {
    const c = { ...base, products: [{ id: "p", name: "P", category: "C", description: "x".repeat(201), altName: "y".repeat(81) }] };
    expect(validateCatalog(c).join()).toMatch(/description is too long[\s\S]*alternative name is too long/);
  });
});
