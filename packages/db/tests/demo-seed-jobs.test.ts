import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { invoice } from "../src/schema/finance";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedStageJobs } from "../src/lifecycle/demo-seed/jobs";

// Hermetic isolation: each run provisions its OWN demo tenant (unique clerkOrgId) so the
// stage assertions can't be polluted by — or pollute — the shared singleton or other
// worktrees sharing this local Postgres. Stable within a run, unique across runs.
const SUFFIX = `jobs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe("seedStageJobs", () => {
  it("lands one job at each of approved/production/closeout/billing/complete with real evidence", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: SUFFIX });
    const ids = await seedStageJobs(tenantId);

    const jobIds = [ids.approved, ids.production, ids.closeout, ids.billing, ids.complete];
    const rows = await adminDb.select().from(job).where(inArray(job.id, jobIds));
    const stage = new Map(rows.map((r) => [r.id, r.stage]));

    expect(stage.get(ids.approved)).toBe("approved");
    expect(stage.get(ids.production)).toBe("production");
    expect(stage.get(ids.closeout)).toBe("closeout");
    expect(stage.get(ids.billing)).toBe("billing");
    expect(stage.get(ids.complete)).toBe("complete");

    // The billing job carries a separate ~50-day-old OVERDUE receivable.
    const overdue = await adminDb
      .select({ id: invoice.id })
      .from(invoice)
      .where(and(eq(invoice.jobId, ids.billing), eq(invoice.status, "overdue")));
    expect(overdue.length).toBe(1);
  }, 120_000);

  it("lands the inspected + estimate jobs at exactly those stages, and they stay put on re-run", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: `${SUFFIX}-early` });

    const first = await seedStageJobs(tenantId);

    const stageOf = async (id: string) => {
      const [r] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, id));
      return r?.stage;
    };

    // Both early-funnel jobs derive their stage from real evidence (done inspection ± a
    // drafted-but-unaccepted estimate) — never a forced stage. Assert they land precisely.
    expect(await stageOf(first.inspected)).toBe("inspected");
    expect(await stageOf(first.estimate)).toBe("estimate");

    // Idempotency: a second run reuses the SAME jobs and neither drifts off its stage.
    const second = await seedStageJobs(tenantId);
    expect(second.inspected).toBe(first.inspected);
    expect(second.estimate).toBe(first.estimate);
    expect(await stageOf(first.inspected)).toBe("inspected");
    expect(await stageOf(first.estimate)).toBe("estimate");
  }, 120_000);

  it("is idempotent — a second run reuses the same jobs", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: SUFFIX });
    const first = await seedStageJobs(tenantId);
    const second = await seedStageJobs(tenantId);
    expect(second).toEqual(first);
  }, 120_000);

  // Guardrail (would have caught the approved→production drift): on ONE isolated tenant,
  // run the seeder TWICE and assert every stage is UNCHANGED after the second run and no
  // job / invoice rows were duplicated. The approved job (PENDING draft materials, not
  // production evidence) must stay 'approved' across re-runs.
  it("re-running seedStageJobs leaves every stage unchanged and duplicates nothing", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: `${SUFFIX}-idem` });

    const first = await seedStageJobs(tenantId);
    const jobIds = [first.approved, first.production, first.closeout, first.billing, first.complete];

    const stagesAfter = async () => {
      const rows = await adminDb.select({ id: job.id, stage: job.stage }).from(job).where(inArray(job.id, jobIds));
      return new Map(rows.map((r) => [r.id, r.stage]));
    };
    const invoiceCount = async () =>
      (await adminDb.select({ id: invoice.id }).from(invoice).where(inArray(invoice.jobId, jobIds))).length;

    const stagesFirst = await stagesAfter();
    const invoicesFirst = await invoiceCount();
    // Sanity: the first run itself lands the expected ladder (incl. approved staying approved).
    expect(stagesFirst.get(first.approved)).toBe("approved");
    expect(stagesFirst.get(first.production)).toBe("production");
    expect(stagesFirst.get(first.complete)).toBe("complete");

    const second = await seedStageJobs(tenantId);
    // Same job ids returned (no new leads/jobs minted).
    expect(second).toEqual(first);
    // Every stage identical after the second run — nothing drifted (approved!→production).
    const stagesSecond = await stagesAfter();
    for (const id of jobIds) expect(stagesSecond.get(id)).toBe(stagesFirst.get(id));
    // No invoice/payment rows duplicated.
    expect(await invoiceCount()).toBe(invoicesFirst);
  }, 120_000);
});
