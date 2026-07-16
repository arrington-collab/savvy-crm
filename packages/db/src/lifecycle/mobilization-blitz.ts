import { and, asc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { parseBlitzConfig, streetNameFromAddress, haversineMeters } from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { mailCampaign, mailPiece } from "../schema/mail";
import { customer, property, lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { appointment } from "../schema/comms";
import { tenant as tenantTbl } from "../schema/tenancy";

export type BlitzResult =
  | { campaignId: string; status: string; audienceCount: number }
  | { skipped: "disabled" | "no_geocode" | "no_crew_appointment" | "no_audience" | "job_not_found" };

const ACTIVE_LEAD_STATUSES = ["new", "contacted", "qualified", "booked"];
const DEGREE_BOX = 0.03; // ~3.3km bounding box before the precise haversine cut

/**
 * Production scheduled ⇒ blitz plan: the closest N known homes (config 25–50),
 * three arrive-window waves bracketing the build, every piece held
 * print_pending behind the dormant print seam. Honest audience: only geocoded
 * property rows we already know — a parcel-data enricher can widen this later.
 * Red paths (tested): never the job's own address, never opted-out /
 * existing-customer / active-lead homes, never an address blitzed <60d ago;
 * over-cap or oversized-config plans stop at pending_approval, never send.
 */
export async function buildMobilizationBlitz(
  tenantId: string,
  input: { jobId: string; now?: Date },
): Promise<BlitzResult> {
  const now = input.now ?? new Date();
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const cfg = parseBlitzConfig((t?.settings as { blitz?: unknown } | null)?.blitz);
  if (!cfg.enabled) return { skipped: "disabled" };

  return withTenant(tenantId, async (tx) => {
    // Idempotent per job: replays return the existing plan.
    const [existing] = await tx.select({ id: mailCampaign.id, status: mailCampaign.status, audienceCount: mailCampaign.audienceCount })
      .from(mailCampaign)
      .where(and(eq(mailCampaign.tenantId, tenantId), eq(mailCampaign.kind, "mobilization_blitz"), eq(mailCampaign.triggerRef, input.jobId)));
    if (existing) return { campaignId: existing.id, status: existing.status, audienceCount: existing.audienceCount };

    const [j] = await tx.select({ id: job.id, propertyId: job.propertyId, customerId: job.customerId }).from(job)
      .where(and(eq(job.tenantId, tenantId), eq(job.id, input.jobId)));
    if (!j) return { skipped: "job_not_found" as const };

    const [site] = await tx.select({ id: property.id, address: property.address, lat: property.lat, lng: property.lng })
      .from(property).where(eq(property.id, j.propertyId));
    if (!site || site.lat == null || site.lng == null) return { skipped: "no_geocode" as const };

    const [crew] = await tx.select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt }).from(appointment)
      .where(and(
        eq(appointment.tenantId, tenantId), eq(appointment.jobId, input.jobId),
        eq(appointment.type, "crew"), eq(appointment.status, "scheduled"),
      ))
      .orderBy(asc(appointment.startsAt)).limit(1);
    if (!crew) return { skipped: "no_crew_appointment" as const };

    // Candidates: geocoded homes near the site, minus every red-path exclusion.
    const candidates = await tx.select({
      id: property.id, address: property.address, lat: property.lat, lng: property.lng,
    }).from(property)
      .where(and(
        eq(property.tenantId, tenantId),
        ne(property.id, site.id), // never the job's own address
        isNotNull(property.lat), isNotNull(property.lng),
        gte(property.lat, site.lat - DEGREE_BOX), lte(property.lat, site.lat + DEGREE_BOX),
        gte(property.lng, site.lng - DEGREE_BOX), lte(property.lng, site.lng + DEGREE_BOX),
        // do-not-mail: the property's customer opted out of print
        sql`not exists (select 1 from ${customer} c where c.id = ${property.customerId} and c.mail_opt_out = true)`,
        // existing customers (any job) are relationship territory, not blitz territory
        sql`not exists (select 1 from ${job} jj where jj.tenant_id = ${tenantId} and jj.customer_id = ${property.customerId})`,
        // active leads are already in the funnel
        sql`not exists (select 1 from ${lead} l where l.property_id = ${property.id} and l.status in (${sql.join(ACTIVE_LEAD_STATUSES.map((s) => sql`${s}`), sql`, `)}))`,
        // 60d suppression: same address, same campaign kind (cross-campaign)
        sql`not exists (
          select 1 from ${mailPiece} mp
          join ${mailCampaign} mc on mc.id = mp.campaign_id
          where mp.tenant_id = ${tenantId} and mc.kind = 'mobilization_blitz'
            and lower(trim(mp.address_text)) = lower(trim(${property.address}))
            and mp.created_at > ${new Date(now.getTime() - 60 * 86_400_000).toISOString()}::timestamptz
        )`,
      ));

    const ranked = candidates
      .map((c) => ({ ...c, dist: haversineMeters({ lat: site.lat!, lng: site.lng! }, { lat: c.lat!, lng: c.lng! }) }))
      .filter((c) => c.dist <= cfg.radiusMeters)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, Math.min(cfg.audienceSize, cfg.audienceMax));
    if (ranked.length === 0) return { skipped: "no_audience" as const };

    const estCostCents = ranked.length * 3 * cfg.pieceCostCents;
    const needsApproval = estCostCents > cfg.perJobCapCents || cfg.audienceSize > cfg.audienceMax;
    const status = needsApproval ? "pending_approval" : "approved";

    const [camp] = await tx.insert(mailCampaign).values({
      tenantId, kind: "mobilization_blitz", triggerRef: input.jobId, jobId: input.jobId,
      audienceCount: ranked.length, estCostCents, status,
      ...(needsApproval ? {} : { approvedAt: now }),
    }).onConflictDoNothing().returning();
    if (!camp) {
      const [raced] = await tx.select({ id: mailCampaign.id, status: mailCampaign.status, audienceCount: mailCampaign.audienceCount })
        .from(mailCampaign)
        .where(and(eq(mailCampaign.tenantId, tenantId), eq(mailCampaign.kind, "mobilization_blitz"), eq(mailCampaign.triggerRef, input.jobId)));
      return { campaignId: raced!.id, status: raced!.status, audienceCount: raced!.audienceCount };
    }

    // Waves bracket the build: arrive before start / during / 2–4 days after.
    const street = streetNameFromAddress(site.address);
    const waves = [
      { wave: 1, mailBy: new Date(crew.startsAt.getTime() - cfg.waveLeadDays * 86_400_000) },
      { wave: 2, mailBy: crew.startsAt },
      { wave: 3, mailBy: crew.endsAt },
    ];
    for (const target of ranked) {
      for (const w of waves) {
        await tx.insert(mailPiece).values({
          tenantId, campaignId: camp.id, propertyId: target.id, addressText: target.address,
          wave: w.wave, templateKey: `blitz_wave_${w.wave}`,
          mergeVars: { street },
          mailByDate: w.mailBy,
          arriveWindowStart: new Date(w.mailBy.getTime() + 3 * 86_400_000),
          arriveWindowEnd: new Date(w.mailBy.getTime() + 6 * 86_400_000),
          costCents: cfg.pieceCostCents,
        }).onConflictDoNothing();
      }
    }
    return { campaignId: camp.id, status, audienceCount: ranked.length };
  });
}

export type PendingBlitz = {
  campaignId: string;
  jobId: string | null;
  audienceCount: number;
  estCostCents: number;
  createdAt: Date;
};

/** Over-cap / oversized plans waiting on a human — the approval card's list. */
export async function pendingBlitzApprovals(tenantId: string): Promise<PendingBlitz[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      campaignId: mailCampaign.id, jobId: mailCampaign.jobId,
      audienceCount: mailCampaign.audienceCount, estCostCents: mailCampaign.estCostCents,
      createdAt: mailCampaign.createdAt,
    }).from(mailCampaign)
      .where(and(
        eq(mailCampaign.tenantId, tenantId),
        eq(mailCampaign.kind, "mobilization_blitz"),
        eq(mailCampaign.status, "pending_approval"),
      )),
  );
}

export async function approveBlitzCampaign(
  tenantId: string,
  input: { campaignId: string; userId: string | null },
): Promise<{ approved: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(mailCampaign)
      .set({ status: "approved", approvedByUserId: input.userId, approvedAt: new Date() })
      .where(and(
        eq(mailCampaign.tenantId, tenantId),
        eq(mailCampaign.id, input.campaignId),
        eq(mailCampaign.status, "pending_approval"),
      )).returning({ id: mailCampaign.id });
    return { approved: !!row };
  });
}

export type BlitzWeekStats = {
  blitzes: number;
  spendCents: number;
  mobilizationLeads: number;
  blitzedJobs12mo: number;
  mobilizationRoofs12mo: number;
};

/**
 * The digest's trailing-week numbers plus the rolling 12-month
 * roofs-per-jobs ratio inputs (graded against the 1-in-7 target):
 * blitzedJobs = campaigns run; mobilizationRoofs = jobs born from
 * mobilization-sourced leads.
 */
export async function blitzWeekStats(tenantId: string, now: Date): Promise<BlitzWeekStats> {
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const yearStart = new Date(now.getTime() - 365 * 86_400_000);
  return withTenant(tenantId, async (tx) => {
    const week = await tx.select({
      blitzes: sql<number>`count(*)::int`,
      spendCents: sql<number>`coalesce(sum(${mailCampaign.estCostCents}), 0)::int`,
    }).from(mailCampaign)
      .where(and(
        eq(mailCampaign.tenantId, tenantId), eq(mailCampaign.kind, "mobilization_blitz"),
        gte(mailCampaign.createdAt, weekStart),
      ));
    const [weekLeads] = await tx.select({ n: sql<number>`count(*)::int` }).from(lead)
      .where(and(eq(lead.tenantId, tenantId), eq(lead.source, "mobilization"), gte(lead.createdAt, weekStart)));
    const [jobs12] = await tx.select({ n: sql<number>`count(*)::int` }).from(mailCampaign)
      .where(and(
        eq(mailCampaign.tenantId, tenantId), eq(mailCampaign.kind, "mobilization_blitz"),
        gte(mailCampaign.createdAt, yearStart),
      ));
    const [roofs12] = await tx.select({ n: sql<number>`count(*)::int` }).from(job)
      .where(and(
        eq(job.tenantId, tenantId),
        sql`exists (select 1 from ${lead} l where l.id = ${job.leadId} and l.source = 'mobilization')`,
        gte(job.createdAt, yearStart),
      ));
    return {
      blitzes: Number(week[0]?.blitzes ?? 0),
      spendCents: Number(week[0]?.spendCents ?? 0),
      mobilizationLeads: Number(weekLeads?.n ?? 0),
      blitzedJobs12mo: Number(jobs12?.n ?? 0),
      mobilizationRoofs12mo: Number(roofs12?.n ?? 0),
    };
  });
}
