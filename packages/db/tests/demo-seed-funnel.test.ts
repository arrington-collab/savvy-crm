import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedApprovedJob, demoStaff } from "../src/lifecycle/demo-seed/funnel";

describe("funnel: lead → approved job through the gates", () => {
  it("produces a job whose stage is at least 'approved' with real evidence", async () => {
    const { tenantId } = await provisionDemoTenant();
    const repId = await demoStaff(tenantId, "usr_demo_repA");
    const { jobId } = await seedApprovedJob(tenantId, {
      name: "Approved Homeowner",
      phone: "+16025550201",
      email: "approved@demo.test",
      address: "101 W Camelback Rd, Phoenix, AZ 85013",
      assigneeUserId: repId,
    });
    const [j] = await adminDb.select().from(job).where(eq(job.id, jobId));
    // 'approved' or beyond — assert the funnel didn't leave it stuck at lead/inspected/estimate.
    expect(["approved", "production", "closeout", "billing", "complete"]).toContain(j!.stage);
  });
});
