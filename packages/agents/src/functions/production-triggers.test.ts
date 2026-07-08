import { describe, it, expect } from "vitest";
import { withTenant, adminDb, tenant, customer, property, job, appointment, document, estimate, eq } from "@savvy/db";
import { type JobStage } from "@savvy/core";
import { syncCrewCheckInStage, syncMaterialDeliveredStage, syncCompletionPhotosStage } from "./production-triggers";

async function seedJobAt(stage: JobStage, type: "retail" | "insurance" = "retail") {
  const [t] = await adminDb.insert(tenant).values({ name: "prod-trig", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
  const tid = t!.id;
  const jid = await withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type, stage }).returning({ id: job.id });
    return j!.id;
  });
  return { tid, jid };
}

async function stageOf(jobId: string): Promise<string> {
  const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  return j!.stage;
}

async function addScheduledCrewAppt(tid: string, jid: string) {
  await withTenant(tid, (tx) =>
    tx.insert(appointment).values({
      tenantId: tid, jobId: jid, type: "crew", status: "scheduled",
      startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 2 * 86_400_000),
    }),
  );
}

async function addPhoto(tid: string, jid: string, label: string) {
  await withTenant(tid, (tx) =>
    tx.insert(document).values({ tenantId: tid, jobId: jid, kind: "photo", label }),
  );
}

/** Evidence gate: seeds inspection + estimate + approval evidence for a job already at `approved`. */
async function seedThroughApproved(tid: string, jid: string) {
  await addPhoto(tid, jid, "inspection");
  await withTenant(tid, (tx) => tx.insert(estimate).values({ tenantId: tid, jobId: jid, status: "accepted", lineItems: [] }));
}

/** Evidence gate: seeds inspection + estimate + approval + production evidence for a job at `production`. */
async function seedThroughProduction(tid: string, jid: string) {
  await seedThroughApproved(tid, jid);
  await addScheduledCrewAppt(tid, jid);
}

describe("syncCrewCheckInStage — GPS check-in → production", () => {
  it("advances an approved job to production", async () => {
    const { tid, jid } = await seedJobAt("approved");
    await seedThroughProduction(tid, jid); // crew must be scheduled for a GPS check-in to occur
    const r = await syncCrewCheckInStage(tid, jid);
    expect(r).toMatchObject({ toStage: "production" });
    expect(await stageOf(jid)).toBe("production");
  });

  it("is forward-only: does not pull a billing job back to production", async () => {
    const { tid, jid } = await seedJobAt("billing");
    const r = await syncCrewCheckInStage(tid, jid);
    expect(r).toMatchObject({ skipped: "not_forward" });
    expect(await stageOf(jid)).toBe("billing");
  });
});

describe("syncMaterialDeliveredStage — delivery + crew assigned → production", () => {
  it("advances to production when a crew install is scheduled", async () => {
    const { tid, jid } = await seedJobAt("approved");
    await seedThroughApproved(tid, jid);
    await addScheduledCrewAppt(tid, jid);
    const r = await syncMaterialDeliveredStage(tid, jid);
    expect(r).toMatchObject({ toStage: "production" });
    expect(await stageOf(jid)).toBe("production");
  });

  it("skips when no crew install is scheduled (delivery alone is not 'ready')", async () => {
    const { tid, jid } = await seedJobAt("approved");
    const r = await syncMaterialDeliveredStage(tid, jid);
    expect(r).toMatchObject({ skipped: "no_crew_install" });
    expect(await stageOf(jid)).toBe("approved");
  });
});

describe("syncCompletionPhotosStage — required photos satisfied → closeout", () => {
  it("advances production → closeout once all required photos are present", async () => {
    const { tid, jid } = await seedJobAt("production");
    await seedThroughProduction(tid, jid);
    await addPhoto(tid, jid, "before");
    await addPhoto(tid, jid, "after");
    const r = await syncCompletionPhotosStage(tid, jid);
    expect(r).toMatchObject({ toStage: "closeout" });
    expect(await stageOf(jid)).toBe("closeout");
  });

  it("skips when a required photo is still missing", async () => {
    const { tid, jid } = await seedJobAt("production");
    await addPhoto(tid, jid, "before");
    const r = await syncCompletionPhotosStage(tid, jid);
    expect(r).toMatchObject({ skipped: "photos_incomplete" });
    expect(await stageOf(jid)).toBe("production");
  });
});
