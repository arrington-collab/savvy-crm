import { describe, it, expect } from "vitest";
import { getLeadArtifacts } from "../src/lifecycle/lead-artifacts.js";
import { withTenant } from "../src/tenant.js";
import { adminDb, measurement, estimate } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("getLeadArtifacts", () => {
  it("returns nulls when the lead has no measurement or estimate", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const a = await getLeadArtifacts({ tenantId, leadId });
    expect(a.measurement).toBeNull();
    expect(a.estimate).toBeNull();
  });

  it("returns the property's measurement and the lead's estimate", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.insert(measurement).values({
        tenantId, propertyId, provider: "roofr", pitch: "8/12",
        areas: { squares: 24, predominantPitch: "8/12" },
      }),
    );
    await adminDb.insert(estimate).values({ tenantId, leadId, propertyId, source: "roofr", status: "draft", total: 1_200_000 });

    const a = await getLeadArtifacts({ tenantId, leadId });
    expect(a.measurement).toMatchObject({ provider: "roofr", squares: 24, pitch: "8/12" });
    expect(a.estimate).toMatchObject({ status: "draft", total: 1_200_000, jobId: null });
  });
});
