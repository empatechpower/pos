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

/** What a payment is filed under in reports: its tender when it has a known one, else its money kind. */
export const paymentKey = (p: { method: string; tender?: string }): string => (recordedTender(p.tender) ? p.tender! : p.method);
/** The words for a payment key (a tender id or a money kind). */
export const paymentLabel = (key: string): string => recordedTender(key)?.label ?? METHOD_LABEL[key] ?? key;
