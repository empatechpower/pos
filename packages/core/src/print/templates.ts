import type { BusinessConfig } from "../config.js";
import type { OrderLine, OrderState } from "../events.js";
import { confirmedPaid, orderTotals } from "../events.js";
import { formatMoney } from "../money.js";
import { optionLines } from "../options.js";
import type { Block, Doc, Label } from "./doc.js";

export interface PrintContext {
  merchantName: string;
  outletName: string;
  /** Print time, ms since epoch. Passed in so output is reproducible. */
  now: number;
  timeZone?: string;
  /** Shown at the foot of a receipt, e.g. a GST registration number or "Thank you". */
  footer?: string[];
}

const METHOD: Record<string, string> = { cash: "Cash", card: "Card", paynow: "PayNow", credit: "Store credit", other: "Other" };

export const stamp = (ms: number, timeZone = "Asia/Singapore") =>
  new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(ms))
    .replace(",", "");

/** "Printed at: 13/11/2026, 5:19:34 PM": the date and time down to the second, shown at the bottom of a ticket. */
export const printedAt = (ms: number, timeZone = "Asia/Singapore"): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const h = Number(parts.hour) % 24;
  return `Printed at: ${parts.day}/${parts.month}/${parts.year}, ${h % 12 === 0 ? 12 : h % 12}:${parts.minute}:${parts.second} ${h < 12 ? "AM" : "PM"}`;
};

const where = (o: OrderState) => (o.fulfilment === "dine_in" ? o.spot ?? o.channelName : o.channelName) ?? (o.fulfilment === "takeaway" ? "Take away" : "Delivery");
const liveLines = (o: OrderState) => o.lines.filter((l) => l.qty > 0);

/** Customer receipt. Prices come from the order itself (frozen when it was placed), never today's catalog. */
export function receipt(order: OrderState, config: BusinessConfig, ctx: PrintContext, opts: { showQueue?: boolean } = {}): Doc {
  const t = orderTotals(order, config);
  const b: Block[] = [
    { t: "text", text: ctx.merchantName, align: "center", bold: true, size: 2 },
    { t: "text", text: ctx.outletName, align: "center" },
    { t: "rule" },
    { t: "cols", left: order.queueNumber && opts.showQueue !== false ? `Order ${order.queueNumber}` : "Order", right: where(order) },
    { t: "rule" },
  ];
  for (const l of liveLines(order)) {
    b.push({ t: "cols", left: `${l.qty} x ${l.name}`, right: formatMoney(l.unitCents * l.qty) });
    // Options sit under the item, marked with a dash (leading spaces would be collapsed when wrapping).
    for (const o of optionLines(l.options)) b.push({ t: "text", text: `- ${o}` });
  }
  b.push({ t: "rule" }, { t: "cols", left: "Subtotal", right: formatMoney(t.subtotal) });
  if (t.service) b.push({ t: "cols", left: "Service charge", right: formatMoney(t.service) });
  if (t.gst) b.push({ t: "cols", left: "GST", right: formatMoney(t.gst) });
  if (t.bcrs) b.push({ t: "cols", left: "BCRS deposit", right: formatMoney(t.bcrs) });
  if (t.couponDiscount) b.push({ t: "cols", left: "Coupon", right: "-" + formatMoney(t.couponDiscount) });
  if (t.pointsDiscount) b.push({ t: "cols", left: "Points", right: "-" + formatMoney(t.pointsDiscount) });
  b.push({ t: "rule", ch: "=" }, { t: "cols", left: "TOTAL", right: formatMoney(t.total), bold: true });
  for (const p of order.payments.filter((x) => x.confirmed)) b.push({ t: "cols", left: METHOD[p.method] ?? p.method, right: formatMoney(p.amountCents) });
  const owing = t.total - confirmedPaid(order);
  if (owing > 0) b.push({ t: "cols", left: "Balance due", right: formatMoney(owing), bold: true });
  if (order.queueNumber && opts.showQueue !== false) b.push({ t: "text", text: order.queueNumber, align: "center", bold: true, size: 3 });
  for (const f of ctx.footer ?? ["Thank you"]) b.push({ t: "text", text: f, align: "center" });
  b.push({ t: "rule" }, { t: "text", text: printedAt(ctx.now, ctx.timeZone) });
  b.push({ t: "feed", n: 3 }, { t: "cut" });
  return { blocks: b };
}

/** Add `drawer` first so a cash sale opens the till as the receipt prints. */
export const withDrawer = (doc: Doc): Doc => ({ blocks: [{ t: "drawer" }, ...doc.blocks] });

export interface KitchenOptions {
  /** Only these lines (a printer's share, or the lines not printed before). Defaults to all. */
  lines?: OrderLine[];
  /** True when this ticket adds to an order already sent to the kitchen. */
  addOn?: boolean;
  /** Print the big queue number at the top. On unless set to false. */
  showQueue?: boolean;
}

/** Kitchen/bar ticket: big queue number and big items, no prices. */
export function kitchenTicket(order: OrderState, ctx: PrintContext, opts: KitchenOptions = {}): Doc {
  const lines = (opts.lines ?? liveLines(order)).filter((l) => l.qty > 0);
  const b: Block[] = [];
  if (opts.addOn) b.push({ t: "text", text: "*** ADD-ON ***", align: "center", bold: true });
  if (opts.showQueue !== false) b.push({ t: "text", text: order.queueNumber ?? "-", align: "center", bold: true, size: 3 });
  b.push({ t: "text", text: where(order), align: "center", bold: true, size: 2 });
  // Who the order is for (by name), so the runner can find that person even if they have moved tables.
  // The phone number is never printed. The name is printed only when there is one, otherwise the line is left out.
  if (order.customerName) b.push({ t: "text", text: order.customerName, align: "center", bold: true, size: 2 });
  b.push({ t: "rule" });
  for (const l of lines) {
    b.push({ t: "text", text: `${l.qty} x ${l.name}`, bold: true, size: 2 });
    for (const o of optionLines(l.options)) b.push({ t: "text", text: `- ${o}`, bold: true });
  }
  b.push({ t: "rule" }, { t: "text", text: printedAt(ctx.now, ctx.timeZone) }, { t: "feed", n: 3 }, { t: "cut" });
  return { blocks: b };
}

export type CutMode = "grouped" | "unit" | "category";
export interface Cut {
  /** What is printed on this cut. */
  lines: OrderLine[];
  /** Every order line this cut covers (several, when identical items were added together). */
  lineIds: string[];
}

/**
 * How a kitchen printer splits an order into cuts (separate tickets).
 * Identical items (same product, same modifiers) are always added together: 2 x Milo (iced) is one line. Milo (iced) and Milo (hot)
 * are different items and never share a line.
 *   grouped  (default) one cut for each different item, so 2 x Milo (iced) is one cut and Milo (iced) + Milo (hot) are two
 *   unit     one cut for every single item, like a label: 2 x Milo (iced) is two cuts
 *   category one cut for each category, listing its items
 */
export function kitchenCuts(lines: readonly OrderLine[], mode: CutMode, categoryOf: (productId: string) => string): Cut[] {
  const merged: Array<{ line: OrderLine; ids: string[] }> = [];
  const at = new Map<string, number>();
  for (const l of lines) {
    if (l.qty <= 0) continue;
    const key = `${l.productId}\u0000${optionLines(l.options).slice().sort().join("\u0001")}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, merged.length);
      merged.push({ line: { ...l }, ids: [l.lineId] });
    } else {
      merged[i]!.line = { ...merged[i]!.line, qty: merged[i]!.line.qty + l.qty };
      merged[i]!.ids.push(l.lineId);
    }
  }
  if (mode === "category") {
    const groups = new Map<string, Cut>();
    for (const m of merged) {
      const c = categoryOf(m.line.productId);
      const g = groups.get(c) ?? { lines: [], lineIds: [] };
      g.lines.push(m.line);
      g.lineIds.push(...m.ids);
      groups.set(c, g);
    }
    return [...groups.values()];
  }
  if (mode === "unit") return merged.flatMap((m) => Array.from({ length: m.line.qty }, () => ({ lines: [{ ...m.line, qty: 1 }], lineIds: m.ids })));
  return merged.map((m) => ({ lines: [m.line], lineIds: m.ids }));
}

/** One sticky label per unit (cup, bag), so each item is identifiable on the pass. */
export function itemLabel(order: OrderState, line: OrderLine, ctx: PrintContext, size = { widthMm: 50, heightMm: 30 }): Label {
  return {
    ...size,
    copies: 1,
    fields: [
      { t: "text", xMm: 3, yMm: 2, text: order.queueNumber ?? "-", heightMm: 9 },
      { t: "text", xMm: 3, yMm: 13, text: line.name.slice(0, 28), heightMm: 4.5 },
      { t: "text", xMm: 3, yMm: 19, text: (optionLines(line.options).join(", ") || where(order)).slice(0, 34), heightMm: 3.5 },
      { t: "text", xMm: 3, yMm: 24, text: `${where(order)}  ${stamp(ctx.now, ctx.timeZone)}`.slice(0, 34), heightMm: 3 },
    ],
  };
}
