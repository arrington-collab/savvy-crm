import { describe, it, expect } from "vitest";
import { draftLeadEstimateIfReady } from "../src/lifecycle/estimate.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { adminDb, appointment, measurement, estimate, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("estimate cites its measurement source", () => {
  it("stamps measurement_source from the priced measurement at draft time", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await adminDb.insert(appointment).values({
      tenantId, leadId, propertyId, type: "inspection", status: "done",
      startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000),
    });
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr", source: "uploaded_report",
      areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
    }));

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect("estimateId" in res).toBe(true);
    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    expect(e!.measurementSource).toBe("uploaded_report");
  });
});
