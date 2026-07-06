import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { customer, property } from "../schema/crm";
import { job } from "../schema/jobs";
import { setJobFinancingStatus } from "./financing";

let tId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "FIN", publicKey: `fin-${Math.random()}`, clerkOrgId: `org_fin_${Math.random()}` }).returning();
  tId = t!.id;
});
afterAll(async () => {
  await adminPool.end();
});

async function makeJob(): Promise<string> {
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Fin Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: `fin-${Math.random()}` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id, type: "retail" }).returning();
  return j!.id;
}

describe("setJobFinancingStatus", () => {
  it("defaults to 'none' and advances via a provider status update (with ref, no credit data)", async () => {
    const jobId = await makeJob();
    const [before] = await adminDb.select({ s: job.financingStatus }).from(job).where(eq(job.id, jobId));
    expect(before!.s).toBe("none");

    await setJobFinancingStatus({ tenantId: tId, jobId, status: "applied", externalRef: "app_123" });
    const [after] = await adminDb.select({ s: job.financingStatus, ref: job.financingRef }).from(job).where(eq(job.id, jobId));
    expect(after!.s).toBe("applied");
    expect(after!.ref).toBe("app_123");
  });
});
