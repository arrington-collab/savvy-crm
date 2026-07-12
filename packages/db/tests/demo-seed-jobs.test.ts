import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { invoice } from "../src/schema/finance";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedStageJobs } from "../src/lifecycle/demo-seed/jobs";

describe("seedStageJobs", () => {
  it("lands one job at each of approved/production/closeout/billing/complete with real evidence", async () => {
    const { tenantId } = await provisionDemoTenant();
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

  it("is idempotent — a second run reuses the same jobs", async () => {
    const { tenantId } = await provisionDemoTenant();
    const first = await seedStageJobs(tenantId);
    const second = await seedStageJobs(tenantId);
    expect(second).toEqual(first);
  }, 120_000);
});
