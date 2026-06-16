import type { PriceBookCategory, PriceBookUnit } from "./enums";

export interface DefaultPriceBookItem {
  key: string;
  name: string;
  category: PriceBookCategory;
  unit: PriceBookUnit;
  unitPriceCents: number;
  sourceFields: string[];
  wasteApplies: boolean;
  packSize: number;
  sortOrder: number;
}

// Built-in defaults. Prices are placeholders the tenant edits. Waste ONLY on field shingles.
export const DEFAULT_PRICE_BOOK: DefaultPriceBookItem[] = [
  { key: "field-shingles", name: "Field shingles", category: "material", unit: "square", unitPriceCents: 12000, sourceFields: ["squares"], wasteApplies: true, packSize: 1, sortOrder: 10 },
  { key: "starter-strip", name: "Starter strip", category: "accessory", unit: "lf", unitPriceCents: 200, sourceFields: ["eaveLf"], wasteApplies: false, packSize: 1, sortOrder: 20 },
  { key: "hip-ridge-cap", name: "Hip & ridge cap", category: "accessory", unit: "lf", unitPriceCents: 400, sourceFields: ["ridgeLf", "hipLf"], wasteApplies: false, packSize: 1, sortOrder: 30 },
  { key: "drip-edge", name: "Drip edge", category: "accessory", unit: "lf", unitPriceCents: 150, sourceFields: ["eaveLf", "rakeLf"], wasteApplies: false, packSize: 10, sortOrder: 40 },
  { key: "underlayment", name: "Underlayment", category: "material", unit: "square", unitPriceCents: 1500, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 50 },
  { key: "ice-water-shield", name: "Ice & water shield", category: "material", unit: "lf", unitPriceCents: 300, sourceFields: ["eaveLf", "valleyLf"], wasteApplies: false, packSize: 1, sortOrder: 60 },
  { key: "valley-metal", name: "Valley metal", category: "material", unit: "lf", unitPriceCents: 350, sourceFields: ["valleyLf"], wasteApplies: false, packSize: 1, sortOrder: 70 },
  { key: "step-flashing", name: "Step flashing", category: "material", unit: "lf", unitPriceCents: 250, sourceFields: ["stepFlashingLf"], wasteApplies: false, packSize: 1, sortOrder: 80 },
  { key: "pipe-boots", name: "Pipe boots", category: "accessory", unit: "each", unitPriceCents: 2500, sourceFields: ["penetrationCount"], wasteApplies: false, packSize: 1, sortOrder: 90 },
  { key: "tear-off", name: "Tear-off (labor)", category: "labor", unit: "square", unitPriceCents: 6000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 100 },
  { key: "install", name: "Install (labor)", category: "labor", unit: "square", unitPriceCents: 8000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 110 },
];
