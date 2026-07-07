import { describe, it, expect } from "vitest";
import { resolveEstimateDelivery } from "../src/lifecycle/estimate.js";
import { withTenant } from "../src/tenant.js";
import { adminDb, tenant, estimate, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function seedDraft(tenantId: string, leadId: string, propertyId: string, total: number): Promise<string> {
  const [e] = await adminDb
    .insert(estimate)
    .values({ tenantId, leadId, propertyId, source: "roofr", status: "draft", total })
    .returning({ id: estimate.id });
  return e!.id;
}

async function setThreshold(tenantId: string, cents: number | null): Promise<void> {
  await adminDb.update(tenant).set({ settings: { estimate: { approvalThresholdCents: cents } } }).where(eq(tenant.id, tenantId));
}

/** Slice 1: over-threshold drafts park for approval; at/under auto-send. */
describe("resolveEstimateDelivery", () => {
  it("auto-sends when the tenant has no approval threshold", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const estimateId = await seedDraft(tenantId, leadId, propertyId, 5_000_000);
    expect(await resolveEstimateDelivery({ tenantId, estimateId })).toEqual({ action: "send" });
  });

  it("parks and stamps approvalRequiredAt when the total exceeds the threshold", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await setThreshold(tenantId, 1_000_000);
    const estimateId = await seedDraft(tenantId, leadId, propertyId, 1_500_000);

    expect(await resolveEstimateDelivery({ tenantId, estimateId })).toEqual({ action: "park" });
    const [e] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(e!.approvalRequiredAt).not.toBeNull();
  });

  it("auto-sends at/under the threshold", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await setThreshold(tenantId, 1_000_000);
    const estimateId = await seedDraft(tenantId, leadId, propertyId, 800_000);
    expect(await resolveEstimateDelivery({ tenantId, estimateId })).toEqual({ action: "send" });
  });
});
