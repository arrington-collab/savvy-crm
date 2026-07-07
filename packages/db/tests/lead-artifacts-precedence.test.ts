import { describe, it, expect } from "vitest";
import { getLeadArtifacts } from "../src/lifecycle/lead-artifacts.js";
import { withTenant } from "../src/tenant.js";
import { measurement } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("getLeadArtifacts measurement precedence", () => {
  it("returns the uploaded_report over a newer sketch, exposing source", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "diy", source: "sketch", areas: { squares: 5 },
    }));
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr", source: "uploaded_report", areas: { squares: 22 },
    }));

    const arts = await getLeadArtifacts({ tenantId, leadId });
    expect(arts.measurement?.source).toBe("uploaded_report");
    expect(arts.measurement?.squares).toBe(22);
  });
});
