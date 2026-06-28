import type { EstimateLineItem } from "./estimate-engine";
import type { PriceBookUnit } from "./enums";

export const MATERIAL_ORDER_STATUS = ["draft", "ordered", "delivered", "canceled"] as const;
export type MaterialOrderStatus = (typeof MATERIAL_ORDER_STATUS)[number];

/** A bill-of-materials line: a projection of an EstimateLineItem (no category/waste/pitch). */
export type MaterialOrderLine = {
  key: string;
  name: string;
  quantity: number;
  unit: PriceBookUnit;
  unitPriceCents: number;
  amountCents: number;
  unitCostCents?: number;
  lineCostCents?: number;
};

/** Days of lead time the supplier needs before the crew install date. */
export const DELIVERY_BUFFER_DAYS = 2;

/** Keep only material lines and drop the non-BOM fields. */
export function materialLinesFromEstimate(lineItems: EstimateLineItem[]): MaterialOrderLine[] {
  return lineItems
    .filter((l) => l.category === "material")
    .map((l) => ({
      key: l.key,
      name: l.name,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      amountCents: l.amountCents,
    }));
}

/** List-price BOM subtotal: sum of line amounts (what the homeowner is charged, NOT cost). */
export function materialOrderSubtotalCents(lines: MaterialOrderLine[]): number {
  return lines.reduce((sum, l) => sum + l.amountCents, 0);
}

/** Delivery target = install date − buffer days. Null when there is no install date. */
export function neededByFromInstall(installAt: Date | null, bufferDays: number = DELIVERY_BUFFER_DAYS): Date | null {
  if (!installAt) return null;
  return new Date(installAt.getTime() - bufferDays * 86_400_000);
}

/** Derived delivery health for the cockpit (not stored). */
export function materialDeliveryFlag(input: { neededByAt: Date | null; installAt: Date | null }): "none" | "no_install" | "misaligned" {
  if (!input.installAt || !input.neededByAt) return "no_install";
  return input.neededByAt.getTime() > input.installAt.getTime() ? "misaligned" : "none";
}

/** Attach per-unit supplier cost (by line key) and compute the cost subtotal. Missing key → 0. */
export function attachMaterialCosts(
  lines: MaterialOrderLine[],
  costByKey: Record<string, number>,
): { lines: MaterialOrderLine[]; costSubtotalCents: number } {
  const costed = lines.map((l) => {
    const unitCostCents = costByKey[l.key] ?? 0;
    return { ...l, unitCostCents, lineCostCents: l.quantity * unitCostCents };
  });
  const costSubtotalCents = costed.reduce((sum, l) => sum + (l.lineCostCents ?? 0), 0);
  return { lines: costed, costSubtotalCents };
}
