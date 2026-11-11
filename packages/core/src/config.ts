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
  /** Points programme. Rates are merchant settings, not constants (addendum 6.6). */
  rewards: RewardsConfig;
}

export interface RewardsConfig {
  /** The points module can be off until the merchant switches it on. */
  pointsEnabled: boolean;
  /** Points earned per S$1 actually paid. Reference example: 1. */
  earnPointsPerDollar: number;
  /** Credited once when a member account is created. */
  welcomePoints: number;
  /** A voucher with no minimum spend, given once with the welcome points. 0 = none. */
  welcomeVoucherCents: number;
  stampCard: StampCardConfig;
}

/** A stamp card: one stamp per qualifying paid order; a full card turns into a voucher. Off until the merchant sets one up. */
export interface StampCardConfig {
  enabled: boolean;
  /** Stamps to fill the card. */
  target: number;
  /** An order earns a stamp only when what was paid reaches this (0 = every order). */
  minPaidCents: number;
  rewardTitle: string;
  rewardCents: number;
}

export const DEFAULT_STAMP_CARD: StampCardConfig = { enabled: false, target: 7, minPaidCents: 0, rewardTitle: "Stamp card reward", rewardCents: 500 };

export const DEFAULT_REWARDS: RewardsConfig = { pointsEnabled: true, earnPointsPerDollar: 1, welcomePoints: 500, welcomeVoucherCents: 200, stampCard: { ...DEFAULT_STAMP_CARD } };

const base = (): Omit<BusinessConfig, "businessId" | "name" | "outletName" | "paymentTiming" | "orderTypes" | "modules"> => ({
  pricing: { ...DEFAULT_PRICING },
  rewards: { ...DEFAULT_REWARDS, stampCard: { ...DEFAULT_STAMP_CARD } },
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
