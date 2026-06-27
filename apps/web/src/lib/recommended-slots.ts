"use server";
import { adminDb, lead, user, property, appointment, job, tenant, eq, and } from "@savvy/db";
import { parseSchedulingConfig, parseFinanceConfig, computeOpenSlots, rankSlots, resolveRepOrigin, spokenSlotLabel, toCivilDate, zonedTimeToUtc, type LatLng } from "@savvy/core";
import { distance } from "@savvy/integrations";

type RecommendedSlot = { startsAt: string; endsAt: string; driveMinutes: number | null; label: string };

/** A rep's next open inspection times, drive-time aware, today/soonest first.
 *  Preview only — no writes. `clusterAround` (the prospect's property) sharpens
 *  drive-time + clustering when known. */
export async function slotsForRep(args: {
  tenantId: string;
  repId: string;
  type?: "inspection" | "cm" | "crew";
  limit?: number;
  todayFirst?: boolean;
  clusterAround?: LatLng | null;
}): Promise<{ slots: RecommendedSlot[] }> {
  const { tenantId, repId } = args;
  const type = args.type ?? "inspection";
  const limit = args.limit ?? 2;
  const todayFirst = args.todayFirst ?? true;
  const destPoint = args.clusterAround ?? null;

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | null)?.scheduling);
  const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;

  const horizonEnd = new Date(Date.now() + cfg.bookingHorizonDays * 86_400_000);
  const apptRows = await adminDb
    .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng })
    .from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, repId), eq(appointment.status, "scheduled")));
  const busy = apptRows
    .filter((r) => r.startsAt >= new Date() && r.startsAt < horizonEnd)
    .map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt, lat: r.lat == null ? undefined : Number(r.lat), lng: r.lng == null ? undefined : Number(r.lng) }));

  const slots = computeOpenSlots({
    config: cfg, type, existingAppts: busy, fromDate: new Date(), now: new Date(), tz,
    clusterAround: destPoint ?? undefined,
  })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, 12);

  const [u] = await adminDb.select({ baseLat: user.baseLat, baseLng: user.baseLng }).from(user).where(and(eq(user.id, repId), eq(user.tenantId, tenantId)));
  const repBase: LatLng | null = u?.baseLat != null && u?.baseLng != null ? { lat: Number(u.baseLat), lng: Number(u.baseLng) } : null;
  const officeRaw = (t?.settings as { scheduling?: { office?: { lat?: number; lng?: number } } } | null)?.scheduling?.office;
  const tenantOffice: LatLng | null = officeRaw && typeof officeRaw.lat === "number" && typeof officeRaw.lng === "number" ? { lat: officeRaw.lat, lng: officeRaw.lng } : null;

  const sameDay = (day: Date) => busy.filter(
    (b) => b.lat != null && b.lng != null && b.startsAt.toISOString().slice(0, 10) === day.toISOString().slice(0, 10),
  ).map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt, lat: b.lat as number, lng: b.lng as number }));

  const origins = slots.map((s) => resolveRepOrigin({ sameDayAppts: sameDay(s.startsAt), reference: s.startsAt, repBase, tenantOffice }));
  const idxWithOrigin = origins.map((o, i) => ({ o, i })).filter((x): x is { o: LatLng; i: number } => x.o != null);
  const matrix = destPoint && idxWithOrigin.length ? await distance.driveMinutesMatrix(idxWithOrigin.map((x) => x.o), [destPoint]) : null;
  const driveBySlot: (number | null)[] = slots.map(() => null);
  idxWithOrigin.forEach((x, k) => { driveBySlot[x.i] = matrix ? (matrix[k]?.[0] ?? null) : null; });

  // today-first: bonus any slot starting on/before tenant-local end-of-today.
  const nowIso = new Date().toISOString();
  const todayCutoff = todayFirst ? new Date(zonedTimeToUtc(toCivilDate(nowIso, tz), 23 * 60 + 59, tz)) : undefined;

  const ranked = rankSlots({ slots, driveMinutesBySlotIndex: driveBySlot, weights: cfg.driveTime, todayCutoff }).slice(0, limit);
  return {
    slots: ranked.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      driveMinutes: s.driveMinutes,
      label: spokenSlotLabel(s.startsAt.toISOString(), tz, nowIso),
    })),
  };
}

/** Lead-keyed wrapper (existing callers): resolve the lead's tenant + assignee +
 *  property cluster point, then delegate to slotsForRep. Default limit stays 3. */
export async function getRecommendedSlots(
  leadId: string,
  opts?: { type?: "inspection" | "cm" | "crew"; limit?: number },
): Promise<{ error: "no_lead" | "no_assignee" } | { slots: RecommendedSlot[] }> {
  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId, propertyId: lead.propertyId })
    .from(lead)
    .where(eq(lead.id, leadId));
  if (!l) return { error: "no_lead" };
  if (!l.assignedUserId) return { error: "no_assignee" };

  const dest = l.propertyId
    ? (await adminDb.select({ lat: property.lat, lng: property.lng }).from(property).where(eq(property.id, l.propertyId)))[0]
    : undefined;
  const clusterAround: LatLng | null = dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;

  return slotsForRep({ tenantId: l.tenantId, repId: l.assignedUserId, type: opts?.type, limit: opts?.limit ?? 3, todayFirst: true, clusterAround });
}

/** Job-keyed crew-slot recommendations for the install booking flow. Resolves the
 *  job's tenant + property cluster point, then delegates to slotsForRep(type="crew").
 *  Each slot carries `startLocal` ("YYYY-MM-DDTHH:mm" in tenant tz) so the booking
 *  form can prefill its datetime-local input directly. */
export async function getRecommendedCrewSlots(
  jobId: string,
  crewUserId: string,
  opts?: { limit?: number },
): Promise<{ error: "no_job" } | { slots: (RecommendedSlot & { startLocal: string })[] }> {
  const [j] = await adminDb
    .select({ tenantId: job.tenantId, propertyId: job.propertyId })
    .from(job)
    .where(eq(job.id, jobId));
  if (!j) return { error: "no_job" };

  const dest = j.propertyId
    ? (await adminDb.select({ lat: property.lat, lng: property.lng }).from(property).where(eq(property.id, j.propertyId)))[0]
    : undefined;
  const clusterAround: LatLng | null =
    dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;

  const { slots } = await slotsForRep({
    tenantId: j.tenantId, repId: crewUserId, type: "crew", limit: opts?.limit ?? 5, todayFirst: true, clusterAround,
  });

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, j.tenantId));
  const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    slots: slots.map((s) => ({ ...s, startLocal: `${toCivilDate(s.startsAt, tz)}T${timeFmt.format(new Date(s.startsAt))}` })),
  };
}
