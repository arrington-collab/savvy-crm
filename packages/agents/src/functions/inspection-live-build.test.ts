import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, lead, measurement, estimate, agentRun, eq, and, withTenant, startInspectionForLead, ensurePriceBook } from "@savvy/db";
import { inspectionMediaHandler } from "./inspection-live-build.js";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "LiveBuild", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Live Build Ln" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();
  await ensurePriceBook(tenantId);
  await withTenant(tenantId, (tx) => tx.insert(measurement).values({
    tenantId, propertyId: p!.id, provider: "roofr",
    areas: { squares: 22, predominantPitch: "6/12", eaveLf: 110, rakeLf: 55 },
  }));
  return { tenantId, leadId: l!.id };
}

describe("inspectionMediaHandler", () => {
  it("refreshes the lead's pre-draft and records an agent_run attributed to the lead", async () => {
    const { tenantId, leadId } = await seed();
    const started = await startInspectionForLead({ tenantId, leadId });

    const res = await inspectionMediaHandler({
      tenantId, inspectionId: (started as { inspectionId: string }).inspectionId, leadId,
    });
    expect("estimateId" in res).toBe(true);

    const [est] = await adminDb.select().from(estimate).where(eq(estimate.leadId, leadId));
    expect(est!.status).toBe("draft");

    const runs = await adminDb.select().from(agentRun)
      .where(and(eq(agentRun.tenantId, tenantId), eq(agentRun.leadId, leadId)));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]!.status).toBe("ok");
  });

  it("skips job-scoped inspections (no lead) without recording a run", async () => {
    const { tenantId } = await seed();
    const res = await inspectionMediaHandler({ tenantId, inspectionId: crypto.randomUUID(), leadId: null });
    expect(res).toEqual({ skipped: "no_lead" });
  });
});
