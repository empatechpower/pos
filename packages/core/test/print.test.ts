import { describe, expect, it } from "vitest";
import {
  PRESETS, columns, encodeEpl, encodeEscPos, encodeZpl, guestCheck, itemLabel, kitchenTicket, newId, noteSlip, plainText, printedAt, receipt, reduceOrder, toAscii, withDrawer, wrap,
  type Doc, type Label, type OrderEvent, type OrderState,
} from "../src/index.js";

const config = PRESETS.fastServe("b", "B", "O");
const NOW = Date.UTC(2026, 10, 7, 4, 5); // 12:05 in Singapore

function order(opts: { channel?: { id: string; name: string; service: boolean; kind: "dine_in" | "takeaway" }; pay?: number | "all"; spot?: string; name?: string; phone?: string } = {}): OrderState {
  const orderId = newId();
  const ch = opts.channel ?? { id: "take", name: "Take away", service: false, kind: "takeaway" as const };
  const base = { orderId, deviceId: "A" };
  const ev: OrderEvent[] = [
    { ...base, id: "e1", ts: 1, seq: 1, type: "OrderOpened", fulfilment: ch.kind, channelId: ch.id, channelName: ch.name, serviceCharge: ch.service, queueNumber: "A007", spot: opts.spot, customerName: opts.name, customerPhone: opts.phone },
    { ...base, id: "e2", ts: 2, seq: 2, type: "ItemAdded", lineId: "l1", productId: "kaya", name: "Kaya Toast", unitCents: 200, qty: 2 },
    { ...base, id: "e3", ts: 3, seq: 3, type: "ItemAdded", lineId: "l2", productId: "nasi", name: "Nasi Lemak with Extra Fried Chicken Wing and Sambal", unitCents: 690, qty: 1 },
  ];
  if (opts.pay) ev.push({ ...base, id: "e4", ts: 4, seq: 4, type: "PaymentRecorded", paymentId: "p1", method: "cash", amountCents: opts.pay === "all" ? 1090 : opts.pay, confirmed: true });
  return reduceOrder(orderId, ev)!;
}

const find = (hay: Uint8Array, needle: number[], from = 0) => {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("text", () => {
  it("folds to plain ASCII", () => {
    expect(toAscii("Café Crème – “hello”…")).toBe('Cafe Creme - "hello"...');
    expect(toAscii("鸡饭 nasi")).toBe("?? nasi");
  });

  it("wraps without ever exceeding the width, splitting words that are too long", () => {
    for (const line of wrap("Chicken Karaage Tornado Rice with Supercalifragilisticexpialidocious sauce", 16)) expect(line.length).toBeLessThanOrEqual(16);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("puts the amount flush right on the last line, at exactly the width", () => {
    const lines = columns("1 x Nasi Lemak with Extra Fried Chicken Wing and Sambal", "S$6.90", 32);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);
    expect(lines.at(-1)!.length).toBe(32);
    expect(lines.at(-1)!.endsWith("S$6.90")).toBe(true);
  });
});

describe("ESC/POS", () => {
  const doc = (blocks: Doc["blocks"]): Doc => ({ blocks });
  const enc = (blocks: Doc["blocks"], widthChars = 32) => encodeEscPos(doc(blocks), { widthChars });

  it("starts by initialising the printer and ends with a feed-and-cut", () => {
    const b = enc([{ t: "text", text: "Hi" }, { t: "cut" }]);
    expect([...b.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 0]);
    expect([...b.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 3]);
  });

  it("encodes text, alignment, bold and size with the right command bytes", () => {
    const b = enc([{ t: "text", text: "Hello", align: "center", bold: true, size: 2 }]);
    expect(find(b, [0x1b, 0x61, 1])).toBeGreaterThan(-1); // centre
    expect(find(b, [0x1b, 0x45, 1])).toBeGreaterThan(-1); // bold on
    expect(find(b, [0x1d, 0x21, 0x11])).toBeGreaterThan(-1); // double width + height
    expect(find(b, ascii("Hello\n"))).toBeGreaterThan(-1);
  });

  it("double-size text wraps at half the width", () => {
    const b = enc([{ t: "text", text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", size: 2 }], 32);
    expect(find(b, ascii("ABCDEFGHIJKLMNOP\n"))).toBeGreaterThan(-1); // 16 chars
    expect(find(b, ascii("QRSTUVWXYZ\n"))).toBeGreaterThan(-1);
  });

  it("two-column lines are exactly the paper width", () => {
    const b = enc([{ t: "cols", left: "Total", right: "S$10.90" }]);
    const text = String.fromCharCode(...b);
    expect(text).toContain("Total" + " ".repeat(32 - 5 - 7) + "S$10.90\n");
  });

  it("opens the cash drawer only when asked, and can be switched off for a device without one", () => {
    expect(find(enc([{ t: "drawer" }]), [0x1b, 0x70, 0])).toBeGreaterThan(-1);
    expect(find(enc([{ t: "text", text: "x" }]), [0x1b, 0x70])).toBe(-1);
    expect(find(encodeEscPos(doc([{ t: "drawer" }]), { widthChars: 32, drawer: false }), [0x1b, 0x70])).toBe(-1);
  });

  it("encodes a QR code with a correct length field", () => {
    const data = "https://example.com/o/A007";
    const b = enc([{ t: "qr", data }]);
    const at = find(b, [0x1d, 0x28, 0x6b]);
    const store = find(b, [0x31, 0x50, 0x30], at);
    expect(store).toBeGreaterThan(-1);
    const pL = b[store - 2]!;
    const pH = b[store - 1]!;
    expect(pL + 256 * pH).toBe(data.length + 3);
    expect(find(b, ascii(data), store)).toBe(store + 3);
  });

  it("encodes a Code 128 barcode with a correct length byte", () => {
    const b = enc([{ t: "barcode", data: "A007" }]);
    const k = find(b, [0x1d, 0x6b, 0x49]);
    expect(b[k + 3]).toBe("{BA007".length);
    expect(find(b, ascii("{BA007"), k)).toBe(k + 4);
  });

  it("never emits a byte that could be read as a command from user text", () => {
    // item names are untrusted: an ESC (0x1b) smuggled into a name must not reach the printer
    const b = enc([{ t: "text", text: "evil\u001b@\u001dV\u0000name" }]);
    const text = [...b.slice(5)];
    expect(find(Uint8Array.from(text), [0x1b, 0x40])).toBe(-1);
    expect(String.fromCharCode(...b)).toContain("evil?@?V?name");
  });
});

describe("receipt and kitchen ticket", () => {
  const ctx = { merchantName: "Bailey & Patch", outletName: "Enabling Village", now: NOW };

  it("prints the frozen prices, a correct total, and the date in Singapore time", () => {
    const text = plainText(receipt(order({ pay: "all" }), config, ctx), 42).join("\n");
    expect(text).toContain("2 x KAYA TOAST");
    expect(text).toContain("S$4.00");
    expect(text).toMatch(/Total \(SGD\)\s+S\$10\.90/);
    expect(text).toContain("Printed at: 07/11/2026, 12:05:00 PM");
    expect(text).toContain("Cash");
    expect(text).not.toContain("Balance due");
  });

  it("shows the service charge only when the channel charges it", () => {
    const dine = { id: "dine", name: "Dine in", service: true, kind: "dine_in" as const };
    expect(plainText(receipt(order({ channel: dine, spot: "Table 5" }), config, ctx), 42).join("\n")).toMatch(/Service charge \(\d+%\)\s+S\$0\.87/);
    expect(plainText(receipt(order(), config, ctx), 42).join("\n")).not.toContain("Service charge");
  });

  it("shows what is still owing on an unpaid or part-paid tab", () => {
    const text = plainText(receipt(order({ pay: 500 }), config, ctx), 42).join("\n");
    expect(text).toMatch(/Balance due\s+S\$5\.90/);
  });

  it("never lets a line exceed the paper width, even with a very long item name", () => {
    for (const w of [32, 42, 48]) for (const l of plainText(receipt(order(), config, ctx), w)) expect(l.length).toBeLessThanOrEqual(w);
  });

  it("the kitchen ticket shows the queue number and items but no prices", () => {
    const text = plainText(kitchenTicket(order(), ctx), 42).join("\n");
    expect(text).toContain("A007");
    expect(text).toContain("Take away");
    expect(text).toContain("2 x Kaya Toast");
    expect(text).not.toContain("S$");
  });

  it("a ticket can carry just some lines, and says when it is an add-on", () => {
    const o = order();
    const text = plainText(kitchenTicket(o, ctx, { lines: [o.lines[1]!], addOn: true }), 42).join("\n");
    expect(text).toContain("ADD-ON");
    expect(text).toContain("Nasi Lemak");
    expect(text).not.toContain("Kaya");
  });

  it("a cash receipt can open the drawer", () => {
    const b = encodeEscPos(withDrawer(receipt(order({ pay: "all" }), config, ctx)), { widthChars: 42 });
    expect(find(b, [0x1b, 0x70, 0])).toBeGreaterThan(-1);
  });
});

describe("labels", () => {
  const label: Label = {
    widthMm: 50,
    heightMm: 30,
    copies: 2,
    fields: [
      { t: "text", xMm: 3, yMm: 2, text: "A007", heightMm: 9 },
      { t: "barcode", xMm: 3, yMm: 14, data: "A007", heightMm: 8 },
      { t: "qr", xMm: 30, yMm: 14, data: "o/A007" },
    ],
  };

  it("ZPL: sized in dots for the printer's dpi, one command per field, ending with the copy count", () => {
    const z = encodeZpl(label, { dpi: 203 });
    expect(z.startsWith("^XA\n")).toBe(true);
    expect(z.trimEnd().endsWith("^XZ")).toBe(true);
    expect(z).toContain("^PW400"); // 50 mm at 8 dots/mm
    expect(z).toContain("^LL240");
    expect(z).toContain("^FO24,16^A0N,72^FH\\^FDA007^FS");
    expect(z).toContain("^BCN,64,Y,N,N");
    expect(z).toContain("^BQN,2,5");
    expect(z).toContain("^PQ2");
    expect(encodeZpl(label, { dpi: 300 })).toContain("^PW591");
  });

  it("ZPL: command characters in text cannot break out of the field", () => {
    const z = encodeZpl({ ...label, fields: [{ t: "text", xMm: 0, yMm: 0, text: "50^ off ~ \\ A&W", heightMm: 5 }] }, { dpi: 203 });
    expect(z).toContain("^FDA".replace("A", "50\\5E off \\7E \\5C A&W"));
    expect(z.match(/\^FD/g)!.length).toBe(1);
    expect(z.match(/\^FS/g)!.length).toBe(1);
  });

  it("EPL2: clears, sizes, draws, prints", () => {
    const e = encodeEpl(label, { dpi: 203 });
    const lines = e.trimEnd().split("\n");
    expect(lines.slice(0, 4)).toEqual(["", "N", "q400", "Q240,24"]);
    expect(e).toMatch(/A24,16,0,\d,1,1,N,"A007"/);
    expect(e).toContain('B24,112,0,1,2,6,64,B,"A007"');
    expect(lines.at(-1)).toBe("P2");
  });

  it("EPL2: quotes and backslashes in text are escaped", () => {
    const e = encodeEpl({ ...label, fields: [{ t: "text", xMm: 0, yMm: 0, text: 'The "big" one\\', heightMm: 5 }] }, { dpi: 203 });
    expect(e).toContain('"The \\"big\\" one\\\\"');
  });

  it("an item label carries the queue number and the item", () => {
    const o = order();
    const l = itemLabel(o, o.lines[0]!, { merchantName: "B", outletName: "O", now: NOW });
    const texts = l.fields.filter((f) => f.t === "text").map((f) => (f as { text: string }).text);
    expect(texts[0]).toBe("A007");
    expect(texts[1]).toBe("Kaya Toast");
  });
});

describe("kitchen ticket: who it is for", () => {
  const ctx = { merchantName: "B", outletName: "O", now: NOW, timeZone: "Asia/Singapore" } as never;
  const dine = { id: "dine", name: "Dine in", service: true, kind: "dine_in" as const };
  it("prints the table and the customer's name, so a runner can find them, but never the phone number", () => {
    const text = plainText(kitchenTicket(order({ channel: dine, spot: "Table 12", name: "Mei Lin", phone: "+6591234567" }), ctx), 42).join("\n");
    expect(text).toContain("Table 12");
    expect(text).toContain("Mei Lin");
    expect(text).not.toContain("6591234567");
    expect(text).not.toContain("+65");
  });
  it("leaves the name line out when there is no name, and never prints the phone", () => {
    const text = plainText(kitchenTicket(order({ channel: dine, spot: "Table 3", phone: "+6598765432" }), ctx), 42).join("\n");
    expect(text).toContain("Table 3");
    expect(text).not.toContain("6598765432");
    expect(text).not.toContain("undefined");
    const none = plainText(kitchenTicket(order({ channel: dine, spot: "Table 3" }), ctx), 42).join("\n");
    expect(none).not.toContain("undefined");
  });
});

describe("leaving the queue number off", () => {
  const ctx = { merchantName: "B", outletName: "O", now: NOW, timeZone: "Asia/Singapore" } as never;
  const dine = { id: "dine", name: "Dine in", service: true, kind: "dine_in" as const };
  it("the kitchen ticket and the receipt show the queue number by default and omit it when told", () => {
    const o = order({ channel: dine, spot: "Table 9", pay: "all" });
    expect(plainText(kitchenTicket(o, ctx), 42).join("\n")).toContain("A007");
    expect(plainText(kitchenTicket(o, ctx, { showQueue: false }), 42).join("\n")).not.toContain("A007");
    expect(plainText(kitchenTicket(o, ctx, { showQueue: false }), 42).join("\n")).toContain("Table 9");
    expect(plainText(receipt(o, config, ctx), 42).join("\n")).toContain("Order A007");
    expect(plainText(receipt(o, config, ctx, { showQueue: false }), 42).join("\n")).not.toContain("A007");
  });
});

describe("Printed at, at the bottom", () => {
  const ctx = { merchantName: "B", outletName: "O", now: Date.UTC(2026, 10, 13, 9, 19, 34), timeZone: "Asia/Singapore" } as never;
  const dine = { id: "dine", name: "Dine in", service: true, kind: "dine_in" as const };
  it("shows the date and time to the second, in Singapore time, with AM or PM", () => {
    expect(printedAt(Date.UTC(2026, 10, 13, 9, 19, 34))).toBe("Printed at: 13/11/2026, 5:19:34 PM");
    expect(printedAt(Date.UTC(2026, 10, 12, 16, 0, 5))).toBe("Printed at: 13/11/2026, 12:00:05 AM");
    expect(printedAt(Date.UTC(2026, 10, 13, 4, 5, 9))).toBe("Printed at: 13/11/2026, 12:05:09 PM");
  });
  it("is the last line of a kitchen ticket and of a receipt, and no longer at the top", () => {
    const k = plainText(kitchenTicket(order({ channel: dine, spot: "Table 14" }), ctx), 42).filter((l) => l.trim());
    expect(k[k.length - 1]).toContain("Printed at: 13/11/2026, 5:19:34 PM");
    expect(k.slice(0, 3).join(" ")).not.toContain("13/11/2026");
    const r = plainText(receipt(order({ channel: dine, spot: "Table 14", pay: "all" }), config, ctx), 42).filter((l) => l.trim());
    expect(r[r.length - 1]).toContain("Printed at: 13/11/2026, 5:19:34 PM");
    expect(r.slice(0, 4).join(" ")).not.toContain("13/11/2026");
  });
});


describe("order notes", () => {
  const ctx = { merchantName: "B", outletName: "O", now: NOW };
  const withNote = (note: string): OrderState => ({ ...order({ pay: "all" }), note });
  it("the kitchen ticket carries the order note, big and bold, and the guest check shows it", () => {
    const o = withNote("Allergy: nuts");
    expect(plainText(kitchenTicket(o, ctx), 42).join("\n")).toContain("NOTE: Allergy: nuts");
    expect(plainText(receipt(o, config, ctx), 42).join("\n")).toContain("Note: Allergy: nuts");
    expect(plainText(kitchenTicket(order({}), ctx), 42).join("\n")).not.toContain("NOTE:");
  });
  it("a note added after the order was sent prints its own slip, and says when it was removed", () => {
    expect(plainText(noteSlip(withNote("Birthday"), ctx), 42).join("\n")).toContain("NOTE UPDATED");
    expect(plainText(noteSlip(withNote("Birthday"), ctx), 42).join("\n")).toContain("NOTE: Birthday");
    expect(plainText(noteSlip(order({}), ctx), 42).join("\n")).toContain("NOTE REMOVED");
  });
});


describe("the 7-Eleven style receipt", () => {
  const base = { merchantName: "Bailey & Patch", outletName: "Enabling Village", now: NOW };
  const o = order({ pay: "all" });
  const text = (ctx: object, opts = {}, ord = o) => plainText(receipt(ord, config, { ...base, ...ctx }, opts), 42).join("\n");

  it("is a plain receipt, not a tax invoice, until the shop has a GST number", () => {
    const t = text({});
    expect(t).not.toContain("TAX Invoice");
    expect(t).not.toContain("GST AMT");
    expect(t).toMatch(/Total \(SGD\)\s+S\$10\.90/);
  });
  it("becomes a tax invoice with GST lines, and works the GST out of the total less deposits", () => {
    const t = text({ gstRegNo: "M90012345X", uen: "202612345X", address: "1 Village Road" });
    expect(t).toContain("TAX Invoice");
    expect(t).toContain("GST M90012345X BIZ 202612345X");
    expect(t).toContain("1 Village Road");
    expect(t).toMatch(/Total \(SGD\) INCL\. GST\s+S\$10\.90/);
    expect(t).toMatch(/GST AMT\s+S\$0\.\d\d/);
  });
  it("shows cash handed over and the change, the member, the POSID line and a barcode of the transaction", () => {
    const paid = { ...o, payments: o.payments.map((p) => ({ ...p, tenderedCents: 2000 })) };
    const t = text({ memberLast4: "4821", cashier: "Cat", posId: "002" }, {}, paid);
    expect(t).toMatch(/Cash tendered\s+S\$20\.00/);
    expect(t).toMatch(/Change\s+S\$9\.10/);
    expect(t).toContain("Member ID: ***4821");
    expect(t).toMatch(/POSID:002 C:Cat \d\d:\d\d:\d\d\s+\d\d-\d\d-\d{4}\s+TR\d{6}/); // till, cashier, time, date and transaction together (it wraps on narrow paper)
    expect(t).toContain("Terms and Conditions apply.");
    const doc = receipt(paid, config, { ...base, now: NOW });
    const bar = doc.blocks.find((x) => x.t === "barcode") as { data: string } | undefined;
    expect(bar?.data).toMatch(/^\d{14}$/);
  });
  it("lists each check of a split bill with its payments", () => {
    const split = { ...o, split: { method: "even" as const, at: 1, checks: [{ id: "c1", no: 1, totalCents: 545 }, { id: "c2", no: 2, totalCents: 545 }] }, payments: [{ paymentId: "p1", method: "cash" as const, amountCents: 545, confirmed: true, checkId: "c1" }, { paymentId: "p2", method: "card" as const, amountCents: 545, confirmed: true, checkId: "c2" }] };
    const t = text({}, {}, split);
    expect(t).toMatch(/Check 01 Cash\s+S\$5\.45/);
    expect(t).toMatch(/Check 02 Card\s+S\$5\.45/);
  });
  it("a discount reads as a trailing minus", () => {
    const d = { ...o, discounts: [{ id: "d1", scope: "bill" as const, kind: "amount" as const, value: 100, reason: "x", at: 1 }] };
    expect(text({}, {}, d)).toMatch(/Discount\s+S\$1\.00-/);
  });
});

describe("the guest check", () => {
  const base = { merchantName: "Bailey & Patch", outletName: "Enabling Village", now: NOW };
  const o = order({});
  it("shows what is to be paid and says it is not a receipt, with no payment wording", () => {
    const t = plainText(guestCheck(o, config, base), 42).join("\n");
    expect(t).toContain("GUEST CHECK");
    expect(t).toContain("Not a receipt");
    expect(t).toContain("2 x KAYA TOAST");
    expect(t).toMatch(/Total \(SGD\)\s+S\$10\.90/);
    expect(t).not.toContain("Cash");
    expect(t).not.toContain("TAX Invoice");
  });
  it("one check of a split bill lists only what it carries, its total and what is still due", () => {
    const line = o.lines[0]!;
    const split = { ...o, split: { method: "item" as const, at: 1, checks: [{ id: "c1", no: 1, totalCents: 545, shares: [{ lineId: line.lineId, qty: 1 }] }, { id: "c2", no: 2, totalCents: 545 }] }, payments: [{ paymentId: "p1", method: "cash" as const, amountCents: 200, confirmed: true, checkId: "c1" }] };
    const t = plainText(guestCheck(split, config, base, { checkId: "c1" }), 42).join("\n");
    expect(t).toContain("Check 01 of 02");
    expect(t).toMatch(/1 x KAYA TOAST/);
    expect(t).toMatch(/Check total\s+S\$5\.45/);
    expect(t).toMatch(/Balance due\s+S\$3\.45/);
  });
});
