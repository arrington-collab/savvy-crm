import { describe, it, expect } from "vitest";
import {
  adminDb, property, user, eq,
  startInspectionForLead, completeInspection, approveInspection, publishInspection,
} from "../src/index.js";
import { getBaselinedProperties, baselineCoverageGaps } from "../src/lifecycle/inspection-baseline.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function seedApprovedInspection() {
  const { tenantId } = await makeTenant();
  const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Ida", email: `i-${crypto.randomUUID()}@t.local`, role: "admin" }).returning();
  const started = await startInspectionForLead({ tenantId, leadId });
  if ("error" in started) throw new Error("start failed");
  await completeInspection({ tenantId, inspectionId: started.inspectionId });
  await approveInspection({ tenantId, inspectionId: started.inspectionId, userId: u!.id });
  return { tenantId, leadId, propertyId, userId: u!.id, inspectionId: started.inspectionId };
}

describe("baseline on first publish", () => {
  it("the FIRST published Record baselines its property; a later one never overwrites", async () => {
    const ctx = await seedApprovedInspection();
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    const [prop] = await adminDb.select().from(property).where(eq(property.id, ctx.propertyId));
    expect(prop!.baselineInspectionId).toBe(ctx.inspectionId);
    expect(prop!.baselineAt).toBeInstanceOf(Date);

    // A second published Record on the same property keeps the ORIGINAL baseline.
    const started2 = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    if ("error" in started2) throw new Error("second start failed");
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: started2.inspectionId });
    await approveInspection({ tenantId: ctx.tenantId, inspectionId: started2.inspectionId, userId: ctx.userId });
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: started2.inspectionId });

    const [after] = await adminDb.select().from(property).where(eq(property.id, ctx.propertyId));
    expect(after!.baselineInspectionId).toBe(ctx.inspectionId);
  });

  it("baseline.coverage: published initial Records with an unbaselined property are the gap set", async () => {
    const ctx = await seedApprovedInspection();
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(await baselineCoverageGaps(ctx.tenantId)).toEqual([]);

    // Simulate a legacy publish that missed the hook.
    await adminDb.update(property).set({ baselineInspectionId: null, baselineAt: null }).where(eq(property.id, ctx.propertyId));
    const gaps = await baselineCoverageGaps(ctx.tenantId);
    expect(gaps).toEqual([{ inspectionId: ctx.inspectionId, propertyId: ctx.propertyId }]);
  });
});

describe("getBaselinedProperties — the storm sentinel interface (wave 2 consumes it)", () => {
  it("returns baselined properties with coordinates; polygon filters by point-in-polygon", async () => {
    const ctx = await seedApprovedInspection();
    await adminDb.update(property).set({ lat: 33.45, lng: -112.07 }).where(eq(property.id, ctx.propertyId));
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    const all = await getBaselinedProperties(ctx.tenantId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ propertyId: ctx.propertyId, lat: 33.45, lng: -112.07, baselineInspectionId: ctx.inspectionId });

    // A polygon around Phoenix catches it; one around Tucson does not.
    const around = [{ lat: 33.3, lng: -112.3 }, { lat: 33.6, lng: -112.3 }, { lat: 33.6, lng: -111.9 }, { lat: 33.3, lng: -111.9 }];
    const far = [{ lat: 32.1, lng: -111.1 }, { lat: 32.3, lng: -111.1 }, { lat: 32.3, lng: -110.8 }, { lat: 32.1, lng: -110.8 }];
    expect(await getBaselinedProperties(ctx.tenantId, around)).toHaveLength(1);
    expect(await getBaselinedProperties(ctx.tenantId, far)).toHaveLength(0);
  });

  it("unbaselined or coordinate-less properties never surface", async () => {
    const ctx = await seedApprovedInspection();
    // Published (→ baselined) but no coordinates.
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(await getBaselinedProperties(ctx.tenantId)).toEqual([]);
  });
});
