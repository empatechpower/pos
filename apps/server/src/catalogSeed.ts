import type { Catalog } from "@pos/core";
import { MENU } from "./menu.js";

/**
 * Sample catalog until a merchant's own is loaded: the prototype's items under a Standard pricebook,
 * three channels, and a Grab pricebook that is the Standard price + 15% rounded up to 5c, to show
 * channel pricing working. The Grab uplift is invented for the demo, not a client figure.
 */
export function seedCatalog(): Catalog {
  const standard = Object.fromEntries(MENU.map((m) => [m.id, m.priceCents]));
  const grab = Object.fromEntries(MENU.map((m) => [m.id, Math.ceil((m.priceCents * 1.15) / 5) * 5]));
  return {
    version: 1,
    defaultPricebookId: "standard",
    products: MENU.map(({ priceCents: _p, ...p }) => p),
    pricebooks: [
      { id: "standard", name: "Standard", missing: "fallback", prices: standard },
      { id: "grab", name: "Grab", missing: "fallback", prices: grab },
    ],
    channels: [
      { id: "dine-in", name: "Dine in", kind: "dine_in", serviceCharge: true, active: true },
      { id: "take-away", name: "Take away", kind: "takeaway", serviceCharge: false, active: true },
      { id: "grab", name: "Grab", kind: "delivery", serviceCharge: false, active: true },
    ],
    assignments: [{ pricebookId: "grab", channelId: "grab" }],
  };
}
