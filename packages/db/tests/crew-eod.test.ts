import { describe, it, expect } from "vitest";
import { adminDb, customer, property, job, crewCheckin, eq } from "../src/index.js";
import { submitCrewEodReport, eodGaps } from "../src/lifecycle/crew-eod.js";
import { makeTenant } from "./helpers.js";

async function seedJob() {
  const { tenantId } = await makeTenant();
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "EOD Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "3 Wrap Ln" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId, jobId: j!.id };
}

describe("submitCrewEodReport — required to close the crew day", () => {
  it("one report per job-day; a resubmit UPDATES (the crew corrects, never duplicates)", async () => {
    const { tenantId, jobId } = await seedJob();
    const first = await submitCrewEodReport({
      tenantId, jobId, whatGotDone: "Tear-off complete, dry-in started", tomorrowPlan: "Finish dry-in, start install",
    });
    expect(first.created).toBe(true);

    const second = await submitCrewEodReport({
      tenantId, jobId, whatGotDone: "Tear-off complete, dry-in 80%", tomorrowPlan: "Finish dry-in early, install after lunch",
    });
    expect(second.created).toBe(false);
    expect(second.dayKey).toBe(first.dayKey);

    const { crewEodReport } = await import("../src/index.js");
    const rows = await adminDb.select().from(crewEodReport).where(eq(crewEodReport.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.whatGotDone).toContain("80%");
  });

  it("production.eod evidence: a checked-in crew day with no report is the gap set", async () => {
    const { tenantId, jobId } = await seedJob();
    const [u] = await adminDb.insert((await import("../src/index.js")).user).values({
      tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Crew Lead", email: `cl-${crypto.randomUUID()}@t.local`, role: "admin",
    }).returning();
    await adminDb.insert(crewCheckin).values({ tenantId, jobId, crewUserId: u!.id, checkedInAt: new Date() });

    const today = new Date().toISOString().slice(0, 10);
    let gaps = await eodGaps(tenantId, today);
    expect(gaps).toEqual([{ jobId }]);

    await submitCrewEodReport({ tenantId, jobId, whatGotDone: "Day one done" });
    gaps = await eodGaps(tenantId, today);
    expect(gaps).toEqual([]);
  });
});
