/**
 * e2e: per-stage document gate (DB-layer, mirrors production-gating.spec.ts test 1).
 *
 * Configures the e2e tenant to require a `contract` document before `production`,
 * proves recordStageChange(->production) throws IncompleteDocumentsError when no
 * contract doc exists, then succeeds once one is seeded. Restores tenant.settings
 * in afterAll so the persisted requiredDocs does not leak into other specs.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb,
  withTenant,
  customer,
  property,
  job,
  document,
  estimate,
  appointment,
  tenant,
  recordStageChange,
  IncompleteDocumentsError,
  eq,
} from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

let priorSettings: unknown;

test.beforeAll(async () => {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  priorSettings = t?.settings ?? {};
  const prior = (priorSettings ?? {}) as Record<string, unknown>;
  const priorProduction = (prior.production ?? {}) as Record<string, unknown>;
  await adminDb.update(tenant)
    .set({ settings: { ...prior, production: { ...priorProduction, requiredDocs: { production: ["contract"] } } } as Record<string, unknown> })
    .where(eq(tenant.id, tenantId));
});

test.afterAll(async () => {
  await adminDb.update(tenant).set({ settings: priorSettings as Record<string, unknown> }).where(eq(tenant.id, tenantId));
});

async function seedApprovedJob(stamp: string): Promise<string> {
  const [c] = await adminDb.insert(customer)
    .values({ tenantId, name: `Doc Dan ${stamp}`, phone: "+15555560002" }).returning();
  const [p] = await adminDb.insert(property)
    .values({ tenantId, customerId: c!.id, address: `${stamp} Doc St` }).returning();
  const [j] = await adminDb.insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved" }).returning();
  return j!.id;
}

async function getJobStage(jobId: string): Promise<string | null> {
  const [row] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  return row?.stage ?? null;
}

test.describe("document gate", () => {
  test("blocks ->production without a contract doc, then allows it after one is seeded", async () => {
    const stamp = Date.now().toString(36);
    const jobId = await seedApprovedJob(stamp);

    // Evidence gate: the job is seeded straight at "approved" and this test
    // moves it forward to "production". That requires a contiguous evidence
    // chain (inspection, estimate, approval, production) — seed all of it up
    // front so the *document-kind* gate (IncompleteDocumentsError) is what
    // actually fires here, matching this test's intent (see production-gating
    // / doc-gating split: this file only exercises the requiredDocs gate).
    await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", r2Key: `e2e/${jobId}/inspection.jpg`,
    });
    await adminDb.insert(estimate).values({
      tenantId, jobId, lineItems: [], status: "accepted",
    });
    await adminDb.insert(appointment).values({
      tenantId, jobId, type: "crew", status: "scheduled",
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      endsAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
    });

    let gateError: unknown;
    try {
      await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" }));
    } catch (e) {
      gateError = e;
    }
    expect(gateError).toBeInstanceOf(IncompleteDocumentsError);
    expect((gateError as IncompleteDocumentsError).missing).toContain("contract");
    expect(await getJobStage(jobId)).toBe("approved");

    await adminDb.insert(document).values({
      tenantId, jobId, kind: "contract", label: "signed",
      r2Key: `e2e/${jobId}/contract.pdf`, filename: "contract.pdf", mime: "application/pdf", source: "docuseal",
    });

    const result = await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" }));
    expect(result).toMatchObject({ activated: expect.any(Number) });
    expect(await getJobStage(jobId)).toBe("production");
  });
});
