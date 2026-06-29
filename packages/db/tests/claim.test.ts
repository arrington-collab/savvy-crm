import { describe, it, expect } from "vitest";
import { upsertClaim, getClaimForJob } from "../src/lifecycle/claim.js";
import { withTenant } from "../src/tenant.js";
import { claim } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

describe("claim lifecycle", () => {
  it("upserts (create then update) one claim per job", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const c1 = await upsertClaim({ tenantId, jobId, claimNumber: "CLM-1", status: "filed", acvCents: 100000 });
    expect(c1.claimNumber).toBe("CLM-1");
    const c2 = await upsertClaim({ tenantId, jobId, status: "approved", rcvCents: 250000 });
    expect(c2.id).toBe(c1.id); // same row (one per job)
    expect(c2.status).toBe("approved");
    expect(c2.rcvCents).toBe(250000);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(claim).where(eq(claim.jobId, jobId)));
    expect(rows).toHaveLength(1);
    const got = await getClaimForJob(tenantId, jobId);
    expect(got?.id).toBe(c1.id);
  });

  it("getClaimForJob returns null when none", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    expect(await getClaimForJob(tenantId, jobId)).toBeNull();
  });

  it("is tenant-isolated (RLS): another tenant cannot read it", async () => {
    const { tenantId: a } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(a);
    await upsertClaim({ tenantId: a, jobId, claimNumber: "CLM-A" });
    const { tenantId: b } = await makeTenant();
    const seenFromB = await withTenant(b, (tx) => tx.select().from(claim).where(eq(claim.jobId, jobId)));
    expect(seenFromB).toHaveLength(0);
  });
});
