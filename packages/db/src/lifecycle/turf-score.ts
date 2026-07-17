import { and, eq, gte, isNotNull } from "drizzle-orm";
import { computeTurfScore, TURF_THRESHOLD } from "@savvy/core";
import { withTenant } from "../tenant";
import { property } from "../schema/crm";
import { job } from "../schema/jobs";
import { mailCampaign } from "../schema/mail";
import { neighborhood } from "../schema/strike-list";

// Strike List slice 4 (#269/#270) — the Turf scorer. For each subdivision:
// parcel_count = properties we know there, our_completed_jobs = jobs that
// reached stage 'complete' on one of those parcels, and turf_score is the
// recency-weighted ratio. Upserts one neighborhood row per (tenant, name); the
// monthly sweep refreshes them in place.

export interface ScoredNeighborhood {
  name: string;
  parcelCount: number;
  ourCompletedJobs: number;
  turfScore: number;
}

export async function scoreTenantTurf(tenantId: string, now: Date = new Date()): Promise<ScoredNeighborhood[]> {
  const scored = await withTenant(tenantId, async (tx) => {
    // Parcels per subdivision (our known universe there).
    const props = await tx.select({ subdivision: property.subdivision })
      .from(property).where(and(eq(property.tenantId, tenantId), isNotNull(property.subdivision)));
    const parcelCount = new Map<string, number>();
    for (const p of props) {
      if (!p.subdivision) continue;
      parcelCount.set(p.subdivision, (parcelCount.get(p.subdivision) ?? 0) + 1);
    }

    // Completed jobs per subdivision, with their completion timestamps.
    const completions = await tx.select({ subdivision: property.subdivision, at: job.stageEnteredAt })
      .from(job)
      .innerJoin(property, eq(property.id, job.propertyId))
      .where(and(eq(job.tenantId, tenantId), eq(job.stage, "complete"), isNotNull(property.subdivision)));
    const bySub = new Map<string, Date[]>();
    for (const c of completions) {
      if (!c.subdivision) continue;
      const list = bySub.get(c.subdivision) ?? [];
      list.push(c.at);
      bySub.set(c.subdivision, list);
    }

    const rows: ScoredNeighborhood[] = [];
    for (const [name, parcels] of parcelCount) {
      const comps = bySub.get(name) ?? [];
      rows.push({
        name,
        parcelCount: parcels,
        ourCompletedJobs: comps.length,
        turfScore: computeTurfScore({ completions: comps, parcelCount: parcels, now }),
      });
    }
    return rows;
  });

  // Persist each neighborhood, idempotent on (tenant, name).
  for (const n of scored) {
    await withTenant(tenantId, (tx) => tx.insert(neighborhood).values({
      tenantId, name: n.name, parcelCount: n.parcelCount, ourCompletedJobs: n.ourCompletedJobs,
      turfScore: n.turfScore, lastScoredAt: now,
    }).onConflictDoUpdate({
      target: [neighborhood.tenantId, neighborhood.name],
      set: { parcelCount: n.parcelCount, ourCompletedJobs: n.ourCompletedJobs, turfScore: n.turfScore, lastScoredAt: now },
    }));
  }
  return scored;
}

// Threshold crossing → a "neighbors chose us" saturation campaign, parked at
// pending_approval (the owner approves spend; PostGrid, once built, does the
// send). Idempotent on the (tenant, kind, trigger_ref) unique index — one
// campaign per hot neighborhood, re-runs are no-ops.
export async function emitTurfCampaigns(
  tenantId: string,
  opts: { threshold?: number } = {},
): Promise<{ triggered: number }> {
  const threshold = opts.threshold ?? TURF_THRESHOLD;
  return withTenant(tenantId, async (tx) => {
    const hot = await tx.select({ id: neighborhood.id, parcelCount: neighborhood.parcelCount })
      .from(neighborhood)
      .where(and(eq(neighborhood.tenantId, tenantId), gte(neighborhood.turfScore, threshold)));

    let triggered = 0;
    for (const n of hot) {
      const inserted = await tx.insert(mailCampaign).values({
        tenantId, kind: "turf", triggerRef: n.id, audienceCount: n.parcelCount, status: "pending_approval",
      }).onConflictDoNothing({ target: [mailCampaign.tenantId, mailCampaign.kind, mailCampaign.triggerRef] })
        .returning({ id: mailCampaign.id });
      if (inserted[0]) triggered += 1;
    }
    return { triggered };
  });
}
