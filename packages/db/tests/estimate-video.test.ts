import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { customer, property, lead } from "../src/schema/crm.js";
import { user } from "../src/schema/tenancy.js";
import { measurement } from "../src/schema/ops.js";
import { tierProduct } from "../src/schema/pricing.js";
import { estimate } from "../src/schema/finance.js";
import { withTenant } from "../src/tenant.js";
import { ensureTenantForOrg } from "../src/lifecycle/provisioning.js";
import { ensurePriceBook, ensureTierProducts } from "../src/lifecycle/price-book.js";
import { createEstimateFromMeasurement, setEstimateStatus } from "../src/lifecycle/estimate.js";
import { recordEstimateEvent } from "../src/lifecycle/estimate-telemetry.js";
import { attachEstimateVideo, videoBatchQueue, ownerVideoDeliveryQueue } from "../src/lifecycle/estimate-video.js";

let tenantId: string;
let estimateId: string;

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_vid_${Date.now()}`, name: "Video Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) => tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }));
  const ids = await withTenant(tenantId, async (tx) => {
    const [rep] = await tx.insert(user).values({ tenantId, name: "Seth", email: `seth-${Date.now()}@e2e.test`, role: "rep" }).returning();
    const [c] = await tx.insert(customer).values({ tenantId, name: "Siobhan Nguyen", phone: "+16025550999" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "5 Vid Way", city: "Mesa" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified", assignedUserId: rep!.id }).returning();
    const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  await recordEstimateEvent({ tenantId, estimateId, kind: "question", sessionId: "s", meta: { question: "Does it include the ridge vent?" } });
});

describe("videoBatchQueue", () => {
  it("queues yesterday's sent estimate with the zero-lookup bundle (name hint, rep, city, price, live concern)", async () => {
    const q = await videoBatchQueue(tenantId);
    const entry = q.find((e) => e.estimateId === estimateId);
    expect(entry).toBeDefined();
    expect(entry!.item.headline).toBe("Siobhan Nguyen — Mesa");
    expect(entry!.item.phoneticNeeded).toBe(true);
    expect(entry!.item.repLine).toContain("Seth");
    expect(entry!.item.nugget).toContain("ridge vent");
  });

  it("drops off the queue once an owner take exists", async () => {
    await attachEstimateVideo({ tenantId, estimateId, role: "owner", documentId: crypto.randomUUID(), approved: false });
    const q = await videoBatchQueue(tenantId);
    expect(q.find((e) => e.estimateId === estimateId)).toBeUndefined();
  });
});

describe("ownerVideoDeliveryQueue", () => {
  it("unapproved takes never send — generic covers; without a generic, nothing sends", async () => {
    // move the estimate into the day-after window
    await withTenant(tenantId, (tx) =>
      tx.update(estimate).set({ sentAt: new Date(Date.now() - 26 * 3_600_000) }).where(eq(estimate.id, estimateId)),
    );
    const none = await ownerVideoDeliveryQueue(tenantId, null);
    expect(none.find((e) => e.estimateId === estimateId)).toBeUndefined();

    const withGeneric = await ownerVideoDeliveryQueue(tenantId, "generic-doc-id");
    const entry = withGeneric.find((e) => e.estimateId === estimateId);
    expect(entry).toMatchObject({ personalized: false, documentId: "generic-doc-id", customerPhone: "+16025550999" });
  });
});
