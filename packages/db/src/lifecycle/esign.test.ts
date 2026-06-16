import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, esignRequest } from "../schema/index.js";
import { markEsignBySubmission } from "./esign.js";

let tId: string, custId: string, propId: string, jobId: string;

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "ES", publicKey: "es", clerkOrgId: "org_es" })
    .returning();
  tId = t!.id;
  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId: tId, name: "Pat", email: "pat@x.com" })
    .returning();
  custId = c!.id;
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: tId, customerId: custId, address: "1 Main St" })
    .returning();
  propId = p!.id;
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId: tId, customerId: custId, propertyId: propId })
    .returning();
  jobId = j!.id;
});

afterAll(async () => {
  await adminDb.delete(esignRequest).where(eq(esignRequest.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("markEsignBySubmission", () => {
  it("flips a sent request to completed + sets completedAt; idempotent on replay", async () => {
    await adminDb.insert(esignRequest).values({
      tenantId: tId,
      jobId,
      customerId: custId,
      docType: "cert",
      templateId: "tpl",
      docusealSubmissionId: "sub_1",
      status: "sent",
    });

    const first = await markEsignBySubmission({ submissionId: "sub_1", status: "completed" });
    expect(first?.changed).toBe(true);
    expect(first?.tenantId).toBe(tId);

    const [row] = await adminDb
      .select()
      .from(esignRequest)
      .where(eq(esignRequest.docusealSubmissionId, "sub_1"));
    expect(row!.status).toBe("completed");
    expect(row!.completedAt).not.toBeNull();

    const second = await markEsignBySubmission({ submissionId: "sub_1", status: "completed" });
    expect(second?.changed).toBe(false); // already completed → no-op
  });

  it("returns null for an unknown submission", async () => {
    const r = await markEsignBySubmission({ submissionId: "does_not_exist", status: "completed" });
    expect(r).toBeNull();
  });
});
