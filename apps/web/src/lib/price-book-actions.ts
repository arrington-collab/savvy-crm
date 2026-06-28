"use server";
import { withTenant, priceBookItem, eq } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function updatePriceBookItem(input: {
  id: string;
  unitPriceCents: number;
  unitCostCents: number;
  wasteApplies: boolean;
  active: boolean;
  sourceFields: string[];
}) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx
      .update(priceBookItem)
      .set({
        unitPriceCents: input.unitPriceCents,
        unitCostCents: input.unitCostCents,
        wasteApplies: input.wasteApplies,
        active: input.active,
        sourceFields: input.sourceFields,
      })
      .where(eq(priceBookItem.id, input.id)),
  );
}
