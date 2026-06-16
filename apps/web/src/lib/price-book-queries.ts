import "server-only";
import { withTenant, ensurePriceBook, priceBookItem, eq, asc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listPriceBook() {
  const tenantId = await getTenantId();
  await ensurePriceBook(tenantId); // lazy-seed on first open
  return withTenant(tenantId, (tx) =>
    tx.select().from(priceBookItem).orderBy(asc(priceBookItem.sortOrder)),
  );
}

export async function updatePriceBookItem(input: {
  id: string;
  unitPriceCents: number;
  wasteApplies: boolean;
  active: boolean;
  sourceFields: string[];
}) {
  "use server";
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx
      .update(priceBookItem)
      .set({
        unitPriceCents: input.unitPriceCents,
        wasteApplies: input.wasteApplies,
        active: input.active,
        sourceFields: input.sourceFields,
      })
      .where(eq(priceBookItem.id, input.id)),
  );
}
