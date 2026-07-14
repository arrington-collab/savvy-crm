import { withTenant, job, jobStageEvent, user, eq } from "@savvy/db";
import { raceOutcomeRows } from "@savvy/db";
import { raceMetrics } from "@savvy/core";
import { computeVelocity, summarizeRepPerformance } from "@savvy/core";
import { getTenantId } from "./tenant";

// Pipeline throughput queries (velocity + rep performance), re-homed onto the
// Pipeline screen when the Dashboard was retired. Kept in this file to avoid
// churn on the import path; the two Dashboard-only readers were dropped.

export async function getVelocity() {
  const tenantId = await getTenantId();
  const events = await withTenant(tenantId, (tx) =>
    tx
      .select({ jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent),
  );
  return computeVelocity(
    events.map((e) => ({ jobId: e.jobId, toStage: e.toStage ?? "", enteredAt: e.enteredAt })),
  );
}

export async function getRepPerformance() {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        userId: job.assignedUserId,
        name: user.name,
        stage: job.stage,
        valueCents: job.valueEstimate,
        openedAt: job.openedAt,
        closedAt: job.closedAt,
      })
      .from(job)
      .innerJoin(user, eq(user.id, job.assignedUserId)),
  );
  const DAY = 86_400_000;
  return summarizeRepPerformance(
    rows.map((r) => ({
      userId: r.userId!,
      name: r.name,
      stage: r.stage,
      valueCents: r.valueCents ?? 0,
      daysToClose:
        r.openedAt && r.closedAt
          ? (r.closedAt.getTime() - r.openedAt.getTime()) / DAY
          : null,
    })),
  );
}

/** Estimate Experience slice 4: the 60-second rep race, settled with data. */
export async function getRaceMetrics() {
  const tenantId = await getTenantId();
  const rows = await raceOutcomeRows(tenantId);
  return raceMetrics(rows.map((r) => ({ events: r.events, accepted: r.accepted })));
}
