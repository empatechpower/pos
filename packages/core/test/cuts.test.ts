import { describe, expect, it } from "vitest";
import { kitchenCuts, kitchenTicket, plainText, reduceOrder, type OrderEvent, type OrderLine } from "../src/index.js";

const opt = (name: string) => [{ group: "Temperature", name, qty: 1, priceCents: 0 }];
const line = (lineId: string, productId: string, qty: number, options?: ReturnType<typeof opt>): OrderLine => ({ lineId, productId, name: productId.toUpperCase(), unitCents: 300, qty, options });
const cat = (id: string) => (id === "milo" || id === "teh" ? "Drinks" : "Food");

describe("kitchen cuts", () => {
  it("2 x Milo (iced) is one cut", () => {
    const cuts = kitchenCuts([line("a", "milo", 2, opt("Iced"))], "grouped", cat);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.lines).toMatchObject([{ productId: "milo", qty: 2 }]);
  });

  it("1 x Milo (iced) and 1 x Milo (hot) are two cuts, never one line", () => {
    const cuts = kitchenCuts([line("a", "milo", 1, opt("Iced")), line("b", "milo", 1, opt("Hot"))], "grouped", cat);
    expect(cuts).toHaveLength(2);
    expect(cuts.map((c) => c.lines[0]!.options![0]!.name)).toEqual(["Iced", "Hot"]);
  });

  it("the same item added in two separate lines with the same choices is grouped", () => {
    const cuts = kitchenCuts([line("a", "milo", 1, opt("Iced")), line("b", "toast", 1), line("c", "milo", 2, opt("Iced"))], "grouped", cat);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]!.lines[0]).toMatchObject({ productId: "milo", qty: 3 });
    expect(cuts[0]!.lineIds.sort()).toEqual(["a", "c"]);
    expect(cuts[1]!.lines[0]).toMatchObject({ productId: "toast", qty: 1 });
  });

  it("one cut for every single item, like a label", () => {
    const cuts = kitchenCuts([line("a", "milo", 2, opt("Iced")), line("b", "toast", 1)], "unit", cat);
    expect(cuts).toHaveLength(3);
    expect(cuts.every((c) => c.lines.length === 1 && c.lines[0]!.qty === 1)).toBe(true);
  });

  it("one cut for each category, with identical items added together and different choices on their own lines", () => {
    const cuts = kitchenCuts([line("a", "milo", 1, opt("Iced")), line("b", "toast", 1), line("c", "milo", 1, opt("Hot")), line("d", "teh", 2), line("e", "milo", 1, opt("Iced"))], "category", cat);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]!.lines.map((l) => `${l.qty} ${l.productId}`)).toEqual(["2 milo", "1 milo", "2 teh"]);
    expect(cuts[1]!.lines.map((l) => `${l.qty} ${l.productId}`)).toEqual(["1 toast"]);
  });

  it("ignores lines with no quantity and prints each cut as a ticket with its quantity", () => {
    expect(kitchenCuts([line("a", "milo", 0)], "grouped", cat)).toEqual([]);
    const order = reduceOrder("o", [{ id: "e1", orderId: "o", deviceId: "d", ts: 1, seq: 1, type: "OrderOpened", fulfilment: "dine_in", spot: "Table 4", queueNumber: "123" } as OrderEvent])!;
    const cut = kitchenCuts([line("a", "milo", 2, opt("Iced"))], "grouped", cat)[0]!;
    const text = plainText(kitchenTicket(order, { merchantName: "B", outletName: "O", now: 0, timeZone: "Asia/Singapore" } as never, { lines: cut.lines }), 42).join("\n");
    expect(text).toContain("2 x MILO");
    expect(text).toContain("- Iced");
  });
});
