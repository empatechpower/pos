import { DEFAULT_PRICING, type PricingConfig } from "./pricing.js";

/**
 * Per-business configuration. One order engine, many behaviours:
 *  - prepay   : fast serve  – pay first, then wait for a queue number
 *  - postpay  : restaurant  – eat first, pay later (open tab)
 *  - deferred : delivery    – order now, payment settled later, progress tracked
 */
export type PaymentTiming = "prepay" | "postpay" | "deferred";

export interface BusinessConfig {
  businessId: string;
  name: string;
  outletName: string;
  paymentTiming: PaymentTiming;
  orderTypes: Array<"dine_in" | "takeaway" | "delivery">;
  modules: {
    queue: boolean;
    kitchen: boolean;
    /** Not built yet – flags exist so the data model and UI can be gated from day one. */
    splitBill: boolean;
    combineBill: boolean;
    delivery: boolean;
    /** Night-club allocation ledger. Off everywhere; see docs/open-questions.md. */
    allocation: boolean;
  };
  pricing: PricingConfig;
}

const base = (): Omit<BusinessConfig, "businessId" | "name" | "outletName" | "paymentTiming" | "orderTypes" | "modules"> => ({
  pricing: { ...DEFAULT_PRICING },
});

export const PRESETS = {
  fastServe: (businessId: string, name: string, outletName: string): BusinessConfig => ({
    businessId,
    name,
    outletName,
    paymentTiming: "prepay",
    orderTypes: ["dine_in", "takeaway"],
    modules: { queue: true, kitchen: true, splitBill: false, combineBill: false, delivery: false, allocation: false },
    ...base(),
  }),
  restaurant: (businessId: string, name: string, outletName: string): BusinessConfig => ({
    businessId,
    name,
    outletName,
    paymentTiming: "postpay",
    orderTypes: ["dine_in", "takeaway"],
    modules: { queue: true, kitchen: true, splitBill: true, combineBill: true, delivery: false, allocation: false },
    ...base(),
  }),
  delivery: (businessId: string, name: string, outletName: string): BusinessConfig => ({
    businessId,
    name,
    outletName,
    paymentTiming: "deferred",
    orderTypes: ["delivery", "takeaway"],
    modules: { queue: false, kitchen: true, splitBill: false, combineBill: false, delivery: true, allocation: false },
    ...base(),
  }),
} as const;
