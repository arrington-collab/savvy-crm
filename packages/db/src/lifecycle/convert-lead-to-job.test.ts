import { describe, it, expect } from "vitest";
import { withTenant } from "../tenant.js";
import { adminDb, tenant, customer, property, lead, job, jobChecklistItem, estimate, eq, and } from "../index.js";
import { convertLeadToJob } from "./appointments.js";
import { ManualJobEvidenceError, document as documentTbl } from "../index.js";

async function mkTenant(name: string) {
  const [t] = await adminDb.insert(tenant).values({ name, publicKey: `k-${name}-${Date.now()}`, clerkOrgId: `o-${name}-${Date.now()}` }).returning();
  return t!.id;
}
async function mkLead(tenantId: string, lane: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Caller", phone: `+1602555${Math.floor(1000 + Math.random() * 8999)}` }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main St" }).returning({ id: property.id });
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test", lane }).returning({ id: lead.id });
    return l!.id;
  });
}

describe("convertLeadToJob job.type carryover", () => {
  it("opens an insurance job for a storm-lane lead and seeds insurance tasks", async () => {
    const tid = await mkTenant("ctj-storm");
    const leadId = await mkLead(tid, "storm");
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "test: out-of-funnel" });
    const [j] = await adminDb.select({ type: job.type }).from(job).where(eq(job.id, jobId));
    expect(j!.type).toBe("insurance");
    const tasks = await adminDb.select({ id: jobChecklistItem.id }).from(jobChecklistItem).where(and(eq(jobChecklistItem.tenantId, tid), eq(jobChecklistItem.jobId, jobId)));
    expect(tasks.length).toBeGreaterThan(0); // insurance templates seeded
  });
  it("opens a retail job for a standard-lane lead", async () => {
    const tid = await mkTenant("ctj-std");
    const leadId = await mkLead(tid, "standard");
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "test: out-of-funnel" });
    const [j] = await adminDb.select({ type: job.type }).from(job).where(eq(job.id, jobId));
    expect(j!.type).toBe("retail");
  });
});

describe("convertLeadToJob marks the lead won", () => {
  it("sets lead.status='won' on the manualJob (out-of-funnel) path", async () => {
    const tid = await mkTenant("ctj-won-manual");
    const leadId = await mkLead(tid, "storm");
    await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "test: out-of-funnel" });
    const [l] = await adminDb.select({ status: lead.status }).from(lead).where(eq(lead.id, leadId));
    expect(l!.status).toBe("won");
  });

  it("sets lead.status='won' on the accepted-estimate path", async () => {
    const tid = await mkTenant("ctj-won-accepted");
    const leadId = await mkLead(tid, "standard");
    // An accepted estimate is the funnel precondition for conversion.
    await withTenant(tid, async (tx) => {
      const [l] = await tx.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, leadId));
      await tx.insert(estimate).values({ tenantId: tid, leadId, propertyId: l!.propertyId, status: "accepted" });
    });
    await convertLeadToJob({ tenantId: tid, leadId });
    const [l] = await adminDb.select({ status: lead.status }).from(lead).where(eq(lead.id, leadId));
    expect(l!.status).toBe("won");
  });

  it("is idempotent: a second convert returns the same job and keeps status won", async () => {
    const tid = await mkTenant("ctj-won-idem");
    const leadId = await mkLead(tid, "storm");
    const first = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "test: out-of-funnel" });
    const second = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "test: out-of-funnel" });
    expect(second.jobId).toBe(first.jobId);
    const jobs = await adminDb.select({ id: job.id }).from(job).where(eq(job.leadId, leadId));
    expect(jobs.length).toBe(1);
    const [l] = await adminDb.select({ status: lead.status }).from(lead).where(eq(lead.id, leadId));
    expect(l!.status).toBe("won");
  });
});

describe("convertLeadToJob lands at the evidence-derived stage", () => {
  it("does NOT jump to inspected without evidence — a bare manual job lands at lead", async () => {
    const tid = await mkTenant("ctj-derive-lead");
    const leadId = await mkLead(tid, "standard");
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId, manualJob: true, reason: "insurance emergency" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
    expect(j!.stage).toBe("lead");
  });

  it("manualJob without a contract doc AND without a reason is rejected", async () => {
    const tid = await mkTenant("ctj-manual-guard");
    const leadId = await mkLead(tid, "standard");
    await expect(convertLeadToJob({ tenantId: tid, leadId, manualJob: true })).rejects.toBeInstanceOf(ManualJobEvidenceError);
  });

  it("a funnel job (accepted estimate + inspection) lands at approved, not inspected", async () => {
    const tid = await mkTenant("ctj-derive-approved");
    const leadId = await mkLead(tid, "standard");
    // inspection evidence (photo) + accepted estimate on the lead
    const [l] = await adminDb.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, leadId));
    await adminDb.insert(documentTbl).values({ tenantId: tid, leadId, propertyId: l!.propertyId, kind: "photo", r2Key: "k" });
    await adminDb.insert(estimate).values({ tenantId: tid, leadId, propertyId: l!.propertyId, status: "accepted", lineItems: [] });
    const { jobId } = await convertLeadToJob({ tenantId: tid, leadId });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
    expect(j!.stage).toBe("approved");
  });
});
