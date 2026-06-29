import "server-only";
import { withTenant, job, customer, property, appointment, crewCheckin, user, eq, and, or, inArray, isNull, isNotNull, desc, listCrewIdsForUser } from "@savvy/db";
import type { CrewSession } from "./crew-session";

const ACTIVE_STAGES = ["approved", "production", "closeout"] as const;

export type CrewJobRow = { id: string; stage: string; customerName: string | null; address: string | null };

/** Jobs this crew member is assigned to (directly or via a crew appointment), in active stages. */
export async function listCrewJobs(s: CrewSession): Promise<CrewJobRow[]> {
  return withTenant(s.tenantId, async (tx) => {
    // Crew appointments assigned directly to this user (legacy: assigneeUserId set)
    const userApptJobIds = tx
      .select({ jobId: appointment.jobId })
      .from(appointment)
      .where(and(eq(appointment.assigneeUserId, s.crewUserId), eq(appointment.type, "crew")));

    // Crew appointments assigned to a crew entity the user belongs to
    const myCrewIds = await listCrewIdsForUser(tx, s.tenantId, s.crewUserId);

    // Build crew-entity appointment subquery only when the user is in at least one crew
    // (drizzle's inArray throws on an empty array — guard it explicitly)
    const crewEntityApptJobIds = myCrewIds.length > 0
      ? tx
          .select({ jobId: appointment.jobId })
          .from(appointment)
          .where(and(eq(appointment.type, "crew"), isNotNull(appointment.crewId), inArray(appointment.crewId, myCrewIds)))
      : null;

    return tx
      .select({ id: job.id, stage: job.stage, customerName: customer.name, address: property.address })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(and(
        inArray(job.stage, [...ACTIVE_STAGES]),
        crewEntityApptJobIds != null
          ? or(eq(job.assignedUserId, s.crewUserId), inArray(job.id, userApptJobIds), inArray(job.id, crewEntityApptJobIds))
          : or(eq(job.assignedUserId, s.crewUserId), inArray(job.id, userApptJobIds)),
      ))
      .orderBy(desc(job.stageEnteredAt));
  });
}

/** True if the job is in this crew member's assigned set (authorization guard). */
export async function crewCanAccessJob(s: CrewSession, jobId: string): Promise<boolean> {
  const jobs = await listCrewJobs(s);
  return jobs.some((j) => j.id === jobId);
}

export type CrewJobDetail = {
  id: string; stage: string; customerName: string | null; address: string | null;
  openCheckinAt: Date | null;
};

/** Crew check-in history for a job (admin view, not scoped to a single crew member). */
export async function getJobCheckins(
  tenantId: string,
  jobId: string,
): Promise<{ id: string; crewName: string | null; checkedInAt: Date; checkedOutAt: Date | null }[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: crewCheckin.id,
        crewName: user.name,
        checkedInAt: crewCheckin.checkedInAt,
        checkedOutAt: crewCheckin.checkedOutAt,
      })
      .from(crewCheckin)
      .leftJoin(user, eq(user.id, crewCheckin.crewUserId))
      .where(eq(crewCheckin.jobId, jobId))
      .orderBy(desc(crewCheckin.checkedInAt))
      .limit(20),
  );
}

export async function getCrewJob(s: CrewSession, jobId: string): Promise<CrewJobDetail | null> {
  if (!(await crewCanAccessJob(s, jobId))) return null;
  return withTenant(s.tenantId, async (tx) => {
    const [j] = await tx
      .select({ id: job.id, stage: job.stage, customerName: customer.name, address: property.address })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, jobId))
      .limit(1);
    if (!j) return null;
    const [open] = await tx
      .select({ at: crewCheckin.checkedInAt })
      .from(crewCheckin)
      .where(and(eq(crewCheckin.jobId, jobId), eq(crewCheckin.crewUserId, s.crewUserId), isNull(crewCheckin.checkedOutAt)))
      .orderBy(desc(crewCheckin.checkedInAt))
      .limit(1);
    return { ...j, openCheckinAt: open?.at ?? null };
  });
}
