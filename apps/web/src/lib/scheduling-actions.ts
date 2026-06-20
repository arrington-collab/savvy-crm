"use server";
import { revalidatePath } from "next/cache";
import {
  rescheduleAppointment, cancelAppointment, setAppointmentStatus, SlotTakenError, reassignAppointment,
  bookAppointment, withTenant, job, eq,
} from "@savvy/db";
import type { AppointmentType } from "@savvy/core";
import { searchSchedulableJobs, type SchedulableJob } from "./schedule-create-queries";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

export type { SchedulableJob };

export async function searchJobsAction(q: string): Promise<SchedulableJob[]> {
  return searchSchedulableJobs(q);
}

async function emit(
  name: "appointment/changed",
  data: { appointmentId: string; tenantId: string; reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show" },
) {
  try { await inngest.send({ name, data }); } catch (e) { console.error("inngest.send failed", e); }
}

export async function rescheduleAction(
  appointmentId: string,
  startsAt: string,
  endsAt: string,
): Promise<{ ok: true } | { error: "slot_taken" }> {
  const tenantId = await getTenantId();
  try {
    await rescheduleAppointment({ tenantId, appointmentId, startsAt: new Date(startsAt), endsAt: new Date(endsAt) });
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  await emit("appointment/changed", { appointmentId, tenantId, reason: "rescheduled" });
  revalidatePath("/schedule");
  return { ok: true as const };
}

export async function cancelAction(appointmentId: string): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await cancelAppointment({ tenantId, appointmentId });
  await emit("appointment/changed", { appointmentId, tenantId, reason: "canceled" });
  revalidatePath("/schedule");
  return { ok: true as const };
}

export async function markStatusAction(
  appointmentId: string,
  status: "done" | "no_show",
): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await setAppointmentStatus({ tenantId, appointmentId, status });
  await emit("appointment/changed", { appointmentId, tenantId, reason: status });
  revalidatePath("/schedule");
  return { ok: true as const };
}

export async function reassignAction(
  appointmentId: string,
  assigneeUserId: string | null,
): Promise<{ ok: true } | { error: "slot_taken" }> {
  const tenantId = await getTenantId();
  try {
    await reassignAppointment({ tenantId, appointmentId, assigneeUserId });
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  await emit("appointment/changed", { appointmentId, tenantId, reason: "reassigned" });
  revalidatePath("/schedule");
  return { ok: true as const };
}

export async function createAppointmentAction(input: {
  jobId: string;
  type: AppointmentType;
  assigneeUserId: string | null;
  startsAt: string;
  endsAt: string;
}): Promise<{ ok: true } | { error: "slot_taken" }> {
  const tenantId = await getTenantId();
  // Resolve the customer from the job (tenant-scoped) so reminders can look up phone/email.
  const customerId = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    return j?.customerId;
  });
  let appointmentId: string;
  try {
    const created = await bookAppointment({
      tenantId, jobId: input.jobId, customerId,
      type: input.type, assigneeUserId: input.assigneeUserId,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt),
    });
    appointmentId = created.id;
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  try { await inngest.send({ name: "appointment/booked", data: { appointmentId, tenantId } }); }
  catch (e) { console.error("inngest.send failed", e); }
  revalidatePath("/schedule");
  return { ok: true as const };
}
