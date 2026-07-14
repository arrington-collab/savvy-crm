import { describe, it, expect } from "vitest";
import { adminDb, customer, property, job, document, productionPhase, productionMedia, eq, and, isNull } from "../src/index.js";
import {
  ensureProductionPhaseTemplates,
  instantiateProductionPhases,
  ingestProductionMedia,
  reopenPhaseForQcFailure,
  listTriageMedia,
  getPhaseProgressForJob,
} from "../src/lifecycle/production-phase.js";
import { makeTenant } from "./helpers.js";

async function seedJob(jobType: "retail" | "insurance" | "repair" = "retail") {
  const { tenantId } = await makeTenant();
  await ensureProductionPhaseTemplates(tenantId);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Prod Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Pulse Pl" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: jobType, stage: "production" }).returning();
  return { tenantId, jobId: j!.id };
}

async function seedPhoto(tenantId: string, jobId: string) {
  const [d] = await adminDb.insert(document).values({
    tenantId, jobId, kind: "photo", source: "sitesnap", sitesnapPhotoId: `ss-${crypto.randomUUID()}`, qcStatus: "passed",
  }).returning();
  return d!.id;
}

describe("instantiateProductionPhases", () => {
  it("instantiates the job type's template phases in order, exactly once", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    const first = await instantiateProductionPhases({ tenantId, jobId });
    expect("created" in first && first.created).toBe(3); // repair template: staged, repair_work, cleanup

    const again = await instantiateProductionPhases({ tenantId, jobId });
    expect(again).toEqual({ created: 0, skipped: "already_instantiated" });

    const rows = await adminDb.select().from(productionPhase).where(eq(productionPhase.jobId, jobId));
    expect(rows.map((r) => r.phaseKey).sort()).toEqual(["cleanup", "repair_work", "staged_materials"]);
    expect(rows.every((r) => r.status === "pending" && r.templateVersionRef)).toBe(true);
  });
});

describe("ingestProductionMedia — evidence advances phases, buttons don't exist", () => {
  it("first photo for a phase flips pending → in_progress and stamps startedAt once", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    await instantiateProductionPhases({ tenantId, jobId });
    const doc = await seedPhoto(tenantId, jobId);

    const res = await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: doc, shot: "before" });
    expect("phaseId" in res && res.phaseStatus === "in_progress").toBe(true);

    const [phase] = await adminDb.select().from(productionPhase)
      .where(and(eq(productionPhase.jobId, jobId), eq(productionPhase.phaseKey, "repair_work")));
    expect(phase!.status).toBe("in_progress");
    expect(phase!.startedAt).toBeInstanceOf(Date);
  });

  it("completes the phase when the template's evidence is satisfied (count + required shots)", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    await instantiateProductionPhases({ tenantId, jobId });
    // repair_work: minPhotos 3, requiredShots [before, after]
    await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: await seedPhoto(tenantId, jobId), shot: "before" });
    await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: await seedPhoto(tenantId, jobId), shot: null });
    const third = await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: await seedPhoto(tenantId, jobId), shot: "after" });
    expect("phaseId" in third && third.phaseStatus === "done" && third.justCompleted).toBe(true);

    const [phase] = await adminDb.select().from(productionPhase)
      .where(and(eq(productionPhase.jobId, jobId), eq(productionPhase.phaseKey, "repair_work")));
    expect(phase!.status).toBe("done");
    expect(phase!.completedAt).toBeInstanceOf(Date);
    expect(phase!.evidencePhotoIds).toHaveLength(3);
  });

  it("replayed media events are no-ops (one row, no double-count)", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    await instantiateProductionPhases({ tenantId, jobId });
    const doc = await seedPhoto(tenantId, jobId);
    const input = { tenantId, jobId, phaseKey: "repair_work", documentId: doc, shot: "before" as const };
    await ingestProductionMedia(input);
    await ingestProductionMedia(input);
    const media = await adminDb.select().from(productionMedia).where(eq(productionMedia.jobId, jobId));
    expect(media).toHaveLength(1);
  });

  it("RED PATH: unknown phase context is HELD for triage, never dropped", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    await instantiateProductionPhases({ tenantId, jobId });
    const doc = await seedPhoto(tenantId, jobId);

    const res = await ingestProductionMedia({ tenantId, jobId, phaseKey: "not_a_phase", documentId: doc });
    expect(res).toEqual({ triaged: true, documentId: doc });

    const triage = await listTriageMedia(tenantId);
    expect(triage).toHaveLength(1);
    expect(triage[0]).toMatchObject({ jobId, documentId: doc, phaseKeyRaw: "not_a_phase" });

    const held = await adminDb.select().from(productionMedia)
      .where(and(eq(productionMedia.jobId, jobId), isNull(productionMedia.productionPhaseId)));
    expect(held).toHaveLength(1);
  });
});

describe("QC failure on completion evidence reopens the phase", () => {
  it("a flagged evidence photo flips done → in_progress and reports the punch context", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    await instantiateProductionPhases({ tenantId, jobId });
    const docs = [await seedPhoto(tenantId, jobId), await seedPhoto(tenantId, jobId), await seedPhoto(tenantId, jobId)];
    await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: docs[0]!, shot: "before" });
    await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: docs[1]!, shot: null });
    await ingestProductionMedia({ tenantId, jobId, phaseKey: "repair_work", documentId: docs[2]!, shot: "after" });

    await adminDb.update(document).set({ qcStatus: "flagged" }).where(eq(document.id, docs[2]!));
    const res = await reopenPhaseForQcFailure({ tenantId, documentId: docs[2]! });
    expect("reopened" in res && res.reopened).toBe(true);
    expect((res as { phaseKey: string }).phaseKey).toBe("repair_work");

    const [phase] = await adminDb.select().from(productionPhase)
      .where(and(eq(productionPhase.jobId, jobId), eq(productionPhase.phaseKey, "repair_work")));
    expect(phase!.status).toBe("in_progress");

    // A photo that is not completion evidence reopens nothing.
    const stray = await seedPhoto(tenantId, jobId);
    expect(await reopenPhaseForQcFailure({ tenantId, documentId: stray })).toEqual({ reopened: false });
  });
});

describe("getPhaseProgressForJob — the job-card line", () => {
  it("reports done/total and the current phase's pace", async () => {
    const { tenantId, jobId } = await seedJob("repair");
    await instantiateProductionPhases({ tenantId, jobId });
    await ingestProductionMedia({ tenantId, jobId, phaseKey: "staged_materials", documentId: await seedPhoto(tenantId, jobId) });

    const progress = await getPhaseProgressForJob({ tenantId, jobId });
    expect(progress!.total).toBe(3);
    expect(progress!.done).toBe(1); // staged_materials: minPhotos 1 → done on first photo
    expect(progress!.current).toBeNull(); // nothing in_progress yet
  });
});
