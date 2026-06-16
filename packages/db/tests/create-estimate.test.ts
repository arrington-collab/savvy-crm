import { describe, it, expect } from "vitest";
import { createEstimateFromMeasurement, setEstimateStatus } from "../src/lifecycle/estimate.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { estimate } from "../src/schema/finance.js";
import { measurement } from "../src/schema/ops.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

describe("createEstimateFromMeasurement", () => {
  it("generates a draft estimate from a measurement using the tenant price book", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, propertyId } = await makeJobWithProperty(tenantId);

    // Seed the price book so the engine has items to price
    await ensurePriceBook(tenantId);

    const measurementId = await withTenant(tenantId, async (tx) => {
      const [m] = await tx.insert(measurement).values({
        tenantId,
        propertyId,
        provider: "roofr",
        areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
      }).returning();
      return m!.id;
    });

    const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
    expect(est?.status).toBe("draft");
    expect(est?.source).toBe("roofr");
    expect((est?.total ?? 0)).toBeGreaterThan(0);

    await setEstimateStatus({ tenantId, estimateId: est!.id, status: "accepted" });
    const [after] = await withTenant(tenantId, (tx) =>
      tx.select().from(estimate).where(eq(estimate.id, est!.id)),
    );
    expect(after!.status).toBe("accepted");
    expect(after!.acceptedAt).not.toBeNull();
  });
});
