import "server-only";
import { withTenant, usageSnapshot, tenant, eq, desc } from "@savvy/db";
import { computeTenantUsage } from "@savvy/db";
import { getBand, computeBill } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function getCurrentBilling() {
  const tenantId = await getTenantId();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const usage = await computeTenantUsage(tenantId, start, end);
  const [t] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenant).where(eq(tenant.id, tenantId)),
  );
  const band = getBand(t?.revenueBand ?? null);
  return { usage, band, bill: computeBill(usage, band) };
}

export async function listUsageSnapshots() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(usageSnapshot).orderBy(desc(usageSnapshot.periodKey)),
  );
}
