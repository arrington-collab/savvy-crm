import { withTenant } from "../tenant";
import { priceBookItem } from "../schema/pricing";
import { DEFAULT_PRICE_BOOK } from "@savvy/core";

/** Seeds the built-in catalog for a tenant the first time. Idempotent via onConflictDoNothing. */
export async function ensurePriceBook(tenantId: string): Promise<{ seeded: number }> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.select({ id: priceBookItem.id }).from(priceBookItem).limit(1);
    if (existing.length > 0) return { seeded: 0 };
    const rows = DEFAULT_PRICE_BOOK.map((d) => ({ ...d, tenantId }));
    const inserted = await tx
      .insert(priceBookItem)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: priceBookItem.id });
    return { seeded: inserted.length };
  });
}
