import type { OrderState } from "./events.js";
import type { BusinessConfig } from "./config.js";
import { orderTotals } from "./events.js";
import { totalsLines } from "./pricing.js";
import { buildTicketLines } from "./builder.js";
import { optionLines } from "./options.js";
import { formatMoney } from "./money.js";

/**
 * What the customer-facing screen shows. The till (or the server) makes this from the order; the screen only draws it, so it can run
 * on a second display with no knowledge of prices or rules. Every number is already in whole cents.
 */
export interface DisplayLine {
  qty: number;
  name: string;
  /** Choices and notes under the item, one short line each (a build-your-own item reads grouped by its group). */
  details: string[];
  lineCents: number;
  /** The item carries a refundable deposit (shown as a small tag). */
  deposit?: boolean;
}

export type DisplayMode = "idle" | "sale" | "pay" | "thanks";

export interface DisplayState {
  mode: DisplayMode;
  /** "Dine in", "Take away"... */
  orderType?: string;
  orderNo?: string;
  lines: DisplayLine[];
  totals: Array<{ key: string; label: string; cents: number; negative?: boolean }>;
  totalCents: number;
  /** A picture for the highlighted item (the one just added). */
  imageUrl?: string;
  /** The text of the payment QR (for example the PayNow string). In pay mode. */
  qrText?: string;
  /** A ready-made QR picture, if the till has one. */
  qrImage?: string;
  /** "Demo, not payable" until real payment is connected. */
  demo?: boolean;
}

export const IDLE_DISPLAY: DisplayState = { mode: "idle", lines: [], totals: [], totalCents: 0 };

/** The customer display for an order as it stands. `mode` is "sale" while items are being rung up, "pay" when the customer is asked to pay. */
export function toDisplayState(order: OrderState, config: BusinessConfig, opts: { mode?: DisplayMode; imageUrl?: string; qrText?: string; qrImage?: string; demo?: boolean; orderType?: string } = {}): DisplayState {
  const priced = orderTotals(order, config);
  const lines: DisplayLine[] = order.lines
    .filter((l) => l.qty > 0)
    .map((l) => {
      const notes = optionLines(l.options).filter((o) => o.startsWith("Note: "));
      const details = l.build ? [...buildTicketLines(l.build, false, formatMoney).map((x) => x.trim()), ...notes] : optionLines(l.options);
      return { qty: l.qty, name: l.name, details, lineCents: l.unitCents * l.qty, ...(l.bcrs ? { deposit: true } : {}) };
    });
  return {
    mode: lines.length ? (opts.mode ?? "sale") : "idle",
    ...(opts.orderType ? { orderType: opts.orderType } : { orderType: order.channelName }),
    ...(order.queueNumber ? { orderNo: order.queueNumber } : {}),
    lines,
    totals: totalsLines(priced).filter((t) => t.key !== "total").map((t) => ({ key: t.key, label: t.label, cents: t.cents, ...(t.negative ? { negative: true } : {}) })),
    totalCents: priced.total,
    ...(opts.imageUrl ? { imageUrl: opts.imageUrl } : {}),
    ...(opts.qrText ? { qrText: opts.qrText } : {}),
    ...(opts.qrImage ? { qrImage: opts.qrImage } : {}),
    ...(opts.demo ? { demo: true } : {}),
  };
}
