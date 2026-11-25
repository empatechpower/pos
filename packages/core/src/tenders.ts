import type { PaymentMethod } from "./events.js";

/**
 * Ways of paying that the till only records (handout 4.11): the money is taken somewhere else (a card terminal, a cheque, a gift card) and
 * the cashier confirms it. Each belongs to one of the money kinds the books already know (`method`), and keeps its own name on the payment
 * (`tender`), so receipts and reports can tell a debit card from a credit card.
 */
export interface TenderKind { id: string; label: string; method: PaymentMethod; /** Hidden on the payment panel until a manager shows it. */ optional?: boolean }

export const RECORDED_TENDERS: readonly TenderKind[] = [
  { id: "card", label: "Card", method: "card" },
  { id: "debit", label: "Debit", method: "card", optional: true },
  { id: "manualcard", label: "Manual Card", method: "card", optional: true },
  { id: "check", label: "Check", method: "other", optional: true },
  { id: "giftcard", label: "Gift Card", method: "other", optional: true },
];
const BY_ID = new Map(RECORDED_TENDERS.map((t) => [t.id, t]));
export const recordedTender = (id: string | undefined): TenderKind | undefined => (id ? BY_ID.get(id) : undefined);

const METHOD_LABEL: Record<string, string> = { cash: "Cash", card: "Card", paynow: "PayNow", credit: "Member credit", other: "Other", mock: "Practice" };

/**
 * A tender the shop made up itself (a delivery platform such as GrabFood, a gift certificate, a house account). The till only records it,
 * like the built-in ones, and the payment carries the name it had at the time, so a receipt or report never depends on today's settings.
 */
export const CUSTOM_TENDER_ID = /^ct-[a-z0-9]{1,20}$/;
const CUSTOM = "custom:";
export const cleanTenderName = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) : "");
/** The shop's own name for a payment, when it was taken as one of its custom tenders. */
export const customTenderName = (p: { tender?: string; tenderName?: string }): string | undefined => (p.tender && CUSTOM_TENDER_ID.test(p.tender) && p.tenderName ? p.tenderName : undefined);

/** What a payment is filed under in reports: its tender when it has one (a built-in one, or the shop's own by name), else its money kind. */
export const paymentKey = (p: { method: string; tender?: string; tenderName?: string }): string => (recordedTender(p.tender) ? p.tender! : customTenderName(p) ? CUSTOM + customTenderName(p) : p.method);
/** The words for a payment key (a tender id, a custom tender, or a money kind). */
export const paymentLabel = (key: string): string => (key.startsWith(CUSTOM) ? key.slice(CUSTOM.length) : recordedTender(key)?.label ?? METHOD_LABEL[key] ?? key);
