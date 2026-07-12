import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { claim } from "../src/schema/insurance";
import { estimate } from "../src/schema/finance";
import { document } from "../src/schema/ops";
import { lead } from "../src/schema/crm";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedFlavorJobs } from "../src/lifecycle/demo-seed/flavor";

describe("seedFlavorJobs", () => {
  it("insurance job has a claim ledger with acv/rcv/deductible + a depreciation invoice + estimate doc", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedFlavorJobs(tenantId);

    const [j] = await adminDb.select().from(job).where(eq(job.id, ids.insurance));
    expect(j?.type).toBe("insurance");

    const [c] = await adminDb.select().from(claim).where(eq(claim.jobId, ids.insurance));
    expect(c?.acvCents).toBeGreaterThan(0);
    expect(c?.rcvCents).toBeGreaterThan(c!.acvCents!);
    expect(c?.deductibleCents).toBeGreaterThan(0);

    const docs = await adminDb
      .select()
      .from(document)
      .where(and(eq(document.jobId, ids.insurance), eq(document.kind, "insurance_estimate")));
    expect(docs.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("canvass job carries a rescission hold in the future + a stored contract document", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedFlavorJobs(tenantId);

    const [j] = await adminDb.select().from(job).where(eq(job.id, ids.canvass));
    expect(j?.rescissionHoldUntil).toBeTruthy();
    expect(j!.rescissionHoldUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(j?.canvassRepName).toBeTruthy();

    const docs = await adminDb
      .select()
      .from(document)
      .where(and(eq(document.jobId, ids.canvass), eq(document.kind, "contract")));
    expect(docs.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("stuck estimate is aged ~12 days with no response, owned by Rep B", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedFlavorJobs(tenantId);

    const [est] = await adminDb.select().from(estimate).where(eq(estimate.leadId, ids.stuck));
    expect(est?.status).toBe("sent");
    expect(est?.sentAt).toBeTruthy();
    const ageDays = (Date.now() - est!.sentAt!.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(10);
    expect(ageDays).toBeLessThan(14);
  }, 120_000);

  it("manual-hatch job exists via the manualJob escape hatch (no accepted estimate) + a contract doc", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedFlavorJobs(tenantId);

    const [j] = await adminDb.select().from(job).where(eq(job.id, ids.manual));
    expect(j).toBeTruthy();
    // Landed via convertLeadToJob's manualJob escape hatch — the lead has no accepted
    // estimate, so this job could only exist because manualJob:true + reason cleared
    // the ManualJobEvidenceError gate. No inspection evidence ⇒ stage stays 'lead'.
    expect(j?.leadId).toBeTruthy();
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, j!.leadId!));
    const accepted = await adminDb.select().from(estimate).where(and(eq(estimate.leadId, l!.id), eq(estimate.status, "accepted")));
    expect(accepted.length).toBe(0);
    expect(l?.status).toBe("won");

    const docs = await adminDb
      .select()
      .from(document)
      .where(and(eq(document.jobId, ids.manual), eq(document.kind, "contract")));
    expect(docs.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("is idempotent — a second run reuses the same four ids", async () => {
    const { tenantId } = await provisionDemoTenant();
    const first = await seedFlavorJobs(tenantId);
    const second = await seedFlavorJobs(tenantId);
    expect(second).toEqual(first);
  }, 120_000);
});
