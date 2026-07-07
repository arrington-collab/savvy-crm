import { withTenant } from "../tenant";
import { appointment } from "../schema/comms";
import { job } from "../schema/jobs";
import { property, lead } from "../schema/crm";
import { estimate } from "../schema/finance";
import { license } from "../schema/compliance";
import { document } from "../schema/ops";
import { eq, and, isNull, inArray, gte, lte, ne } from "drizzle-orm";
import type { AppointmentType, AppointmentStatus } from "@savvy/core";
import { leadToJobType, resolveActiveLicense } from "@savvy/core";
import { seedJobTasks } from "./seed-job-tasks";
import { instantiateJobTasks } from "./job-tasks";
import { recordStageChange } from "./record-stage-change";
import { stopDripEnrollments } from "./stop-drip";

export class SlotTakenError extends Error {
  constructor() { super("slot_taken"); this.name = "SlotTakenError"; }
}
export class NoAssigneeError extends Error {
  constructor() { super("no_assignee"); this.name = "NoAssigneeError"; }
}
export class LicenseRequiredError extends Error {
  constructor(public readonly state: string, public readonly city: string | null) {
    super(`No active license for jurisdiction: ${state}${city ? `/${city}` : ""}`);
    this.name = "LicenseRequiredError";
  }
}

function isExclusionViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23P01";
}

export type BookInput = {
  tenantId: string;
  // Crew/install appointments are job-scoped; lead-stage inspections are lead-scoped
  // (no job yet). Exactly one of jobId/leadId identifies the appointment's subject.
  jobId?: string;
  leadId?: string;
  propertyId?: string; // explicit override; otherwise derived from the job or lead
  customerId?: string;
  type: AppointmentType; assigneeUserId: string | null;
  startsAt: Date; endsAt: Date;
  crewId?: string | null;
};

export async function bookAppointment(input: BookInput): Promise<{ id: string }> {
  const { tenantId } = input;
  if (!input.jobId && !input.leadId) {
    throw new Error("bookAppointment: one of jobId or leadId is required");
  }
  try {
    return await withTenant(tenantId, async (tx) => {
      // Resolve the property this appointment is at — from the job (crew/install)
      // or the lead (inspection). It drives the Cell 17a license check.
      let propertyId = input.propertyId ?? null;
      if (!propertyId && input.jobId) {
        const [jrow] = await tx.select({ propertyId: job.propertyId }).from(job).where(eq(job.id, input.jobId));
        if (!jrow) throw new Error(`bookAppointment: job ${input.jobId} not found`);
        propertyId = jrow.propertyId;
      }
      if (!propertyId && input.leadId) {
        const [lrow] = await tx.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, input.leadId));
        if (!lrow) throw new Error(`bookAppointment: lead ${input.leadId} not found`);
        propertyId = lrow.propertyId;
      }

      // Cell 17a: block scheduling in a jurisdiction with no active license.
      const [prop] = propertyId
        ? await tx.select({ state: property.state, city: property.city }).from(property).where(eq(property.id, propertyId))
        : [undefined];
      const state = (prop?.state ?? "").trim();
      if (state !== "") {
        const lics = await tx
          .select({ state: license.state, city: license.city, status: license.status, expiresAt: license.expiresAt })
          .from(license)
          .where(eq(license.tenantId, tenantId));
        const active = resolveActiveLicense(lics, { state, city: prop?.city ?? null }, new Date());
        if (!active) throw new LicenseRequiredError(state, prop?.city ?? null);
      }

      const [row] = await tx.insert(appointment).values({
        tenantId, jobId: input.jobId ?? null, leadId: input.leadId ?? null, propertyId,
        customerId: input.customerId ?? null,
        type: input.type, assigneeUserId: input.assigneeUserId ?? null,
        startsAt: input.startsAt, endsAt: input.endsAt, status: "scheduled",
        crewId: input.crewId ?? null,
      }).returning({ id: appointment.id });
      return { id: row!.id };
    });
  } catch (e) {
    if (isExclusionViolation(e)) throw new SlotTakenError();
    throw e;
  }
}

export async function rescheduleAppointment(input: {
  tenantId: string; appointmentId: string; startsAt: Date; endsAt: Date; assigneeUserId?: string;
}): Promise<void> {
  try {
    await withTenant(input.tenantId, (tx) => tx.update(appointment).set({
      startsAt: input.startsAt, endsAt: input.endsAt,
      ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
    }).where(and(eq(appointment.id, input.appointmentId), eq(appointment.status, "scheduled"))));
  } catch (e) {
    if (isExclusionViolation(e)) throw new SlotTakenError();
    throw e;
  }
}

export async function reassignAppointment(input: {
  tenantId: string; appointmentId: string; assigneeUserId: string | null;
}): Promise<void> {
  try {
    await withTenant(input.tenantId, (tx) => tx.update(appointment).set({
      assigneeUserId: input.assigneeUserId,
    }).where(and(eq(appointment.id, input.appointmentId), eq(appointment.status, "scheduled"))));
  } catch (e) {
    if (isExclusionViolation(e)) throw new SlotTakenError();
    throw e;
  }
}

export async function cancelAppointment(input: { tenantId: string; appointmentId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(appointment)
    .set({ status: "canceled" })
    .where(eq(appointment.id, input.appointmentId)));
}

export async function setAppointmentStatus(input: {
  tenantId: string; appointmentId: string; status: AppointmentStatus;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(appointment)
    .set({ status: input.status })
    .where(eq(appointment.id, input.appointmentId)));
}

export type BusyInterval = { startsAt: Date; endsAt: Date; lat?: number; lng?: number };

export async function getBusyIntervals(input: {
  tenantId: string; assigneeUserId: string; from: Date; to: Date;
}): Promise<BusyInterval[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx
      .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng })
      .from(appointment)
      .leftJoin(job, eq(appointment.jobId, job.id))
      .leftJoin(property, eq(job.propertyId, property.id))
      .where(and(
        eq(appointment.assigneeUserId, input.assigneeUserId),
        eq(appointment.status, "scheduled"),
      ));
    return rows
      .filter((r) => r.startsAt >= input.from && r.startsAt < input.to)
      .map((r) => ({
        startsAt: r.startsAt, endsAt: r.endsAt,
        lat: r.lat == null ? undefined : Number(r.lat),
        lng: r.lng == null ? undefined : Number(r.lng),
      }));
  });
}

/** Start times of a crew's other scheduled crew appts in [from,to] — excludes `excludeAppointmentId`. */
export async function getCrewBusyStarts(input: {
  tenantId: string; crewId: string; from: Date; to: Date; excludeAppointmentId: string;
}): Promise<Date[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(
        eq(appointment.crewId, input.crewId),
        eq(appointment.type, "crew"),
        eq(appointment.status, "scheduled"),
        gte(appointment.startsAt, input.from),
        lte(appointment.startsAt, input.to),
        ne(appointment.id, input.excludeAppointmentId),
      ));
    return rows.map((r) => r.startsAt);
  });
}

/** Set (note) or clear (note=null) the weather flag on a scheduled appointment. */
export async function setAppointmentWeatherFlag(input: {
  tenantId: string; appointmentId: string; note: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(appointment)
      .set({ weatherNote: input.note, weatherFlaggedAt: input.note ? new Date() : null })
      .where(and(eq(appointment.id, input.appointmentId), eq(appointment.status, "scheduled"))));
}

/**
 * Converts a lead to a job if not already converted (idempotent). Seeds the
 * job's tasks, records the stage change to "inspected", marks the lead booked,
 * and stops any active drip enrollments. Returns the jobId + customerId.
 * Idempotent: a repeat call on an already-booked lead returns the existing job.
 */
export async function convertLeadToJob(args: {
  tenantId: string;
  leadId: string;
  // Escape hatch for jobs that arrive outside the funnel (e.g. insurance
  // emergencies) with no accepted estimate. When false/undefined the red-path
  // invariant applies: a job is created FROM an accepted estimate — not before.
  manualJob?: boolean;
}): Promise<{ jobId: string; customerId: string }> {
  return withTenant(args.tenantId, async (tx) => {
    const [l] = await tx.select().from(lead).where(eq(lead.id, args.leadId));
    if (!l) throw new Error("lead not found");

    // Carry the lead's documents onto the job within the same transaction. Idempotent:
    // only updates docs where jobId IS NULL, so a repeat conversion never re-stamps.
    async function stampCerts(jobId: string): Promise<void> {
      // Storm certs / photos attached before lead_id existed are customer-scoped.
      await tx
        .update(document)
        .set({ jobId })
        .where(
          and(
            eq(document.customerId, l!.customerId!),
            inArray(document.kind, ["cert", "photo"]),
            isNull(document.jobId),
          ),
        );
      // Slice 6a: all lead-scoped documents (insurance estimates, measurement reports, etc.).
      await tx
        .update(document)
        .set({ jobId })
        .where(and(eq(document.leadId, l!.id), isNull(document.jobId)));
    }

    if (l.status === "booked") {
      const [existing] = await tx.select().from(job).where(eq(job.leadId, l.id));
      if (existing) {
        await stampCerts(existing.id);
        return { jobId: existing.id, customerId: l.customerId! };
      }
    }

    // Red-path invariant: a job is created FROM an accepted estimate. Out-of-funnel
    // jobs (insurance emergencies) bypass this via manualJob.
    const [accepted] = await tx
      .select({ id: estimate.id })
      .from(estimate)
      .where(and(eq(estimate.leadId, l.id), eq(estimate.status, "accepted")));
    if (!accepted && !args.manualJob) {
      throw new Error("cannot create job: lead has no accepted estimate (use manualJob for out-of-funnel jobs)");
    }

    const jobType = leadToJobType(l.lane ?? null);
    const [newJob] = await tx.insert(job).values({
      tenantId: args.tenantId, customerId: l.customerId!, propertyId: l.propertyId!,
      type: jobType, stage: "lead", leadId: l.id,
      assignedUserId: l.assignedUserId ?? null, // carry the lead's owner/credit onto the job
    }).returning();
    // Carry the accepted estimate onto the new job (measurement travels via property).
    if (accepted) {
      await tx.update(estimate).set({ jobId: newJob!.id }).where(eq(estimate.id, accepted.id));
    }
    await seedJobTasks(tx as never, { id: newJob!.id, tenantId: args.tenantId, type: jobType });
    await instantiateJobTasks(tx, { tenantId: args.tenantId, jobId: newJob!.id, jobType });
    await recordStageChange(tx, { tenantId: args.tenantId, jobId: newJob!.id, toStage: "inspected", byAgent: "orchestrator" });
    await tx.update(lead).set({ status: "booked" }).where(eq(lead.id, l.id));
    await stopDripEnrollments(tx, { tenantId: args.tenantId, customerId: l.customerId!, reason: "converted" });
    await stampCerts(newJob!.id);
    return { jobId: newJob!.id, customerId: l.customerId! };
  });
}
