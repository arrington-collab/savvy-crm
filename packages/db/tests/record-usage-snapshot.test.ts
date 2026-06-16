import { describe, it, expect } from "vitest";
import { recordUsageSnapshot } from "../src/lifecycle/usage.js";
import { withTenant } from "../src/tenant.js";
import { usageSnapshot } from "../src/schema/billing.js";
import { tenant } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";
import { makeTenant } from "./helpers.js";

describe("recordUsageSnapshot", () => {
  it("computes + upserts a snapshot idempotently", async () => {
    const { tenantId } = await makeTenant();
    await adminDb.update(tenant).set({ revenueBand: "starter" }).where(eq(tenant.id, tenantId));
    const a = await recordUsageSnapshot(tenantId, "2026-06");
    expect(a.bandKey).toBe("starter");
    expect(a.basePriceCents).toBe(49900);
    const b = await recordUsageSnapshot(tenantId, "2026-06"); // re-run updates in place
    expect(b.totalCents).toBe(a.totalCents);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(usageSnapshot).where(eq(usageSnapshot.periodKey, "2026-06")));
    expect(rows).toHaveLength(1);
  });
});
