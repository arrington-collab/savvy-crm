import { adminDb } from "../admin-client";
import { lead, user } from "../schema/index";
import { eq, and, or } from "drizzle-orm";
import { convertLeadToJob, bookAppointment, SlotTakenError, NoAssigneeError } from "./appointments";

/**
 * Token-less engine booking for the voice agent. Resolves the lead's tenant + assignee,
 * converts the lead to a job, and books an inspection appointment. Does NOT emit
 * appointment/booked — the caller (apps/web) owns that (db must not import @savvy/agents).
 */
export async function bookLeadSlot(input: {
  leadId: string;
  startsAt: string;
  endsAt: string;
  tenantId?: string;
}): Promise<{ appointmentId: string; jobId: string; tenantId: string } | { error: "no_lead" | "no_assignee" | "slot_taken" }> {
  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId })
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
    const conv = await convertLeadToJob({ tenantId, leadId: input.leadId });
    const appt = await bookAppointment({
      tenantId,
      jobId: conv.jobId,
      customerId: conv.customerId,
      type: "inspection",
      assigneeUserId: assigneeId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
    });
    return { appointmentId: appt.id, jobId: conv.jobId, tenantId };
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" };
    if (e instanceof NoAssigneeError) return { error: "no_assignee" };
    throw e;
  }
}
