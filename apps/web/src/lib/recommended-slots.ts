"use server";
import { adminDb, lead, user, property, appointment, job, tenant, eq, and } from "@savvy/db";
import { parseSchedulingConfig, computeOpenSlots, rankSlots, resolveRepOrigin, type LatLng } from "@savvy/core";
import { distance } from "@savvy/integrations";

type RecommendedSlot = { startsAt: string; endsAt: string; driveMinutes: number | null };

export async function getRecommendedSlots(
  leadId: string,
  opts?: { type?: "inspection" | "cm" | "crew"; limit?: number },
): Promise<{ error: "no_lead" | "no_assignee" } | { slots: RecommendedSlot[] }> {
  const type = opts?.type ?? "inspection";
  const limit = opts?.limit ?? 3;

  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId, propertyId: lead.propertyId })
    .from(lead)
    .where(eq(lead.id, leadId));
  if (!l) return { error: "no_lead" };
  if (!l.assignedUserId) return { error: "no_assignee" };

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, l.tenantId));
  const cfg = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | null)?.scheduling);

  // Destination + cluster point = the lead's property.
  const dest = l.propertyId
    ? (await adminDb.select({ lat: property.lat, lng: property.lng }).from(property).where(eq(property.id, l.propertyId)))[0]
    : undefined;
  const destPoint: LatLng | null = dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;

  // Assignee's scheduled appts (with location) across the horizon — used for both busy + origin.
  const horizonEnd = new Date(Date.now() + cfg.bookingHorizonDays * 86_400_000);
  const apptRows = await adminDb
    .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng })
    .from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(and(eq(appointment.tenantId, l.tenantId), eq(appointment.assigneeUserId, l.assignedUserId), eq(appointment.status, "scheduled")));
  const busy = apptRows
    .filter((r) => r.startsAt >= new Date() && r.startsAt < horizonEnd)
    .map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt, lat: r.lat == null ? undefined : Number(r.lat), lng: r.lng == null ? undefined : Number(r.lng) }));

  const slots = computeOpenSlots({
    config: cfg, type, existingAppts: busy, fromDate: new Date(), now: new Date(),
    clusterAround: destPoint ?? undefined,
  }).slice(0, 12);

  // Rep base + tenant office for the origin fallback chain.
  const [u] = await adminDb.select({ baseLat: user.baseLat, baseLng: user.baseLng }).from(user).where(and(eq(user.id, l.assignedUserId), eq(user.tenantId, l.tenantId)));
  const repBase: LatLng | null = u?.baseLat != null && u?.baseLng != null ? { lat: Number(u.baseLat), lng: Number(u.baseLng) } : null;
  const officeRaw = (t?.settings as { scheduling?: { office?: { lat?: number; lng?: number } } } | null)?.scheduling?.office;
  const tenantOffice: LatLng | null = officeRaw && typeof officeRaw.lat === "number" && typeof officeRaw.lng === "number" ? { lat: officeRaw.lat, lng: officeRaw.lng } : null;

  const sameDay = (day: Date) => busy.filter(
    (b) => b.lat != null && b.lng != null && b.startsAt.toISOString().slice(0, 10) === day.toISOString().slice(0, 10),
  ).map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt, lat: b.lat as number, lng: b.lng as number }));

  // Per-slot origin, then one batched drive-time call.
  const origins = slots.map((s) => resolveRepOrigin({ sameDayAppts: sameDay(s.startsAt), reference: s.startsAt, repBase, tenantOffice }));
  const idxWithOrigin = origins.map((o, i) => ({ o, i })).filter((x): x is { o: LatLng; i: number } => x.o != null);
  const matrix = destPoint && idxWithOrigin.length ? await distance.driveMinutesMatrix(idxWithOrigin.map((x) => x.o), [destPoint]) : null;
  const driveBySlot: (number | null)[] = slots.map(() => null);
  idxWithOrigin.forEach((x, k) => { driveBySlot[x.i] = matrix ? (matrix[k]?.[0] ?? null) : null; });

  const ranked = rankSlots({ slots, driveMinutesBySlotIndex: driveBySlot, weights: cfg.driveTime }).slice(0, limit);
  return { slots: ranked.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), driveMinutes: s.driveMinutes })) };
}
