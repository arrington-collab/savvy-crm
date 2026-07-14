import { describe, it, expect } from "vitest";
import {
  adminDb, customer, property, job, document, appointment, crewCheckin, crew, user,
  productionPhase, eq, sql,
} from "../src/index.js";
import {
  ensureProductionPhaseTemplates, instantiateProductionPhases, ingestProductionMedia,
} from "../src/lifecycle/production-phase.js";
import {
  paceLagPhases, silentCrewDays, lateCrewAppointments,
  reportProductionBlocker, listOpenBlockers, resolveProductionBlocker,
  recordMunicipalInspection, inspectionGateViolations, phaseEvidenceGaps,
} from "../src/lifecycle/production-detectors.js";
import { makeTenant } from "./helpers.js";

async function seedProductionJob() {
  const { tenantId } = await makeTenant();
  await ensureProductionPhaseTemplates(tenantId);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Det Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "4 Detector Dr" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "repair", stage: "production" }).returning();
  await instantiateProductionPhases({ tenantId, jobId: j!.id });
  const [cr] = await adminDb.insert(crew).values({ tenantId, name: "Crew A" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Lead", email: `l-${crypto.randomUUID()}@t.local`, role: "admin" }).returning();
  return { tenantId, jobId: j!.id, crewId: cr!.id, userId: u!.id };
}

async function seedPhoto(tenantId: string, jobId: string) {
  const [d] = await adminDb.insert(document).values({
    tenantId, jobId, kind: "photo", source: "sitesnap", sitesnapPhotoId: `ss-${crypto.randomUUID()}`, qcStatus: "passed",
  }).returning();
  return d!.id;
}

describe("pace lag — running long is the office's business, normal pace is not", () => {
  it("flags in_progress phases past expected × factor; on-pace phases stay silent", async () => {
    const ctx = await seedProductionJob();
    await ingestProductionMedia({ tenantId: ctx.tenantId, jobId: ctx.jobId, phaseKey: "repair_work", documentId: await seedPhoto(ctx.tenantId, ctx.jobId), shot: "before" });
    // repair_work expected 3h; backdate start 5h (> 3 × 1.5 = 4.5h).
    await adminDb.update(productionPhase).set({ startedAt: sql`now() - interval '5 hours'` })
      .where(eq(productionPhase.jobId, ctx.jobId));

    const lagging = await paceLagPhases(ctx.tenantId, new Date());
    expect(lagging).toHaveLength(1);
    expect(lagging[0]).toMatchObject({ jobId: ctx.jobId, phaseKey: "repair_work" });
    expect(lagging[0]!.elapsedHours).toBeGreaterThan(4.5);
  });
});

describe("silence + late crew — the two flavors of nothing happening", () => {
  it("a checked-in crew with no evidence for N hours is SILENT; fresh evidence clears it", async () => {
    const ctx = await seedProductionJob();
    await adminDb.insert(crewCheckin).values({ tenantId: ctx.tenantId, jobId: ctx.jobId, crewId: ctx.crewId, crewUserId: ctx.userId, checkedInAt: sql`now() - interval '5 hours'` as never });

    let silent = await silentCrewDays(ctx.tenantId, new Date(), 3);
    expect(silent).toEqual([{ jobId: ctx.jobId, crewId: ctx.crewId, hoursQuiet: expect.any(Number) }]);

    await ingestProductionMedia({ tenantId: ctx.tenantId, jobId: ctx.jobId, phaseKey: "repair_work", documentId: await seedPhoto(ctx.tenantId, ctx.jobId) });
    silent = await silentCrewDays(ctx.tenantId, new Date(), 3);
    expect(silent).toEqual([]);
  });

  it("a scheduled crew appointment past its start with NO check-in is a late-crew card", async () => {
    const ctx = await seedProductionJob();
    await adminDb.insert(appointment).values({
      tenantId: ctx.tenantId, jobId: ctx.jobId, type: "crew", status: "scheduled", crewId: ctx.crewId,
      startsAt: sql`now() - interval '90 minutes'` as never, endsAt: sql`now() + interval '6 hours'` as never,
    });
    const late = await lateCrewAppointments(ctx.tenantId, new Date(), 60);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ jobId: ctx.jobId });

    await adminDb.insert(crewCheckin).values({ tenantId: ctx.tenantId, jobId: ctx.jobId, crewId: ctx.crewId, crewUserId: ctx.userId, checkedInAt: new Date() });
    expect(await lateCrewAppointments(ctx.tenantId, new Date(), 60)).toEqual([]);
  });
});

describe("blockers — immediate cards; hidden damage carries its photos toward a change order", () => {
  it("reports land open with photos; resolve closes; the open list feeds the queue", async () => {
    const ctx = await seedProductionJob();
    const photo = await seedPhoto(ctx.tenantId, ctx.jobId);
    const res = await reportProductionBlocker({
      tenantId: ctx.tenantId, jobId: ctx.jobId, phaseKey: "tear_off",
      kind: "hidden_damage", note: "Deck rot across the north corner", photoIds: [photo], reportedByName: "Luis",
    });
    expect("blockerId" in res).toBe(true);

    const open = await listOpenBlockers(ctx.tenantId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "hidden_damage", note: "Deck rot across the north corner" });

    await resolveProductionBlocker({ tenantId: ctx.tenantId, blockerId: (res as { blockerId: string }).blockerId });
    expect(await listOpenBlockers(ctx.tenantId)).toEqual([]);
  });
});

describe("municipal inspection gate — no gated phase starts without its passed record", () => {
  it("blocks the gated phase until the inspection passes, then capture flows", async () => {
    const ctx = await seedProductionJob();
    // Gate repair_work behind a 'pre_work' municipal inspection via template override on the phase row.
    await adminDb.update(productionPhase).set({ requiredInspectionKey: "pre_work" })
      .where(eq(productionPhase.jobId, ctx.jobId));

    const doc = await seedPhoto(ctx.tenantId, ctx.jobId);
    const gated = await ingestProductionMedia({ tenantId: ctx.tenantId, jobId: ctx.jobId, phaseKey: "repair_work", documentId: doc });
    expect(gated).toMatchObject({ gated: true, requiredInspectionKey: "pre_work" });

    const violations = await inspectionGateViolations(ctx.tenantId);
    expect(violations).toEqual([]); // blocked ≠ violated — the gate held

    await recordMunicipalInspection({ tenantId: ctx.tenantId, jobId: ctx.jobId, inspectionKey: "pre_work", status: "passed" });
    const doc2 = await seedPhoto(ctx.tenantId, ctx.jobId);
    const flowing = await ingestProductionMedia({ tenantId: ctx.tenantId, jobId: ctx.jobId, phaseKey: "repair_work", documentId: doc2 });
    expect("phaseId" in flowing && flowing.phaseStatus === "in_progress").toBe(true);
  });
});

describe("production.phase_evidence — done phases must carry their evidence", () => {
  it("a done phase with an empty evidence set is the gap", async () => {
    const ctx = await seedProductionJob();
    await adminDb.update(productionPhase).set({ status: "done", evidencePhotoIds: [] })
      .where(eq(productionPhase.jobId, ctx.jobId));
    const gaps = await phaseEvidenceGaps(ctx.tenantId);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toMatchObject({ jobId: ctx.jobId });
  });
});
