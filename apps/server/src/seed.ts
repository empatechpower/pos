import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Catalog, OptionGroup } from "@pos/core";
import { sniffImage } from "./brand.js";

/** The Bailey & Patch menu from the client's prototype: 132 items in 19 categories, with photos and options. */
export interface BaileyPatchSeed {
  catalog: Catalog;
  images: Map<string, { bytes: Buffer; type: string }>;
  brand: { primary: string; accent: string; tagline: string; logo: Buffer; hero: Buffer };
}

interface SeedProduct {
  id: string;
  name: string;
  altName?: string;
  category: string;
  priceCents: number;
  description?: string;
  soldOut?: boolean;
  pointsExempt?: boolean;
  image: string | null;
  options?: OptionGroup[];
}

/** Take away prices (spec 14.5): food is S$0.30 above dine in; drinks, beer/whisky and pet items are unchanged. */
const NON_FOOD = new Set(["Coffee & Tea", "Beverages", "Beer / Whisky"]);
const isFood = (category: string) => !NON_FOOD.has(category) && !category.startsWith("Pet");

const DIR = fileURLToPath(new URL("../seed/bailey-patch", import.meta.url));

export function loadBaileyPatch(dir = DIR): BaileyPatchSeed | null {
  if (!existsSync(join(dir, "products.json"))) return null;
  const rows = JSON.parse(readFileSync(join(dir, "products.json"), "utf8")) as SeedProduct[];
  const images = new Map<string, { bytes: Buffer; type: string }>();
  for (const r of rows) {
    if (!r.image) continue;
    const bytes = readFileSync(join(dir, r.image));
    const type = sniffImage(bytes);
    if (type) images.set(r.id, { bytes, type });
  }
  const standard = Object.fromEntries(rows.map((r) => [r.id, r.priceCents]));
  const takeaway = Object.fromEntries(rows.map((r) => [r.id, r.priceCents + (isFood(r.category) ? 30 : 0)]));
  return {
    images,
    catalog: {
      version: 1,
      defaultPricebookId: "standard",
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        ...(r.altName ? { altName: r.altName } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.soldOut ? { soldOut: true } : {}),
        ...(r.pointsExempt ? { pointsExempt: true } : {}),
        ...(r.options ? { options: r.options } : {}),
      })),
      pricebooks: [
        { id: "standard", name: "Dine in", missing: "show", prices: standard },
        { id: "takeaway", name: "Take away", missing: "show", prices: takeaway },
      ],
      channels: [
        { id: "dine-in", name: "Dine in", kind: "dine_in", serviceCharge: true, active: true },
        { id: "take-away", name: "Take away", kind: "takeaway", serviceCharge: false, active: true },
      ],
      assignments: [{ pricebookId: "takeaway", channelId: "take-away" }],
    },
    // The prototype's own colours: red for the main buttons, orange as the accent.
    brand: { primary: "#e1523e", accent: "#ea7016", tagline: "Where every tail tells a tale", logo: readFileSync(join(dir, "logo.jpg")), hero: readFileSync(join(dir, "hero.jpg")) },
  };
}
