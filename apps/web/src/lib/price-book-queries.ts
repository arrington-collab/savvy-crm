import "server-only";
import { withTenant, ensurePriceBook, getCurrentPriceBookTx, ensureTierProducts, tierProductsNeedingCosts, deriveCostDriftDiff, tierProduct, priceBookVersion, tenant, desc, eq } from "@savvy/db";
import { parseEstimateConfig } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function listPriceBook() {
  const tenantId = await getTenantId();
  await ensurePriceBook(tenantId); // lazy-seed on first open
  // Current book only — a bare select would mix live originals with version clones.
  const { items } = await withTenant(tenantId, (tx) => getCurrentPriceBookTx(tx));
  return items.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Everything the Library price-book page needs beyond the item list. */
export async function getPriceBookMeta() {
  const tenantId = await getTenantId();
  await ensureTierProducts(tenantId); // lazy-seed for tenants pre-dating the seed

  const [tiers, versions, needsCosts] = await Promise.all([
    withTenant(tenantId, (tx) => tx.select().from(tierProduct).orderBy(tierProduct.tier)),
    withTenant(tenantId, (tx) =>
      tx.select().from(priceBookVersion).orderBy(desc(priceBookVersion.versionNo)).limit(20),
    ),
    tierProductsNeedingCosts(tenantId),
  ]);

  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const floor = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate).marginFloorBps;
  const drift = await deriveCostDriftDiff(tenantId, { defaultMarginFloorBps: floor });

  return { tiers, versions, needsCosts, drift, marginFloorBps: floor };
}
