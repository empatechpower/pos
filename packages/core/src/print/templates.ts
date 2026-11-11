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

const where = (o: OrderState) => (o.fulfilment === "dine_in" ? o.spot ?? o.channelName : o.channelName) ?? (o.fulfilment === "takeaway" ? "Take away" : "Delivery");
const liveLines = (o: OrderState) => o.lines.filter((l) => l.qty > 0);

/** Customer receipt. Prices come from the order itself (frozen when it was placed), never today's catalog. */
export function receipt(order: OrderState, config: BusinessConfig, ctx: PrintContext): Doc {
  const t = orderTotals(order, config);
  const b: Block[] = [
    { t: "text", text: ctx.merchantName, align: "center", bold: true, size: 2 },
    { t: "text", text: ctx.outletName, align: "center" },
    { t: "rule" },
    { t: "cols", left: order.queueNumber ? `Order ${order.queueNumber}` : "Order", right: where(order) },
    { t: "text", text: stamp(ctx.now, ctx.timeZone) },
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
  if (order.queueNumber) b.push({ t: "text", text: order.queueNumber, align: "center", bold: true, size: 3 });
  for (const f of ctx.footer ?? ["Thank you"]) b.push({ t: "text", text: f, align: "center" });
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
}

/** Kitchen/bar ticket: big queue number and big items, no prices. */
export function kitchenTicket(order: OrderState, ctx: PrintContext, opts: KitchenOptions = {}): Doc {
  const lines = (opts.lines ?? liveLines(order)).filter((l) => l.qty > 0);
  const b: Block[] = [];
  if (opts.addOn) b.push({ t: "text", text: "*** ADD-ON ***", align: "center", bold: true });
  b.push(
    { t: "text", text: order.queueNumber ?? "-", align: "center", bold: true, size: 3 },
    { t: "text", text: where(order), align: "center", bold: true, size: 2 },
    { t: "text", text: stamp(ctx.now, ctx.timeZone), align: "center" },
    { t: "rule" },
  );
  for (const l of lines) {
    b.push({ t: "text", text: `${l.qty} x ${l.name}`, bold: true, size: 2 });
    for (const o of optionLines(l.options)) b.push({ t: "text", text: `- ${o}`, bold: true });
  }
  b.push({ t: "rule" }, { t: "feed", n: 3 }, { t: "cut" });
  return { blocks: b };
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
