import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, lead, leadTask, convertLeadToJob, ConversionBlockedError, eq, and } from "../src";

async function seedLeadWith(taskId: number) {
  const [t] = await adminDb.insert(tenant).values({ name: "cv", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
  const tid = t!.id;
  const lid = await withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [l] = await tx.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test" }).returning({ id: lead.id });
    await tx.insert(leadTask).values({ tenantId: tid, leadId: l!.id, taskId, status: "pending" });
    return l!.id;
  });
  return { tid, lid };
}

describe("convertLeadToJob resolution gate", () => {
  it("rejects conversion with an open MANUAL lead task and no resolution", async () => {
    const { tid, lid } = await seedLeadWith(43); // 43 = Homeowner inspection walkthrough, Manual
    await expect(
      convertLeadToJob({ tenantId: tid, leadId: lid, manualJob: true, reason: "test", trigger: "test" }),
    ).rejects.toBeInstanceOf(ConversionBlockedError);
  });

  it("auto-resolves an open AUTO/ASSISTED lead task and converts", async () => {
    const { tid, lid } = await seedLeadWith(19); // 19 = Lead qualification scoring, Full Auto
    await convertLeadToJob({ tenantId: tid, leadId: lid, manualJob: true, reason: "test", trigger: "test" });
    const [lt] = await adminDb
      .select({ status: leadTask.status, note: leadTask.note })
      .from(leadTask)
      .where(and(eq(leadTask.leadId, lid), eq(leadTask.taskId, 19)));
    expect(lt?.status).toBe("not_applicable");
    expect(lt?.note).toContain("auto: converted");
  });
});
