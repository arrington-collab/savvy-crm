import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { user, lead, job, property, appointment } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

export type DbAssignmentCandidate = {
  userId: string;
  role: string;
  openLeadCount: number;
  lastAssignedAt: string | null;
  baseLat: number | null;
  baseLng: number | null;
  skills: string[];
};

const SALES_ROLES = ["owner", "admin", "rep"] as const;

export async function getAssignmentCandidates(tx: Tx, tenantId: string): Promise<DbAssignmentCandidate[]> {
  const users = await tx
    .select({ id: user.id, role: user.role, baseLat: user.baseLat, baseLng: user.baseLng, skills: user.skills })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, [...SALES_ROLES])));

  const stats = await tx
    .select({
      userId: lead.assignedUserId,
      openCount: sql<number>`count(*) filter (where ${lead.status} not in ('won','lost'))`.mapWith(Number),
      lastAssignedAt: sql<string | null>`max(${lead.createdAt})`,
    })
    .from(lead)
    .where(eq(lead.tenantId, tenantId))
    .groupBy(lead.assignedUserId);

  const statById = new Map(stats.filter((s) => s.userId).map((s) => [s.userId as string, s]));
  return users.map((u) => ({
    userId: u.id,
    role: u.role,
    openLeadCount: statById.get(u.id)?.openCount ?? 0,
    lastAssignedAt: statById.get(u.id)?.lastAssignedAt ?? null,
    baseLat: u.baseLat == null ? null : Number(u.baseLat),
    baseLng: u.baseLng == null ? null : Number(u.baseLng),
    skills: u.skills ?? [],
  }));
}

export async function getAssignmentSettings(tenantId: string): Promise<unknown> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { assignment?: unknown } | null)?.assignment ?? null;
}

export async function saveAssignmentConfig(tenantId: string, assignment: unknown): Promise<void> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as Record<string, unknown>;
  await adminDb.update(tenant).set({ settings: { ...settings, assignment } }).where(eq(tenant.id, tenantId));
}

// A rep's scheduled appointments on the same UTC day as `ref`, with the property location,
// via appointment → job → property. Returned grouped by assignee userId.
export async function getRepSameDayAppts(
  tx: Tx,
  tenantId: string,
  ref: Date,
): Promise<Map<string, { startsAt: Date; endsAt: Date; lat: number; lng: number }[]>> {
  const dayStart = new Date(ref); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const rows = await tx
    .select({
      userId: appointment.assigneeUserId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      lat: property.lat,
      lng: property.lng,
    })
    .from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(
      and(
        eq(appointment.tenantId, tenantId),
        eq(appointment.status, "scheduled"),
        gte(appointment.startsAt, dayStart),
        lt(appointment.startsAt, dayEnd),
      ),
    );
  const out = new Map<string, { startsAt: Date; endsAt: Date; lat: number; lng: number }[]>();
  for (const r of rows) {
    if (!r.userId || r.lat == null || r.lng == null) continue;
    const list = out.get(r.userId) ?? [];
    list.push({ startsAt: r.startsAt, endsAt: r.endsAt, lat: Number(r.lat), lng: Number(r.lng) });
    out.set(r.userId, list);
  }
  return out;
}

export async function getScoringSettings(tenantId: string): Promise<unknown> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { scoring?: unknown } | null)?.scoring ?? null;
}

// Tenant office origin from settings.scheduling.office (jsonb), if configured.
export async function getSchedulingOffice(tenantId: string): Promise<{ lat: number; lng: number } | null> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const office = ((t?.settings as { scheduling?: { office?: unknown } } | null)?.scheduling?.office) as
    | { lat?: number; lng?: number }
    | undefined;
  return office && typeof office.lat === "number" && typeof office.lng === "number"
    ? { lat: office.lat, lng: office.lng }
    : null;
}
