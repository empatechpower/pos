import type { Cents } from "@pos/core";

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  priceCents: Cents;
  soldOut?: boolean;
  pointsExempt?: boolean;
}

/** Sample menu (a few Bailey & Patch items from the prototype). Replace with the admin-managed menu. */
export const MENU: MenuItem[] = [
  { id: "kaya-toast", name: "Kaya Toast", category: "Toast", priceCents: 200 },
  { id: "kopi", name: "Coffee", category: "Drinks", priceCents: 220 },
  { id: "teh", name: "Milk Tea", category: "Drinks", priceCents: 240 },
  { id: "coke-bcrs", name: "Coke Classic 320ml BCRS", category: "Drinks", priceCents: 250 },
  { id: "karaage-rice", name: "Chicken Karaage Tornado Rice", category: "Rice", priceCents: 890 },
  { id: "nasi-lemak", name: "Nasi Lemak", category: "Rice", priceCents: 690 },
  { id: "fried-rice", name: "Egg Fried Rice", category: "Rice", priceCents: 650 },
  { id: "soft-egg", name: "Soft-boiled Eggs", category: "Sides", priceCents: 180 },
  { id: "beer", name: "Tiger Beer", category: "Bar", priceCents: 900, pointsExempt: true },
  { id: "barley", name: "Barley Water", category: "Drinks", priceCents: 200, soldOut: true },
];
