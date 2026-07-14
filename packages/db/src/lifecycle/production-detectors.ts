// Production Pulse slice 3: the exception-only office. The office hears
// NOTHING about normal production — these detectors emit the only cards:
// pace lag, silence, late crew, blockers, municipal gates. Everything here is
// a pure read (the queue derives on view; the hourly sweep is the heartbeat).

import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import {
  job, appointment, crewCheckin, productionPhase, productionMedia,
  productionBlocker, municipalInspection,
} from "../schema/index";
import { PHASE_PACE_LAG_FACTOR } from "@savvy/core";

/** In-progress phases running past expected × factor (default 1.5×). */
export async function paceLagPhases(
  tenantId: string,
  now: Date,
  factor = PHASE_PACE_LAG_FACTOR,
): Promise<{ jobId: string; phaseKey: string; label: string; elapsedHours: number; expectedHours: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(productionPhase)
      .where(and(eq(productionPhase.status, "in_progress"), sql`${productionPhase.startedAt} is not null`));
    return rows
      .map((r) => ({
        jobId: r.jobId,
        phaseKey: r.phaseKey,
        label: r.label,
        elapsedHours: (now.getTime() - r.startedAt!.getTime()) / 3600_000,
        expectedHours: r.expectedDurationHours,
      }))
      .filter((r) => r.elapsedHours > r.expectedHours * factor);
  });
}

/** Crews checked in with NO evidence (photos) for N hours mid-job — silence. */
export async function silentCrewDays(
  tenantId: string,
  now: Date,
  quietHoursThreshold = 3,
): Promise<{ jobId: string; crewId: string | null; hoursQuiet: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const dayStart = new Date(now.getTime() - 18 * 3600_000);
    const checkins = await tx.select({
      jobId: crewCheckin.jobId, crewId: crewCheckin.crewId, checkedInAt: crewCheckin.checkedInAt,
    }).from(crewCheckin)
      .where(and(gte(crewCheckin.checkedInAt, dayStart), isNull(crewCheckin.checkedOutAt)));

    const out: { jobId: string; crewId: string | null; hoursQuiet: number }[] = [];
    for (const c of checkins) {
      const [lastMedia] = await tx.select({ createdAt: productionMedia.createdAt }).from(productionMedia)
        .where(eq(productionMedia.jobId, c.jobId))
        .orderBy(sql`${productionMedia.createdAt} desc`)
        .limit(1);
      const lastSignal = lastMedia?.createdAt ?? c.checkedInAt;
      const hoursQuiet = (now.getTime() - lastSignal.getTime()) / 3600_000;
      if (hoursQuiet >= quietHoursThreshold) out.push({ jobId: c.jobId, crewId: c.crewId, hoursQuiet });
    }
    return out;
  });
}

/** Scheduled crew appointments past start + grace with NO check-in — late crew. */
export async function lateCrewAppointments(
  tenantId: string,
  now: Date,
  graceMinutes = 60,
): Promise<{ appointmentId: string; jobId: string; startsAt: Date }[]> {
  return withTenant(tenantId, async (tx) => {
    const cutoff = new Date(now.getTime() - graceMinutes * 60_000);
    const rows = await tx.select({ id: appointment.id, jobId: appointment.jobId, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(
        eq(appointment.type, "crew"),
        eq(appointment.status, "scheduled"),
        lt(appointment.startsAt, cutoff),
        gte(appointment.endsAt, now), // still today's window, not history
        sql`not exists (
          select 1 from ${crewCheckin} ci
          where ci.job_id = ${appointment.jobId}
            and ci.checked_in_at >= ${appointment.startsAt}::timestamptz - interval '4 hours'
        )`,
      ));
    return rows.filter((r): r is typeof r & { jobId: string } => r.jobId != null)
      .map((r) => ({ appointmentId: r.id, jobId: r.jobId, startsAt: r.startsAt }));
  });
}

export type ReportBlockerResult = { blockerId: string } | { error: "job_not_found" };

/** Crew flags a blocker — an IMMEDIATE card. hidden_damage is change-order bait. */
export async function reportProductionBlocker(input: {
  tenantId: string;
  jobId: string;
  kind: string;
  phaseKey?: string | null;
  note?: string | null;
  photoIds?: string[];
  reportedByName?: string | null;
}): Promise<ReportBlockerResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, input.jobId));
    if (!j) return { error: "job_not_found" as const };
    const [row] = await tx.insert(productionBlocker).values({
      tenantId: input.tenantId,
      jobId: input.jobId,
      kind: input.kind,
      phaseKey: input.phaseKey ?? null,
      note: input.note ?? null,
      photoIds: input.photoIds ?? [],
      reportedByName: input.reportedByName ?? null,
    }).returning({ id: productionBlocker.id });
    return { blockerId: row!.id };
  });
}

export async function listOpenBlockers(tenantId: string): Promise<(typeof productionBlocker.$inferSelect)[]> {
  return withTenant(tenantId, (tx) => tx.select().from(productionBlocker)
    .where(eq(productionBlocker.status, "open")));
}

export async function resolveProductionBlocker(input: {
  tenantId: string;
  blockerId: string;
  changeOrderId?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(productionBlocker)
    .set({ status: "resolved", resolvedAt: new Date(), ...(input.changeOrderId ? { changeOrderId: input.changeOrderId } : {}) })
    .where(eq(productionBlocker.id, input.blockerId)));
}

/** Attach the drafted change-order stub to its blocker (hidden-damage path). */
export async function attachBlockerChangeOrder(input: {
  tenantId: string;
  blockerId: string;
  changeOrderId: string;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(productionBlocker)
    .set({ changeOrderId: input.changeOrderId })
    .where(eq(productionBlocker.id, input.blockerId)));
}

/** Record the city's verdict; a PASSED record opens the gated phase. */
export async function recordMunicipalInspection(input: {
  tenantId: string;
  jobId: string;
  inspectionKey: string;
  status: "pending" | "passed" | "failed";
  note?: string | null;
}): Promise<{ recorded: true }> {
  await withTenant(input.tenantId, async (tx) => {
    await tx.insert(municipalInspection).values({
      tenantId: input.tenantId,
      jobId: input.jobId,
      inspectionKey: input.inspectionKey,
      status: input.status,
      recordedAt: new Date(),
      note: input.note ?? null,
    }).onConflictDoUpdate({
      target: [municipalInspection.jobId, municipalInspection.inspectionKey],
      set: { status: input.status, recordedAt: new Date(), note: input.note ?? null },
    });
  });
  return { recorded: true };
}

/** The INVARIANT: no gated phase runs without its passed record. Must be empty. */
export async function inspectionGateViolations(tenantId: string): Promise<{ jobId: string; phaseKey: string; requiredInspectionKey: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      jobId: productionPhase.jobId,
      phaseKey: productionPhase.phaseKey,
      requiredInspectionKey: sql<string>`${productionPhase.requiredInspectionKey}`,
    }).from(productionPhase)
      .where(and(
        inArray(productionPhase.status, ["in_progress", "done", "verified"]),
        sql`${productionPhase.requiredInspectionKey} is not null`,
        sql`not exists (
          select 1 from ${municipalInspection} mi
          where mi.job_id = ${productionPhase.jobId}
            and mi.inspection_key = ${productionPhase.requiredInspectionKey}
            and mi.status = 'passed'
        )`,
      )),
  );
}

/** production.phase_evidence: done phases carrying no evidence. Must be empty. */
export async function phaseEvidenceGaps(tenantId: string): Promise<{ jobId: string; phaseKey: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ jobId: productionPhase.jobId, phaseKey: productionPhase.phaseKey })
      .from(productionPhase)
      .where(and(
        inArray(productionPhase.status, ["done", "verified"]),
        sql`jsonb_array_length(${productionPhase.evidencePhotoIds}) = 0`,
      )),
  );
}

/** The gate CARD (distinct from the violation invariant): gated phases still
 *  pending on in-production jobs, waiting for the city. */
export async function waitingInspectionGates(tenantId: string): Promise<{ jobId: string; phaseKey: string; requiredInspectionKey: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      jobId: productionPhase.jobId,
      phaseKey: productionPhase.phaseKey,
      requiredInspectionKey: sql<string>`${productionPhase.requiredInspectionKey}`,
    }).from(productionPhase)
      .innerJoin(job, eq(productionPhase.jobId, job.id))
      .where(and(
        eq(productionPhase.status, "pending"),
        eq(job.stage, "production"),
        sql`${productionPhase.requiredInspectionKey} is not null`,
        sql`not exists (
          select 1 from ${municipalInspection} mi
          where mi.job_id = ${productionPhase.jobId}
            and mi.inspection_key = ${productionPhase.requiredInspectionKey}
            and mi.status = 'passed'
        )`,
      )),
  );
}
