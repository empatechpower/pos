import type { BusinessConfig } from "../config.js";
import type { OrderLine, OrderState } from "../events.js";
import { confirmedPaid, orderTotals } from "../events.js";
import { formatMoney } from "../money.js";
import { optionLines } from "../options.js";
import { buildTicketLines } from "../builder.js";
import type { Block, Doc, Label } from "./doc.js";

export interface PrintContext {
  merchantName: string;
  outletName: string;
  /** Print time, ms since epoch. Passed in so output is reproducible. */
  now: number;
  timeZone?: string;
  /** Shown at the foot of a receipt, e.g. "Thank you". */
  footer?: string[];
  /** The outlet's address, and (when the shop is GST registered) its GST and business registration numbers. Without a GST number the receipt is not a tax invoice. */
  address?: string;
  gstRegNo?: string;
  uen?: string;
  customerService?: string;
  /** Which till, who took the payment, and the member's last four digits, for the POSID line and the Member ID line. */
  posId?: string;
  cashier?: string;
  memberLast4?: string;
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

/**
 * Customer receipt, laid out like the 7-Eleven Singapore receipt (TengSern, Q44): outlet name and address, TAX Invoice and GST lines when the
 * shop is GST registered, a line per item in capitals, a BCRS deposit line under each deposit item, the total (and GST amount), what was paid
 * and any change, a BCRS summary, the member, a barcode of the transaction, and the POSID line. Prices come from the order itself (frozen when
 * it was placed), never today's catalog. Modifiers print only when asked for (`printModifiers`): priced ones with their amount, free ones by name.
 */
export function receipt(order: OrderState, config: BusinessConfig, ctx: PrintContext, opts: { showQueue?: boolean; printModifiers?: boolean } = {}): Doc {
  const t = orderTotals(order, config);
  const gstOn = !!ctx.gstRegNo;
  const money = (c: number) => formatMoney(c);
  const b: Block[] = [{ t: "text", text: ctx.merchantName.toUpperCase(), align: "center", bold: true, size: 2 }, { t: "text", text: ctx.outletName, align: "center" }];
  if (ctx.address) b.push({ t: "text", text: ctx.address, align: "center" });
  if (gstOn) b.push({ t: "text", text: "TAX Invoice", align: "center", bold: true }, { t: "text", text: `GST ${ctx.gstRegNo}${ctx.uen ? ` BIZ ${ctx.uen}` : ""}`, align: "center" });
  b.push({ t: "rule" }, { t: "cols", left: order.queueNumber && opts.showQueue !== false ? `Order ${order.queueNumber}` : "Order", right: where(order) }, { t: "rule" });
  let depositUnits = 0;
  for (const l of liveLines(order)) {
    b.push({ t: "cols", left: `${l.qty} x ${l.name.toUpperCase()}`, right: money(l.unitCents * l.qty) });
    if (opts.printModifiers) {
      // Options sit under the item, marked with a dash (leading spaces would be collapsed when wrapping). Free ones print by name, never as S$0.00.
      if (l.build) {
        for (const o of buildTicketLines(l.build, true, formatMoney)) b.push({ t: "text", text: o.startsWith("  ") ? `- ${o.trim()}` : o });
      } else for (const o of l.options ?? []) b.push(o.priceCents ? { t: "cols", left: `- ${optionLines([o])[0]}`, right: `+${money(o.priceCents * (o.qty || 1))}` } : { t: "text", text: `- ${optionLines([o])[0]}` });
    } else if (l.build) {
      for (const o of optionLines(l.options).filter((x) => x.startsWith("Note: "))) b.push({ t: "text", text: `- ${o}` });
    } else for (const o of optionLines(l.options).filter((x) => x.startsWith("Note: "))) b.push({ t: "text", text: `- ${o}` });
    if (l.bcrs) { depositUnits += l.qty; b.push({ t: "cols", left: `  BCRS Deposit Charge x${l.qty}`, right: `${money(l.qty * config.pricing.bcrsDepositCents)} Z` }); }
  }
  if (order.note) b.push({ t: "text", text: `Note: ${order.note}` });
  b.push({ t: "rule" }, { t: "cols", left: "Subtotal", right: money(t.subtotal) });
  // Money taken off reads as a trailing minus, as on the 7-Eleven receipt.
  if (t.couponDiscount) b.push({ t: "cols", left: "Coupon", right: `${money(t.couponDiscount)}-` });
  if (t.discountCents) b.push({ t: "cols", left: "Discount", right: `${money(t.discountCents)}-` });
  if (t.pointsDiscount) b.push({ t: "cols", left: "Points", right: `${money(t.pointsDiscount)}-` });
  if (t.service) b.push({ t: "cols", left: `Service charge (${Math.round(config.pricing.serviceRate * 100)}%)`, right: money(t.service) });
  if (t.fee) b.push({ t: "cols", left: "Service fee", right: money(t.fee) });
  if (t.gst) b.push({ t: "cols", left: "GST", right: money(t.gst) });
  b.push({ t: "rule", ch: "=" }, { t: "cols", left: gstOn ? "Total (SGD) INCL. GST" : "Total (SGD)", right: money(t.total), bold: true });
  if (gstOn) {
    const rate = Math.round(config.pricing.gstRate * 100);
    b.push({ t: "cols", left: "GST AMT", right: money(Math.round(((t.total - t.bcrs) * rate) / (100 + rate))) });
  }
  // What was paid: a split bill lists each check with its payments; cash shows what was handed over and the change.
  const paid = order.payments.filter((x) => x.confirmed && !x.paymentId.startsWith("refund:"));
  const checkNo = new Map((order.split?.checks ?? []).map((c) => [c.id, c.no]));
  for (const p of paid) {
    const label = METHOD[p.method] ?? p.method;
    b.push({ t: "cols", left: p.checkId && checkNo.has(p.checkId) ? `Check ${String(checkNo.get(p.checkId)).padStart(2, "0")} ${label}` : label, right: money(p.amountCents) });
    if (p.tenderedCents) b.push({ t: "cols", left: "  Cash tendered", right: money(p.tenderedCents) }, { t: "cols", left: "  Change", right: money(p.tenderedCents - p.amountCents) });
  }
  for (const r of order.refunds ?? []) b.push({ t: "cols", left: `Refund ${METHOD[r.method] ?? r.method}`, right: `${money(r.amountCents)}-` });
  if (order.voided) b.push({ t: "text", text: "*** VOIDED ***", align: "center", bold: true });
  const owing = order.voided ? 0 : t.total - confirmedPaid(order);
  if (owing > 0) b.push({ t: "cols", left: "Balance due", right: money(owing), bold: true });
  if (t.bcrs) b.push({ t: "rule" }, { t: "cols", left: `Total BCRS Deposit x${depositUnits}`, right: `${money(t.bcrs)} Z` });
  if (ctx.memberLast4) b.push({ t: "text", text: `Member ID: ***${ctx.memberLast4}` });
  if (order.queueNumber && opts.showQueue !== false) b.push({ t: "text", text: order.queueNumber, align: "center", bold: true, size: 3 });
  for (const f of ctx.footer ?? ["Thank you"]) b.push({ t: "text", text: f, align: "center" });
  if (ctx.customerService) b.push({ t: "text", text: `Customer Service: ${ctx.customerService}`, align: "center" });
  // The transaction code: the date (DDMMYYYY) and the order's number, as a barcode and in words.
  const code = transactionCode(order, ctx);
  b.push({ t: "rule" }, { t: "barcode", data: code }, { t: "text", text: code, align: "center" });
  b.push({ t: "text", text: "Please retain and present this Receipt for any refund or replacement of Products", align: "center" });
  b.push({ t: "text", text: `POSID:${ctx.posId ?? "001"}${ctx.cashier ? ` C:${ctx.cashier}` : ""} TR${code.slice(8)}` });
  b.push({ t: "text", text: "Terms and Conditions apply." }, { t: "rule" }, { t: "text", text: printedAt(ctx.now, ctx.timeZone) });
  b.push({ t: "feed", n: 3 }, { t: "cut" });
  return { blocks: b };
}

/**
 * The guest check: what the table is asked to pay, printed before payment. It is not a receipt (no tender, no tax invoice wording).
 * For a split bill it can be one check: its number, what it carries, its total, and what is still due on it.
 */
export function guestCheck(order: OrderState, config: BusinessConfig, ctx: PrintContext, opts: { checkId?: string } = {}): Doc {
  const t = orderTotals(order, config);
  const money = (c: number) => formatMoney(c);
  const check = opts.checkId ? order.split?.checks.find((c) => c.id === opts.checkId) : undefined;
  const b: Block[] = [{ t: "text", text: ctx.merchantName.toUpperCase(), align: "center", bold: true, size: 2 }, { t: "text", text: ctx.outletName, align: "center" }];
  if (ctx.address) b.push({ t: "text", text: ctx.address, align: "center" });
  b.push({ t: "rule" }, { t: "text", text: "GUEST CHECK", align: "center", bold: true, size: 2 }, { t: "text", text: "Not a receipt", align: "center" });
  b.push({ t: "cols", left: order.queueNumber ? `Order ${order.queueNumber}` : "Order", right: where(order) });
  if (order.pax) b.push({ t: "cols", left: "Guests", right: String(order.pax) });
  if (check) b.push({ t: "cols", left: `Check ${String(check.no).padStart(2, "0")} of ${String(order.split!.checks.length).padStart(2, "0")}`, right: check.seat ? `Seat ${check.seat}` : "" });
  b.push({ t: "rule" });
  const byId = new Map(liveLines(order).map((l) => [l.lineId, l]));
  if (check?.shares) for (const sh of check.shares) { const l = byId.get(sh.lineId); if (l) b.push({ t: "cols", left: `${sh.qty} x ${l.name.toUpperCase()}`, right: money(l.unitCents * sh.qty) }); }
  else if (check) b.push({ t: "text", text: order.split!.method === "even" ? "An equal share of the bill" : "An amount of the bill" });
  else for (const l of liveLines(order)) b.push({ t: "cols", left: `${l.qty} x ${l.name.toUpperCase()}`, right: money(l.unitCents * l.qty) });
  if (!check && order.note) b.push({ t: "text", text: `Note: ${order.note}` });
  b.push({ t: "rule" });
  if (check) {
    const paid = order.payments.filter((p) => p.checkId === check.id && p.confirmed).reduce((n, p) => n + p.amountCents, 0);
    b.push({ t: "cols", left: "Check total", right: money(check.totalCents), bold: true });
    if (paid) b.push({ t: "cols", left: "Paid", right: money(paid) });
    b.push({ t: "cols", left: "Balance due", right: money(Math.max(0, check.totalCents - paid)), bold: true });
  } else {
    b.push({ t: "cols", left: "Subtotal", right: money(t.subtotal) });
    if (t.couponDiscount) b.push({ t: "cols", left: "Coupon", right: `${money(t.couponDiscount)}-` });
    if (t.discountCents) b.push({ t: "cols", left: "Discount", right: `${money(t.discountCents)}-` });
    if (t.pointsDiscount) b.push({ t: "cols", left: "Points", right: `${money(t.pointsDiscount)}-` });
    if (t.service) b.push({ t: "cols", left: `Service charge (${Math.round(config.pricing.serviceRate * 100)}%)`, right: money(t.service) });
    if (t.fee) b.push({ t: "cols", left: "Service fee", right: money(t.fee) });
    if (t.gst) b.push({ t: "cols", left: "GST", right: money(t.gst) });
    if (t.bcrs) b.push({ t: "cols", left: "BCRS deposit", right: money(t.bcrs) });
    b.push({ t: "rule", ch: "=" }, { t: "cols", left: "Total (SGD)", right: money(t.total), bold: true });
    const paid = confirmedPaid(order);
    if (paid > 0) b.push({ t: "cols", left: "Paid so far", right: money(paid) }, { t: "cols", left: "Balance due", right: money(Math.max(0, t.total - paid)), bold: true });
  }
  b.push({ t: "rule" }, { t: "text", text: "Please pay at the counter.", align: "center" }, { t: "text", text: printedAt(ctx.now, ctx.timeZone) }, { t: "feed", n: 3 }, { t: "cut" });
  return { blocks: b };
}

/** DDMMYYYY then the order's number (the digits of its queue number, six places; or a short code from its id). */
export function transactionCode(order: OrderState, ctx: Pick<PrintContext, "now" | "timeZone">): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone ?? "Asia/Singapore", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(order.openedAt)).map((x) => [x.type, x.value])) as Record<string, string>;
  const digits = (order.queueNumber ?? "").replace(/\D/g, "");
  const n = digits || String(parseInt(order.orderId.replace(/[^0-9a-f]/gi, "").slice(0, 6) || "0", 16) % 1_000_000);
  return `${p.day}${p.month}${p.year}${n.slice(-6).padStart(6, "0")}`;
}

/** What a tab payment's receipt shows. It reproduces the quote the payment was taken against, so quote, payment and receipt reconcile exactly. */
export interface TabReceiptInput {
  /** "Table 12", or null for a bar tab. */
  spot: string | null;
  code: string;
  payer: string;
  /** Set when the payer paid someone else's share. */
  forName?: string | null;
  /** Set only for a payment a staff member recorded (cash at the counter, a manual fallback). */
  recordedBy?: string | null;
  method: string;
  reference?: string | null;
  at: number;
  lines: Array<{ name: string; units: number; items: number; deposit: number }>;
  itemsCents: number;
  discountCents: number;
  serviceCents: number;
  taxCents: number;
  depositCents: number;
  /** Value already paid toward the bill that reduced this share. */
  creditAppliedCents: number;
  pointsUsed: number;
  /** The cash this payment took. */
  amountCents: number;
  tab: { totalCents: number; paidCents: number; remainingCents: number };
}

/**
 * A receipt for one payment on a tab (Addendum 2.4, 5.1): the share's lines and components as quoted, who the item owner was, who actually paid, and who
 * (if anyone) recorded it. The tab's own position follows, so the table can see what is left.
 */
export function tabPaymentReceipt(r: TabReceiptInput, ctx: PrintContext): Doc {
  const b: Block[] = [
    { t: "text", text: ctx.merchantName, align: "center", bold: true, size: 2 },
    { t: "text", text: ctx.outletName, align: "center" },
    { t: "rule" },
    { t: "cols", left: r.spot ? `Tab ${r.spot}` : "Bar tab", right: r.code },
    { t: "cols", left: "Paid by", right: r.payer },
    ...(r.forName ? [{ t: "cols", left: "For", right: r.forName } as Block] : []),
    { t: "text", text: stamp(r.at, ctx.timeZone) },
    { t: "rule" },
  ];
  for (const l of r.lines) b.push({ t: "cols", left: `${l.units} x ${l.name}`, right: formatMoney(l.items) });
  if (!r.lines.length) b.push({ t: "cols", left: "Toward the bill", right: formatMoney(r.amountCents + r.pointsUsed) });
  else b.push({ t: "rule" }, { t: "cols", left: "Items", right: formatMoney(r.itemsCents) });
  if (r.discountCents) b.push({ t: "cols", left: "Coupon (your part)", right: "-" + formatMoney(r.discountCents) });
  if (r.serviceCents) b.push({ t: "cols", left: "Service charge", right: formatMoney(r.serviceCents) });
  if (r.taxCents) b.push({ t: "cols", left: "GST", right: formatMoney(r.taxCents) });
  if (r.depositCents) b.push({ t: "cols", left: "BCRS deposit", right: formatMoney(r.depositCents) });
  if (r.creditAppliedCents) b.push({ t: "cols", left: "Already paid toward the bill", right: "-" + formatMoney(r.creditAppliedCents) });
  if (r.pointsUsed) b.push({ t: "cols", left: `Points (${r.pointsUsed})`, right: "-" + formatMoney(r.pointsUsed) });
  b.push({ t: "rule", ch: "=" }, { t: "cols", left: "PAID", right: formatMoney(r.amountCents), bold: true }, { t: "cols", left: METHOD[r.method] ?? (r.method === "counter" ? "At the counter" : r.method === "manual" ? "Manual payment" : r.method), right: "" });
  if (r.reference) b.push({ t: "cols", left: "Reference", right: r.reference });
  if (r.recordedBy) b.push({ t: "cols", left: "Recorded by", right: r.recordedBy });
  b.push({ t: "rule" }, { t: "cols", left: "Tab total", right: formatMoney(r.tab.totalCents) }, { t: "cols", left: "Paid so far", right: formatMoney(r.tab.paidCents) }, { t: "cols", left: "Remaining", right: formatMoney(r.tab.remainingCents), bold: r.tab.remainingCents > 0 });
  for (const f of ctx.footer ?? ["Thank you"]) b.push({ t: "text", text: f, align: "center" });
  b.push({ t: "rule" }, { t: "text", text: printedAt(ctx.now, ctx.timeZone) }, { t: "feed", n: 3 }, { t: "cut" });
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
  if (order.customerName) b.push({ t: "text", text: order.customerName, align: "center", bold: true });
  // A note on the whole order stays big and bold so it is not missed.
  if (order.note) b.push({ t: "rule" }, { t: "text", text: `NOTE: ${order.note}`, bold: true, size: 2 });
  b.push({ t: "rule" });
  for (const l of lines) {
    // The item is big and bold. Its choices (Hot, Iced, Big) are plain and smaller. A customer's special request stays big and bold so it is not missed.
    b.push({ t: "text", text: `${l.qty} x ${l.name}`, bold: true, size: 2 });
    if (l.build) {
      for (const o of buildTicketLines(l.build, false, formatMoney)) b.push({ t: "text", text: o.startsWith("  ") ? `- ${o.trim()}` : o, size: 1.4 });
      for (const o of optionLines(l.options).filter((x) => x.startsWith("Note: "))) b.push({ t: "text", text: `- ${o}`, bold: true, size: 2 });
      continue;
    }
    for (const o of optionLines(l.options)) b.push(o.startsWith("Note: ") ? { t: "text", text: `- ${o}`, bold: true, size: 2 } : { t: "text", text: `- ${o}`, size: 1.4 });
  }
  b.push({ t: "rule" }, { t: "text", text: printedAt(ctx.now, ctx.timeZone) }, { t: "feed", n: 3 }, { t: "cut" });
  return { blocks: b };
}

/** A small slip for the kitchen when the order's note was added or changed after the order was already sent. */
export function noteSlip(order: OrderState, ctx: PrintContext, opts: { showQueue?: boolean } = {}): Doc {
  const b: Block[] = [{ t: "text", text: "*** NOTE UPDATED ***", align: "center", bold: true }];
  if (opts.showQueue !== false) b.push({ t: "text", text: order.queueNumber ?? "-", align: "center", bold: true, size: 3 });
  b.push({ t: "text", text: where(order), align: "center", bold: true, size: 2 }, { t: "rule" });
  b.push({ t: "text", text: order.note ? `NOTE: ${order.note}` : "NOTE REMOVED", bold: true, size: 2 });
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
