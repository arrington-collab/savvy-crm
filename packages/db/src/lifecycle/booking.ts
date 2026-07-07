import { adminDb } from "../admin-client";
import { lead, user } from "../schema/index";
import { eq, and, or } from "drizzle-orm";
import { REGISTRY_TASK } from "@savvy/core";
import { bookAppointment, SlotTakenError, NoAssigneeError } from "./appointments";
import { markLeadTaskDone } from "./lead-tasks";

/**
 * Token-less engine booking for the voice agent. Resolves the lead's tenant + assignee
 * and books an inspection appointment against the LEAD — no job is created (slice 1:
 * a job is created FROM an accepted estimate, not at booking). Does NOT emit
 * appointment/booked — the caller (apps/web) owns that (db must not import @savvy/agents).
 */
export async function bookLeadSlot(input: {
  leadId: string;
  startsAt: string;
  endsAt: string;
}): Promise<{ appointmentId: string; leadId: string; tenantId: string } | { error: "no_lead" | "no_assignee" | "slot_taken" }> {
  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId, customerId: lead.customerId })
    .from(lead)
    .where(eq(lead.id, input.leadId));
  if (!l) return { error: "no_lead" };
  const tenantId = l.tenantId;

  let assigneeId = l.assignedUserId ?? undefined;
  if (!assigneeId) {
    const [u] = await adminDb
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.tenantId, tenantId), or(eq(user.role, "owner"), eq(user.role, "rep"))));
    assigneeId = u?.id;
  }
  if (!assigneeId) return { error: "no_assignee" };

  try {
    const appt = await bookAppointment({
      tenantId,
      leadId: input.leadId,
      customerId: l.customerId ?? undefined,
      type: "inspection",
      assigneeUserId: assigneeId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
    });
    // Best-effort proof: booking already committed (separate txs), so a ledger
    // hiccup must not surface as a booking failure.
    await markLeadTaskDone(tenantId, {
      leadId: input.leadId, taskId: REGISTRY_TASK.APPOINTMENT_SCHEDULING,
      owner: "scheduling", evidence: { type: "appointment", ref: appt.id },
    }).catch((err) => console.error("lead_task 25 evidence write failed (booking still succeeded):", err));
    return { appointmentId: appt.id, leadId: input.leadId, tenantId };
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" };
    if (e instanceof NoAssigneeError) return { error: "no_assignee" };
    throw e;
  }
}
