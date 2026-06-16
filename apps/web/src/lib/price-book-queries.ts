import "server-only";
import { withTenant, ensurePriceBook, priceBookItem, asc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listPriceBook() {
  const tenantId = await getTenantId();
  await ensurePriceBook(tenantId); // lazy-seed on first open
  return withTenant(tenantId, (tx) =>
    tx.select().from(priceBookItem).orderBy(asc(priceBookItem.sortOrder)),
  );
}
