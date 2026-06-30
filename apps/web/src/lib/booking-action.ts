"use server";
import {
  adminDb, lead, job, user, property, appointment, tenant, eq, and, or,
  bookAppointment, rescheduleAppointment, convertLeadToJob, SlotTakenError, NoAssigneeError,
  bookLeadSlot, setCustomerEmail,
} from "@savvy/db";
import { verifyPayloadToken, parseSchedulingConfig, parseFinanceConfig, computeOpenSlots, requireSecret } from "@savvy/core";
import { inngest } from "@savvy/agents";

const SECRET = () => requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });

type TokenPayload = {
  tenantId: string;
  type: "inspection" | "cm" | "crew";
  leadId?: string;
  jobId?: string;
  appointmentId?: string;
};

export async function getSlotsForToken(token: string) {
  const p = verifyPayloadToken<TokenPayload>(token, SECRET());
  if (!p) return { error: "invalid" as const };
  const cfg = parseSchedulingConfig(await loadSchedulingSettings(p.tenantId));
  const tz = parseFinanceConfig(await loadFinanceSettings(p.tenantId)).timezone;
  const assignee = await resolveAssignee(p);
  if (!assignee) return { error: "no_assignee" as const };
  const busy = await loadBusy(p.tenantId, assignee.id, cfg.bookingHorizonDays);
  const cluster = await loadClusterPoint(p);
  const slots = computeOpenSlots({
    config: cfg, type: p.type, existingAppts: busy,
    fromDate: new Date(), now: new Date(), tz, clusterAround: cluster ?? undefined,
  }).slice(0, 12);
  return { slots: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
}

// Homeowner-provided email at booking time = self_reported (marketing-usable).
async function captureEmail(tenantId: string, customerId: string | undefined, email: string | undefined): Promise<void> {
  if (!email || !customerId) return;
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return; // ignore obviously-bad input, don't fail the booking
  try {
    await setCustomerEmail(tenantId, { customerId, email: trimmed, source: "self_reported" });
  } catch (e) {
    console.error("capture booking email failed", e);
  }
}

export async function confirmSlot(token: string, startsAt: string, endsAt: string, email?: string) {
  const p = verifyPayloadToken<TokenPayload>(token, SECRET());
  if (!p) return { error: "invalid" as const };
  try {
    if (p.appointmentId) {
      await rescheduleAppointment({
        tenantId: p.tenantId, appointmentId: p.appointmentId,
        startsAt: new Date(startsAt), endsAt: new Date(endsAt),
      });
      try {
        await inngest.send({ name: "appointment/changed", data: { appointmentId: p.appointmentId, tenantId: p.tenantId, reason: "rescheduled" } });
      } catch (e) { console.error(e); }
      return { ok: true as const };
    }
    // Lead-only token (no jobId/appointmentId): reuse the shared engine booking.
    if (p.leadId && !p.jobId) {
      const r = await bookLeadSlot({ leadId: p.leadId, startsAt, endsAt });
      if ("appointmentId" in r) {
        try {
          await inngest.send({ name: "appointment/booked", data: { appointmentId: r.appointmentId, tenantId: r.tenantId } });
        } catch (e) { console.error(e); }
        const [l] = await adminDb.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, p.leadId));
        await captureEmail(p.tenantId, l?.customerId ?? undefined, email);
        return { ok: true as const };
      }
      if (r.error === "slot_taken") return { error: "slot_taken" as const };
      return { error: "no_assignee" as const }; // no_assignee or no_lead -> no_assignee for the token caller
    }
    const assignee = await resolveAssignee(p);
    if (!assignee) return { error: "no_assignee" as const };
    const conv = p.leadId ? await convertLeadToJob({ tenantId: p.tenantId, leadId: p.leadId }) : null;
    const jobId = p.jobId ?? conv!.jobId;
    // Without a customerId the appointment can't be reminded (no phone/email lookup),
    // so for a jobId-only token resolve it from the job.
    let customerId = conv?.customerId;
    if (!customerId) {
      const [j] = await adminDb.select().from(job).where(eq(job.id, jobId));
      customerId = j?.customerId ?? undefined;
    }
    const appt = await bookAppointment({
      tenantId: p.tenantId, jobId, customerId, type: p.type, assigneeUserId: assignee.id,
      startsAt: new Date(startsAt), endsAt: new Date(endsAt),
    });
    try {
      await inngest.send({ name: "appointment/booked", data: { appointmentId: appt.id, tenantId: p.tenantId } });
    } catch (e) { console.error(e); }
    await captureEmail(p.tenantId, customerId, email);
    return { ok: true as const };
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    if (e instanceof NoAssigneeError) return { error: "no_assignee" as const };
    throw e;
  }
}

async function loadSchedulingSettings(tenantId: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { scheduling?: unknown } | null)?.scheduling;
}

async function loadFinanceSettings(tenantId: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { finance?: unknown } | null)?.finance;
}

async function resolveAssignee(p: TokenPayload): Promise<{ id: string } | null> {
  if (p.leadId) {
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, p.leadId));
    if (l?.assignedUserId) return { id: l.assignedUserId };
  }
  if (p.jobId) {
    const [j] = await adminDb.select().from(job).where(eq(job.id, p.jobId));
    if (j?.assignedUserId) return { id: j.assignedUserId };
  }
  if (p.appointmentId) {
    const [a] = await adminDb.select().from(appointment).where(eq(appointment.id, p.appointmentId));
    if (a?.assigneeUserId) return { id: a.assigneeUserId };
  }
  const [u] = await adminDb.select({ id: user.id }).from(user)
    .where(and(eq(user.tenantId, p.tenantId), or(eq(user.role, "owner"), eq(user.role, "rep"))));
  return u ?? null;
}

async function loadBusy(tenantId: string, assigneeUserId: string, horizonDays: number) {
  const from = new Date();
  const to = new Date(Date.now() + horizonDays * 86400_000);
  const rows = await adminDb.select({
    startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng,
  }).from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, assigneeUserId), eq(appointment.status, "scheduled")));
  return rows.filter((r) => r.startsAt >= from && r.startsAt < to)
    .map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt, lat: r.lat == null ? undefined : Number(r.lat), lng: r.lng == null ? undefined : Number(r.lng) }));
}

async function loadClusterPoint(p: TokenPayload): Promise<{ lat: number; lng: number } | null> {
  let propertyId: string | undefined;
  if (p.leadId) { const [l] = await adminDb.select().from(lead).where(eq(lead.id, p.leadId)); propertyId = l?.propertyId ?? undefined; }
  if (!propertyId && p.jobId) { const [j] = await adminDb.select().from(job).where(eq(job.id, p.jobId)); propertyId = j?.propertyId ?? undefined; }
  if (!propertyId) return null;
  const [pr] = await adminDb.select().from(property).where(eq(property.id, propertyId));
  return pr?.lat != null && pr?.lng != null ? { lat: Number(pr.lat), lng: Number(pr.lng) } : null;
}
