import { withTenant } from "../tenant";
import { appointment } from "../schema/comms";
import { job } from "../schema/jobs";
import { property } from "../schema/crm";
import { eq, and } from "drizzle-orm";
import type { AppointmentType, AppointmentStatus } from "@savvy/core";

export class SlotTakenError extends Error {
  constructor() { super("slot_taken"); this.name = "SlotTakenError"; }
}
export class NoAssigneeError extends Error {
  constructor() { super("no_assignee"); this.name = "NoAssigneeError"; }
}

function isExclusionViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23P01";
}

export type BookInput = {
  tenantId: string; jobId: string; customerId?: string;
  type: AppointmentType; assigneeUserId: string;
  startsAt: Date; endsAt: Date;
};

export async function bookAppointment(input: BookInput): Promise<{ id: string }> {
  const { tenantId } = input;
  try {
    return await withTenant(tenantId, async (tx) => {
      const [row] = await tx.insert(appointment).values({
        tenantId, jobId: input.jobId, customerId: input.customerId ?? null,
        type: input.type, assigneeUserId: input.assigneeUserId,
        startsAt: input.startsAt, endsAt: input.endsAt, status: "scheduled",
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

/**
 * Converts a lead to a job if not already converted (idempotent). Returns the
 * jobId + customerId. Real body is implemented in Task 14 (it needs
 * seedJobTasks/recordStageChange). Leave this stub THROWING for now so Task 8
 * stays focused on the appointment helpers.
 */
export async function convertLeadToJob(_args: { tenantId: string; leadId: string }): Promise<{ jobId: string; customerId: string }> {
  throw new Error("implemented in Task 14 refactor");
}
