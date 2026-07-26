"use server";
import { revalidatePath } from "next/cache";
import {
  rescheduleAppointment, cancelAppointment, setAppointmentStatus, SlotTakenError, reassignAppointment,
  bookAppointment, withTenant, job, eq, DrizzleOrchestratorStore,
} from "@savvy/db";
import type { AppointmentType } from "@savvy/core";
import { searchSchedulableJobs, type SchedulableJob } from "./schedule-create-queries";
import { inngest } from "@savvy/agents";
import { publishDomainEvent, makeEvent } from "@savvy/orchestrator";
import { getTenantId } from "./tenant";

// Slice B bridge: fail-soft, direct publish (these are server actions, not
// Inngest steps — no step.run seam here). appointment.set/no_show are only
// exercised end-to-end by the B10 integration test since these actions have
// no injectable store seam of their own.
async function bridgeAppointmentSet(a: {
  tenantId: string; appointmentId: string; jobId?: string; leadId?: string; scheduledAt: string;
}): Promise<void> {
  try {
    const store = new DrizzleOrchestratorStore();
    await publishDomainEvent(store, makeEvent({
      type: "appointment.set", source: "savvy", tenantId: a.tenantId,
      correlationId: a.appointmentId, idempotencyKey: `appointment.set:${a.appointmentId}`,
      payload: { appointmentId: a.appointmentId, jobId: a.jobId, leadId: a.leadId, scheduledAt: a.scheduledAt },
    }));
  } catch (e) { console.error("bridge-appointment-set: failed to publish appointment.set", e); }
}

async function bridgeAppointmentNoShow(a: { tenantId: string; appointmentId: string; jobId?: string }): Promise<void> {
  try {
    const store = new DrizzleOrchestratorStore();
    await publishDomainEvent(store, makeEvent({
      type: "appointment.no_show", source: "savvy", tenantId: a.tenantId,
      correlationId: a.appointmentId, idempotencyKey: `appointment.no_show:${a.appointmentId}`,
      payload: { appointmentId: a.appointmentId, jobId: a.jobId },
    }));
  } catch (e) { console.error("bridge-appointment-no-show: failed to publish appointment.no_show", e); }
}

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
  // A completed inspection (with a landed measurement) triggers the lead's draft
  // estimate; the handler no-ops for non-inspection / job-scoped appointments.
  if (status === "done") {
    try { await inngest.send({ name: "appointment/completed", data: { appointmentId, tenantId } }); }
    catch (e) { console.error("inngest.send failed", e); }
  }
  if (status === "no_show") {
    await bridgeAppointmentNoShow({ tenantId, appointmentId });
  }
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
  crewId?: string | null;
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
      crewId: input.crewId ?? null,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt),
    });
    appointmentId = created.id;
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  try { await inngest.send({ name: "appointment/booked", data: { appointmentId, tenantId } }); }
  catch (e) { console.error("inngest.send failed", e); }
  await bridgeAppointmentSet({ tenantId, appointmentId, jobId: input.jobId, scheduledAt: input.startsAt });
  revalidatePath("/schedule");
  return { ok: true as const };
}
