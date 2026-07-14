import type { MeasurementAreas } from "./measurement";
import type { PitchTier } from "./estimate-settings";
import { generateEstimateLineItems, type EnginePriceBookItem, type EstimateLineItem } from "./estimate-engine";

export type TierKey = "good" | "better" | "best";

export interface TierProductInput {
  tier: TierKey;
  productName: string;
  manufacturer: string;
  /** Per-square retail price. null = owner hasn't priced it yet — the tier can't total. */
  unitPriceCents: number | null;
  /** Per-square cost. null = owner hasn't filled costs — margin can't be verified. */
  unitCostCents: number | null;
  warrantyText: string;
  recommended: boolean;
}

/** Price-book items may carry a quantity formula the plain sourceFields sum can't express. */
export interface TierEngineItem extends EnginePriceBookItem {
  marginFloorBps?: number;
  qtyFormula?: "sum" | "ice_water" | "disposal" | "fixed";
}

export interface MarginFloorViolation {
  key: string;
  unitPriceCents: number;
  unitCostCents: number;
  marginBps: number;
  floorBps: number;
}

export interface TierEstimate {
  tier: TierKey;
  productName: string;
  manufacturer: string;
  warrantyText: string;
  recommended: boolean;
  lineItems: EstimateLineItem[];
  /** null when the tier product is unpriced (needsCosts explains why). */
  subtotalCents: number | null;
  /** "tier:price" / "tier:cost" / "<itemKey>:cost" entries — surface as a "price book needs costs" card. */
  needsCosts: string[];
  /** Priced-under-floor lines. NEVER silently dropped — callers must surface a card. */
  marginFloorViolations: MarginFloorViolation[];
  wastePctUsed: number;
  pitchTierApplied: string;
}

export interface FormulaInputs {
  /** Tear-off layers (disposal = squares × layers). Default 1. */
  layers?: number;
  /** Ice & water courses along eaves (qty = eaveLf × courses + valleyLf). Default 2. */
  iceWaterCourses?: number;
  /** Pre-computed fixed quantities by item key (e.g. ridge-vent LF from the NFA calc). */
  fixedQty?: Record<string, number>;
}

const TIER_ORDER: TierKey[] = ["good", "better", "best"];
export const TIER_SHINGLE_KEY = "tier-shingles";

function marginBps(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return Math.round(((priceCents - costCents) / priceCents) * 10_000);
}

function formulaQty(item: TierEngineItem, areas: MeasurementAreas, f: FormulaInputs): number {
  switch (item.qtyFormula) {
    case "disposal":
      return areas.squares * (f.layers ?? 1);
    case "ice_water":
      return areas.eaveLf * (f.iceWaterCourses ?? 2) + areas.valleyLf;
    case "fixed":
      return f.fixedQty?.[item.key] ?? 0;
    default:
      return 0;
  }
}

export function expandTierEstimates(input: {
  areas: MeasurementAreas;
  priceBook: TierEngineItem[];
  tierProducts: TierProductInput[];
  defaultWastePct: number; // bps
  pitchTiers: PitchTier[];
  /** The base price-book item each tier's shingle product replaces. */
  shingleItemKey: string;
  defaultMarginFloorBps: number;
  formulaInputs?: FormulaInputs;
}): { tiers: TierEstimate[] } {
  const f = input.formulaInputs ?? {};

  // Base scope via the existing engine (plain sourceFields sums, waste, pack, pitch surcharge).
  const sumItems = input.priceBook.filter((i) => !i.qtyFormula || i.qtyFormula === "sum");
  const base = generateEstimateLineItems({
    areas: input.areas,
    priceBook: sumItems,
    defaultWastePct: input.defaultWastePct,
    pitchTiers: input.pitchTiers,
  });

  // Formula-driven lines (disposal, ice & water, fixed/ventilation).
  const formulaLines: EstimateLineItem[] = [];
  for (const item of input.priceBook) {
    if (!item.active || !item.qtyFormula || item.qtyFormula === "sum") continue;
    const qty = formulaQty(item, input.areas, f);
    if (qty <= 0) continue;
    formulaLines.push({
      key: item.key,
      name: item.name,
      category: item.category,
      unit: item.unit,
      quantity: qty,
      unitPriceCents: item.unitPriceCents,
      amountCents: Math.round(qty * item.unitPriceCents),
    });
  }

  const shingleBase = base.lineItems.find((l) => l.key === input.shingleItemKey);
  const sharedLines = [...base.lineItems.filter((l) => l.key !== input.shingleItemKey), ...formulaLines];
  const itemByKey = new Map(input.priceBook.map((i) => [i.key, i]));

  // Margin-floor check on the shared scope (identical across tiers).
  const sharedViolations: MarginFloorViolation[] = [];
  const sharedNeedsCosts: string[] = [];
  for (const line of sharedLines) {
    const src = itemByKey.get(line.key);
    if (!src) continue;
    if (src.unitCostCents == null) {
      sharedNeedsCosts.push(`${line.key}:cost`);
      continue;
    }
    const floor = src.marginFloorBps ?? input.defaultMarginFloorBps;
    const m = marginBps(src.unitPriceCents, src.unitCostCents);
    if (m < floor) {
      sharedViolations.push({
        key: line.key,
        unitPriceCents: src.unitPriceCents,
        unitCostCents: src.unitCostCents,
        marginBps: m,
        floorBps: floor,
      });
    }
  }

  const products = new Map(input.tierProducts.map((p) => [p.tier, p]));
  const tiers: TierEstimate[] = [];

  for (const key of TIER_ORDER) {
    const p = products.get(key);
    if (!p) continue;

    const needsCosts = [...sharedNeedsCosts];
    const violations = [...sharedViolations];
    const lineItems = [...sharedLines];
    let subtotalCents: number | null = null;

    if (p.unitPriceCents == null) {
      needsCosts.push(`${key}:price`);
    } else {
      // The tier shingle line mirrors the base shingle line's quantity math (waste applied).
      const quantity = shingleBase
        ? shingleBase.quantity
        : input.areas.squares * (1 + base.wastePctUsed / 10_000);
      const shingleLine: EstimateLineItem = {
        key: TIER_SHINGLE_KEY,
        name: p.productName,
        category: "material",
        unit: "square",
        quantity,
        unitPriceCents: p.unitPriceCents,
        amountCents: Math.round(quantity * p.unitPriceCents),
        wasteAppliedPct: base.wastePctUsed,
      };
      lineItems.unshift(shingleLine);
      subtotalCents = lineItems.reduce((s, l) => s + l.amountCents, 0);

      if (p.unitCostCents == null) {
        needsCosts.push(`${key}:cost`);
      } else {
        const m = marginBps(p.unitPriceCents, p.unitCostCents);
        if (m < input.defaultMarginFloorBps) {
          violations.push({
            key: TIER_SHINGLE_KEY,
            unitPriceCents: p.unitPriceCents,
            unitCostCents: p.unitCostCents,
            marginBps: m,
            floorBps: input.defaultMarginFloorBps,
          });
        }
      }
    }

    tiers.push({
      tier: key,
      productName: p.productName,
      manufacturer: p.manufacturer,
      warrantyText: p.warrantyText,
      recommended: p.recommended,
      lineItems,
      subtotalCents,
      needsCosts,
      marginFloorViolations: violations,
      wastePctUsed: base.wastePctUsed,
      pitchTierApplied: base.pitchTierApplied,
    });
  }

  return { tiers };
}
