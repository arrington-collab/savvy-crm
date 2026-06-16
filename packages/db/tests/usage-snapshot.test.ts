import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { usageSnapshot } from "../src/schema/billing.js";
import { makeTenant } from "./helpers.js";

describe("usage_snapshot", () => {
  it("inserts + reads tenant-scoped", async () => {
    const { tenantId } = await makeTenant();
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.insert(usageSnapshot).values({
        tenantId, periodKey: "2026-06", jobsProcessed: 10, aiSpendCents: 100,
        aiVoiceMinutes: 5, storageBytes: 123, bandKey: "starter",
        basePriceCents: 49900, overageCents: 0, totalCents: 49900,
      }).returning();
      return r;
    });
    expect(row!.totalCents).toBe(49900);
  });
});
