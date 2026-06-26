"use server";
import { recommendAssignee, repsAvailableAt, listAssignableReps, setLeadOwner, bookLeadSlot, markLeadContacted, withTenant } from "@savvy/db";
import { leadIntakeObject, z } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";
import { createLeadForTenant } from "./intake";
import { slotsForRep } from "./recommended-slots";

export async function listReps(): Promise<{ id: string; name: string }[]> {
  return listAssignableReps(await getTenantId());
}

export async function previewAssignee(geo: { zip?: string; city?: string; state?: string }): Promise<{ repId: string | null }> {
  const repId = await recommendAssignee(await getTenantId(), geo);
  return { repId };
}

export async function previewSlots(input: { repId: string; clusterAround?: { lat: number; lng: number } | null }): Promise<{ slots: { startsAt: string; endsAt: string; label: string }[] }> {
  const { slots } = await slotsForRep({ tenantId: await getTenantId(), repId: input.repId, todayFirst: true, limit: 2, clusterAround: input.clusterAround ?? null });
  return { slots: slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, label: s.label })) };
}

export async function whoIsFree(input: { startsAt: string }): Promise<{ reps: { id: string; name: string }[] }> {
  const tenantId = await getTenantId();
  const freeIds = await repsAvailableAt(tenantId, { startsAt: new Date(input.startsAt), type: "inspection" });
  const all = await listAssignableReps(tenantId);
  const set = new Set(freeIds);
  return { reps: all.filter((r) => set.has(r.id)) };
}

const confirmSchema = z.object({
  contact: z.object({ name: z.string().min(1), phone: z.string().optional(), email: z.string().optional() }),
  address: z.object({
    address: z.string().min(3), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(),
    county: z.string().optional(), line1: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(),
  }),
  repId: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
});

export async function confirmIntakeBooking(input: unknown): Promise<{ ok: true; leadId: string; appointmentId: string; jobId: string } | { error: "slot_taken" | "no_assignee" | "invalid" }> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const { contact, address, repId, startsAt, endsAt } = parsed.data;
  const tenantId = await getTenantId();

  // 1. Create/dedupe customer+property+lead (source inbound-call → rep-alert skips). Emits lead/created.
  const intake = leadIntakeObject.safeParse({
    name: contact.name, phone: contact.phone || undefined, email: contact.email || undefined,
    address: address.address, source: "inbound-call",
    city: address.city, state: address.state, zip: address.zip, county: address.county, line1: address.line1,
    lat: address.lat, lng: address.lng,
  });
  if (!intake.success) return { error: "invalid" };
  const leadId = await createLeadForTenant(tenantId, intake.data);

  // 2. Assign the chosen rep + mark contacted (the human IS the first touch → cancels speed-to-lead).
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: repId });
    await markLeadContacted(tx, { tenantId, leadId });
  });
  await inngest.send({ name: "lead/contacted", data: { tenantId, leadId } });

  // 3. Book the slot atomically (exclusion constraint guards double-booking).
  const booked = await bookLeadSlot({ leadId, startsAt, endsAt });
  if ("error" in booked) return booked.error === "slot_taken" ? { error: "slot_taken" } : { error: "no_assignee" };
  await inngest.send({ name: "appointment/booked", data: { tenantId, appointmentId: booked.appointmentId, jobId: booked.jobId, leadId } });
  return { ok: true, leadId, appointmentId: booked.appointmentId, jobId: booked.jobId };
}
