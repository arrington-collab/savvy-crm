import type { MeasurementAreas } from "./measurement";
import { parsePitch, pitchTier } from "./measurement";
import type { PitchTier } from "./estimate-settings";
import type { PriceBookCategory, PriceBookUnit } from "./enums";

export interface EnginePriceBookItem {
  key: string;
  name: string;
  category: PriceBookCategory;
  unit: PriceBookUnit;
  unitPriceCents: number;
  sourceFields: string[];
  wasteApplies: boolean;
  packSize: number;
  active: boolean;
}

export interface EstimateLineItem {
  key: string;
  name: string;
  category: PriceBookCategory;
  unit: PriceBookUnit;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  wasteAppliedPct?: number;
  pitchSurchargePct?: number;
}

function roundUpToPack(qty: number, packSize: number): number {
  if (packSize <= 1) return qty;
  return Math.ceil(qty / packSize) * packSize;
}

function tierLabel(t: PitchTier): string {
  return t.maxRise === null ? `${t.minRise}+` : `${t.minRise}-${t.maxRise}`;
}

export function generateEstimateLineItems(input: {
  areas: MeasurementAreas;
  priceBook: EnginePriceBookItem[];
  defaultWastePct: number; // bps
  pitchTiers: PitchTier[];
}): { lineItems: EstimateLineItem[]; wastePctUsed: number; pitchTierApplied: string } {
  const rise = parsePitch(input.areas.predominantPitch);
  const tier = pitchTier(rise, input.pitchTiers);
  const wastePctUsed = input.defaultWastePct + tier.wasteBumpPct;
  const areas = input.areas as unknown as Record<string, number>;

  const lineItems: EstimateLineItem[] = [];
  for (const item of input.priceBook) {
    if (!item.active || item.sourceFields.length === 0) continue;
    let qty = item.sourceFields.reduce((s, f) => s + (areas[f] ?? 0), 0);
    if (qty <= 0) continue;

    let wasteAppliedPct: number | undefined;
    if (item.wasteApplies) {
      wasteAppliedPct = wastePctUsed;
      qty = qty * (1 + wastePctUsed / 10_000);
    }
    qty = roundUpToPack(qty, item.packSize);

    let amountCents = Math.round(qty * item.unitPriceCents);
    let pitchSurchargePct: number | undefined;
    if (item.category === "labor" && tier.laborSurchargePct > 0) {
      pitchSurchargePct = tier.laborSurchargePct;
      amountCents = Math.round(amountCents * (1 + tier.laborSurchargePct / 10_000));
    }

    lineItems.push({
      key: item.key, name: item.name, category: item.category, unit: item.unit,
      quantity: qty, unitPriceCents: item.unitPriceCents, amountCents, wasteAppliedPct, pitchSurchargePct,
    });
  }
  return { lineItems, wastePctUsed, pitchTierApplied: tierLabel(tier) };
}
