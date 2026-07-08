import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, lead, job, jobChecklistItem, jobStageEvent, auditLog } from "../schema/index.js";
import { document } from "../schema/ops.js";
import { convertLeadToJob } from "./appointments.js";

let tId: string, custId: string, propId: string, leadId: string, docId: string;

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "CertCarry", publicKey: "certcarry", clerkOrgId: "org_certcarry" })
    .returning();
  tId = t!.id;

  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId: tId, name: "Storm Owner", email: "storm@x.com" })
    .returning();
  custId = c!.id;

  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: tId, customerId: custId, address: "99 Hail St" })
    .returning();
  propId = p!.id;

  const [l] = await adminDb
    .insert(lead)
    .values({ tenantId: tId, customerId: custId, propertyId: propId, status: "new" })
    .returning();
  leadId = l!.id;

  // Seed a cert document with no jobId (pre-conversion state)
  const [d] = await adminDb
    .insert(document)
    .values({ tenantId: tId, customerId: custId, kind: "cert", filename: "storm.pdf" })
    .returning();
  docId = d!.id;
});

afterAll(async () => {
  await adminDb.delete(document).where(eq(document.tenantId, tId));
  // convertLeadToJob seeds job_task rows and (via recordStageChange) writes a
  // job_stage_event + an audit_log row; delete those children before their
  // parents (job / tenant) to satisfy FK constraints.
  await adminDb.delete(jobChecklistItem).where(eq(jobChecklistItem.tenantId, tId));
  await adminDb.delete(jobStageEvent).where(eq(jobStageEvent.tenantId, tId));
  await adminDb.delete(auditLog).where(eq(auditLog.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("convertLeadToJob — cert carryover", () => {
  it("stamps jobId onto cert documents at conversion", async () => {
    const { jobId } = await convertLeadToJob({ tenantId: tId, leadId, manualJob: true });

    const [d] = await adminDb
      .select()
      .from(document)
      .where(eq(document.id, docId));

    expect(d!.jobId).toBe(jobId);
  });

  it("is idempotent — repeat call does not error and cert keeps the same jobId", async () => {
    // Lead is now 'won' with a job, so convertLeadToJob returns the existing job
    const { jobId } = await convertLeadToJob({ tenantId: tId, leadId, manualJob: true });

    const [d] = await adminDb
      .select()
      .from(document)
      .where(eq(document.id, docId));

    expect(d!.jobId).toBe(jobId);
    // Ensure there is still exactly one cert doc (no duplicates)
    const all = await adminDb
      .select()
      .from(document)
      .where(eq(document.customerId, custId));
    const certs = all.filter((row) => row.kind === "cert");
    expect(certs.length).toBe(1);
  });
});
