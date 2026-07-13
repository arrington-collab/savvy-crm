import type { PriceBookCategory, PriceBookUnit } from "./enums";

export interface DefaultPriceBookItem {
  key: string;
  name: string;
  category: PriceBookCategory;
  unit: PriceBookUnit;
  unitPriceCents: number;
  unitCostCents: number;
  sourceFields: string[];
  wasteApplies: boolean;
  packSize: number;
  sortOrder: number;
}

// Built-in defaults. Prices are placeholders the tenant edits. Waste ONLY on field shingles.
export const DEFAULT_PRICE_BOOK: DefaultPriceBookItem[] = [
  { key: "field-shingles", name: "Field shingles", category: "material", unit: "square", unitPriceCents: 12000, unitCostCents: 7800, sourceFields: ["squares"], wasteApplies: true, packSize: 1, sortOrder: 10 },
  { key: "starter-strip", name: "Starter strip", category: "accessory", unit: "lf", unitPriceCents: 200, unitCostCents: 130, sourceFields: ["eaveLf"], wasteApplies: false, packSize: 1, sortOrder: 20 },
  { key: "hip-ridge-cap", name: "Hip & ridge cap", category: "accessory", unit: "lf", unitPriceCents: 400, unitCostCents: 260, sourceFields: ["ridgeLf", "hipLf"], wasteApplies: false, packSize: 1, sortOrder: 30 },
  { key: "drip-edge", name: "Drip edge", category: "accessory", unit: "lf", unitPriceCents: 150, unitCostCents: 100, sourceFields: ["eaveLf", "rakeLf"], wasteApplies: false, packSize: 10, sortOrder: 40 },
  { key: "underlayment", name: "Underlayment", category: "material", unit: "square", unitPriceCents: 1500, unitCostCents: 975, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 50 },
  { key: "ice-water-shield", name: "Ice & water shield", category: "material", unit: "lf", unitPriceCents: 300, unitCostCents: 195, sourceFields: ["eaveLf", "valleyLf"], wasteApplies: false, packSize: 1, sortOrder: 60 },
  { key: "valley-metal", name: "Valley metal", category: "material", unit: "lf", unitPriceCents: 350, unitCostCents: 230, sourceFields: ["valleyLf"], wasteApplies: false, packSize: 1, sortOrder: 70 },
  { key: "step-flashing", name: "Step flashing", category: "material", unit: "lf", unitPriceCents: 250, unitCostCents: 165, sourceFields: ["stepFlashingLf"], wasteApplies: false, packSize: 1, sortOrder: 80 },
  { key: "pipe-boots", name: "Pipe boots", category: "accessory", unit: "each", unitPriceCents: 2500, unitCostCents: 1625, sourceFields: ["penetrationCount"], wasteApplies: false, packSize: 1, sortOrder: 90 },
  { key: "tear-off", name: "Tear-off (labor)", category: "labor", unit: "square", unitPriceCents: 6000, unitCostCents: 6000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 100 },
  { key: "install", name: "Install (labor)", category: "labor", unit: "square", unitPriceCents: 8000, unitCostCents: 8000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 110 },
];

// ---------------------------------------------------------------------------
// Estimate Experience slice 1 — the Good/Better/Best tier products.
// Owner decisions locked 2026-07-08: IKO Cambridge (Good) / IKO Dynasty
// (Better, recommended) / TAMKO Titan XT (Best). Prices and costs are NULL on
// purpose — the owner fills real numbers; we never invent them (the "price
// book needs costs" card surfaces until they do). Palettes are starter sets
// the owner edits in Library.
// ---------------------------------------------------------------------------
export interface DefaultTierProduct {
  tier: "good" | "better" | "best";
  productName: string;
  manufacturer: string;
  unitPriceCents: null;
  unitCostCents: null;
  warrantyText: string;
  warrantyRegistration: string | null;
  recommended: boolean;
  colorPalette: { name: string; hex: string }[];
}

export const DEFAULT_TIER_PRODUCTS: DefaultTierProduct[] = [
  {
    tier: "good",
    productName: "IKO Cambridge",
    manufacturer: "IKO",
    unitPriceCents: null,
    unitCostCents: null,
    warrantyText: "IKO limited lifetime warranty — Cambridge architectural shingles.",
    warrantyRegistration: "Register with IKO within 60 days of installation.",
    recommended: false,
    colorPalette: [
      { name: "Dual Black", hex: "#2b2b2b" },
      { name: "Weatherwood", hex: "#6b5f4e" },
      { name: "Driftwood", hex: "#8a7f6d" },
      { name: "Harvard Slate", hex: "#5a5f63" },
    ],
  },
  {
    tier: "better",
    productName: "IKO Dynasty",
    manufacturer: "IKO",
    unitPriceCents: null,
    unitCostCents: null,
    warrantyText: "IKO limited lifetime warranty with ArmourZone reinforcement — Dynasty performance shingles.",
    warrantyRegistration: "Register with IKO within 60 days of installation.",
    recommended: true,
    colorPalette: [
      { name: "Granite Black", hex: "#262626" },
      { name: "Frostone Grey", hex: "#70757a" },
      { name: "Brownstone", hex: "#5e4b3c" },
      { name: "Pacific Rim", hex: "#3e4a45" },
    ],
  },
  {
    tier: "best",
    productName: "TAMKO Titan XT",
    manufacturer: "TAMKO",
    unitPriceCents: null,
    unitCostCents: null,
    warrantyText: "TAMKO full-start limited warranty — Titan XT with 160-mph wind coverage.",
    warrantyRegistration: "Register with TAMKO per warranty terms after installation.",
    recommended: false,
    colorPalette: [
      { name: "Rustic Black", hex: "#242424" },
      { name: "Oxford Grey", hex: "#606468" },
      { name: "Rustic Cedar", hex: "#6d5138" },
      { name: "Thunderstorm Grey", hex: "#4c5257" },
    ],
  },
];
