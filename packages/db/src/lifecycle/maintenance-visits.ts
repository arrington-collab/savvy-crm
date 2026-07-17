import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { orderVisitBatch, parseMaintenanceConfig, renderTemplate } from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { appointment, communication } from "../schema/comms";
import { customer, property } from "../schema/crm";
import { inspection } from "../schema/inspection";
import { membership } from "../schema/membership";
import { tenant as tenantTbl } from "../schema/tenancy";

// Phase 20 S3 (#307/#308) — annual visits + the homeowner report. INVARIANTS:
// every active member is visited within 12 months (a due member always gets an
// appointment — "already on the calendar" is the only pass), and every
// completed visit produces a tokenized report; an unreachable phone never
// hangs the report invariant (minted + marked, send skipped).

const D = 86_400_000;

export type VisitSweepResult = { scheduled: number };

export async function runMaintenanceVisitSweep(tenantId: string, now = new Date()): Promise<VisitSweepResult> {
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const cfg = parseMaintenanceConfig((t?.settings as { maintenance?: unknown } | null)?.maintenance);
  if (!cfg.enabled) return { scheduled: 0 };
  const dueBefore = new Date(now.getTime() - cfg.visitDueMonths * 30 * D);

  return withTenant(tenantId, async (tx) => {
    const members = await tx.select({ customerId: membership.customerId, startedAt: membership.startedAt })
      .from(membership).where(and(eq(membership.tenantId, tenantId), eq(membership.status, "active")));
    if (members.length === 0) return { scheduled: 0 };
    const customerIds = members.map((m) => m.customerId);

    // A member is due when membership started before the window AND no
    // maintenance visit completed inside it AND nothing is on the calendar.
    const props = await tx.select({ id: property.id, customerId: property.customerId, lat: property.lat, lng: property.lng })
      .from(property).where(and(eq(property.tenantId, tenantId), inArray(property.customerId, customerIds)));
    const propByCustomer = new Map(props.map((p) => [p.customerId, p]));

    const recentVisits = await tx.select({ propertyId: inspection.propertyId }).from(inspection).where(and(
      eq(inspection.tenantId, tenantId), eq(inspection.kind, "maintenance_annual"),
      isNotNull(inspection.completedAt), gt(inspection.completedAt, dueBefore),
    ));
    const visitedProps = new Set(recentVisits.map((v) => v.propertyId));

    const upcoming = await tx.select({ customerId: appointment.customerId }).from(appointment).where(and(
      eq(appointment.tenantId, tenantId), eq(appointment.type, "inspection"),
      eq(appointment.status, "scheduled"), gt(appointment.startsAt, now),
      inArray(appointment.customerId, customerIds),
    ));
    const booked = new Set(upcoming.map((a) => a.customerId));

    const due: { id: string; propertyId: string | null; lat: number | null; lng: number | null }[] = [];
    for (const m of members) {
      if (!m.startedAt || m.startedAt >= dueBefore) continue; // not yet due
      if (booked.has(m.customerId)) continue; // already on the calendar
      const prop = propByCustomer.get(m.customerId);
      if (prop && visitedProps.has(prop.id)) continue; // visited inside the window
      due.push({ id: m.customerId, propertyId: prop?.id ?? null, lat: prop?.lat ?? null, lng: prop?.lng ?? null });
    }

    // Neighbors share a day: nearest-neighbor route chunked per day, starting
    // visitLeadDays out — the light-duty window the fill loop leaves open.
    const days = orderVisitBatch(due, cfg.visitsPerDay);
    let scheduled = 0;
    for (let d = 0; d < days.length; d++) {
      const startsBase = new Date(now.getTime() + (cfg.visitLeadDays + d) * D);
      for (const m of days[d]!) {
        const startsAt = startsBase;
        const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
        await tx.insert(appointment).values({
          tenantId, customerId: m.id, propertyId: m.propertyId, type: "inspection",
          startsAt, endsAt, status: "scheduled",
        });
        scheduled += 1;
      }
    }
    return { scheduled };
  });
}

export type ReportSendResult = { sent: number };

/** Mint + send tokenized visit reports for completed maintenance inspections. */
export async function sendDueVisitReports(tenantId: string, now = new Date()): Promise<ReportSendResult> {
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const cfg = parseMaintenanceConfig((t?.settings as { maintenance?: unknown } | null)?.maintenance);
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";

  return withTenant(tenantId, async (tx) => {
    const due = await tx.select({ id: inspection.id, propertyId: inspection.propertyId })
      .from(inspection).where(and(
        eq(inspection.tenantId, tenantId), eq(inspection.kind, "maintenance_annual"),
        eq(inspection.status, "published"), isNotNull(inspection.completedAt), isNull(inspection.reportSentAt),
      ));

    let sent = 0;
    for (const insp of due) {
      const token = randomBytes(16).toString("hex");
      const [prop] = await tx.select({ customerId: property.customerId }).from(property).where(eq(property.id, insp.propertyId));
      const [cust] = prop?.customerId
        ? await tx.select({ id: customer.id, name: customer.name, phone: customer.phone, smsOptOut: customer.smsOptOut })
            .from(customer).where(eq(customer.id, prop.customerId))
        : [];

      if (cust?.phone && !cust.smsOptOut) {
        const body = renderTemplate(cfg.copy.report, {
          firstName: cust.name.split(/\s+/)[0] ?? cust.name,
          reportUrl: `${base}/report/${token}`,
        });
        await tx.insert(communication).values({
          tenantId, customerId: cust.id, channel: "sms", direction: "outbound",
          to: cust.phone, body, aiHandled: false,
        });
      }
      // Minted + marked regardless of reachability — the invariant is about the
      // report existing, and the token page works the moment they can open it.
      await tx.update(inspection).set({ reportToken: token, reportSentAt: now }).where(eq(inspection.id, insp.id));
      sent += 1;
    }
    return { sent };
  });
}

export type VisitReportData = {
  tenantName: string;
  completedAt: Date | null;
  narrative: string | null;
  score: { label: string; counts: { good: number; monitor: number; action: number; ungraded: number } };
  zones: { zoneLabel: string; zoneKind: string; grade: string | null; photoCount: number }[];
  repairQuotes: { whatItIs: string; ifIgnored: string | null; timeframe: string | null; repairEstimateCents: number }[];
};

/** Resolve the public tokenized report (no auth — the token IS the capability). */
export async function getVisitReport(token: string): Promise<VisitReportData | null> {
  if (!token || token.length < 16) return null;
  const [insp] = await adminDb.select().from(inspection).where(eq(inspection.reportToken, token));
  if (!insp || insp.kind !== "maintenance_annual") return null;

  const { inspectionZone, inspectionFinding } = await import("../schema/inspection");
  const zones = await adminDb.select().from(inspectionZone).where(eq(inspectionZone.inspectionId, insp.id));
  const zoneIds = zones.map((z) => z.id);
  const findings = zoneIds.length > 0
    ? await adminDb.select().from(inspectionFinding).where(inArray(inspectionFinding.inspectionZoneId, zoneIds))
    : [];
  const [t] = await adminDb.select({ name: tenantTbl.name }).from(tenantTbl).where(eq(tenantTbl.id, insp.tenantId));

  const { computeRoofConditionScore } = await import("@savvy/core");
  return {
    tenantName: t?.name ?? "Your roofing company",
    completedAt: insp.completedAt,
    narrative: insp.narrative,
    score: computeRoofConditionScore(zones),
    zones: zones.map((z) => ({
      zoneLabel: z.zoneLabel, zoneKind: z.zoneKind, grade: z.grade,
      // Photos ride findings (a zone's evidence), not the zone row itself.
      photoCount: findings
        .filter((f) => f.inspectionZoneId === z.id)
        .reduce((n, f) => n + ((f.photoIds as string[] | null)?.length ?? 0), 0),
    })),
    repairQuotes: findings
      .filter((f) => f.disposition === "repair_quoted" && f.repairEstimateCents != null)
      .map((f) => ({ whatItIs: f.whatItIs, ifIgnored: f.ifIgnored, timeframe: f.timeframe, repairEstimateCents: f.repairEstimateCents! })),
  };
}
