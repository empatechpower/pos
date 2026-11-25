import type { ChosenOption, ChosenOptionInput, MenuEntry } from "@pos/core";

export interface BagLine {
  /** The item and its chosen options: the same item with different options is a different line. */
  key: string;
  item: MenuEntry;
  qty: number;
  selection: ChosenOptionInput[];
  options: ChosenOption[];
  /** One unit, options included. */
  unitCents: number;
  /** Priced at the item's member price, because a member is attached to the order. */
  memberPriced?: boolean;
  /** A price set by hand for this line (the list price stays in `unitCents`), and discounts given on it. */
  override?: { unitCents: number; reason: string; approver?: { id: string; name: string } };
  discounts?: Array<{ id: string; kind: "percent" | "amount"; value: number; reason: string; approver?: { id: string; name: string }; existing?: boolean }>;
  /** A note for the kitchen on this item ("no ice"). */
  note?: string;
  /** Table service: 1 Starter, 2 Main, 3 Dessert; and the seat it is for (split by seat). */
  course?: number;
  seat?: number;
  /** Sold through another dining channel than the order's (its price came from that channel's pricebook). */
  channelId?: string;
  channelName?: string;
  /** Held back from the kitchen until it is fired by hand. */
  hold?: boolean;
  /** An item that is not on the menu, added by a manager with a name and price of their own. */
  extra?: boolean;
  /** Already sent to the kitchen as this line of the open order: it cannot be changed here, only added to. */
  sent?: { lineId: string };
}
/** A fee on the whole order (a percentage of the items, or a fixed amount). `existing` = already on the order. */
export type TillFee = { id: string; kind: "percent" | "amount"; value: number; label: string; existing?: boolean };
export type BillDiscount = { id: string; kind: "percent" | "amount"; value: number; reason: string; approver?: { id: string; name: string }; existing?: boolean };
export const effUnit = (b: BagLine) => b.override?.unitCents ?? b.unitCents;

/** An order put aside ("held") so another can be taken; it comes back exactly as it was. */
/** The tax taken off an order at the till (Add/Remove Tax), with why. `existing` = already written to the order. */
export interface TaxOff { reason: string; existing?: boolean }

export interface HeldOrder {
  taxOff?: TaxOff | null;
  id: string;
  savedAt: number;
  bag: BagLine[];
  billDiscounts: BillDiscount[];
  orderNote: string;
  channelId: string;
  spot: string;
  pax: number;
  customerId: string;
  /** The open order this was taken from, when it is changes to a sent order. */
  orderId?: string;
  fees?: TillFee[];
}
