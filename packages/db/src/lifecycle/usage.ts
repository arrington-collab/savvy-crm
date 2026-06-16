import { withTenant } from "../tenant";
import { job } from "../schema/jobs";
import { agentRun } from "../schema/agents";
import { communication } from "../schema/comms";
import { document } from "../schema/ops";
import { tenant } from "../schema/tenancy";
import { usageSnapshot } from "../schema/billing";
import { and, eq, gte, lt, isNull, sql } from "drizzle-orm";
import { getBand, computeBill } from "@savvy/core";
import type { UsageTotals } from "@savvy/core";

/**
 * Computes aggregated usage metrics for a tenant over [start, end).
 * - jobsProcessed: jobs whose openedAt falls within the period
 * - aiSpendCents: sum of agent_run.costCents in the period
 * - aiVoiceMinutes: floor(sum of communication.durationSeconds where channel='call' / 60)
 * - storageBytes: sum of document.sizeBytes where archivedAt IS NULL (active storage only)
 */
export async function computeTenantUsage(tenantId: string, start: Date, end: Date): Promise<UsageTotals> {
  return withTenant(tenantId, async (tx) => {
    const [jobs] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(job)
      .where(and(gte(job.openedAt, start), lt(job.openedAt, end)));

    const [ai] = await tx
      .select({ c: sql<number>`coalesce(sum(${agentRun.costCents}),0)::int` })
      .from(agentRun)
      .where(and(gte(agentRun.startedAt, start), lt(agentRun.startedAt, end)));

    const [voice] = await tx
      .select({ s: sql<number>`coalesce(sum(${communication.durationSeconds}),0)::int` })
      .from(communication)
      .where(and(eq(communication.channel, "call"), gte(communication.createdAt, start), lt(communication.createdAt, end)));

    const [stor] = await tx
      .select({ b: sql<number>`coalesce(sum(${document.sizeBytes}),0)::bigint` })
      .from(document)
      .where(isNull(document.archivedAt));

    return {
      jobsProcessed: jobs?.n ?? 0,
      aiSpendCents: ai?.c ?? 0,
      aiVoiceMinutes: Math.floor((voice?.s ?? 0) / 60),
      storageBytes: Number(stor?.b ?? 0),
    };
  });
}

function periodBounds(periodKey: string): { start: Date; end: Date } {
  const [y, m] = periodKey.split("-").map(Number);
  return { start: new Date(Date.UTC(y!, m! - 1, 1)), end: new Date(Date.UTC(y!, m!, 1)) };
}

/**
 * Computes usage for the given month period, resolves the billing band from
 * tenant.revenueBand, runs computeBill, then upserts a usage_snapshot row
 * on (tenantId, periodKey). Idempotent — safe to re-run for the same period.
 */
export async function recordUsageSnapshot(tenantId: string, periodKey: string) {
  const { start, end } = periodBounds(periodKey);
  const usage = await computeTenantUsage(tenantId, start, end);
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    const band = getBand(t?.revenueBand ?? null);
    const bill = computeBill(usage, band);
    const values = {
      tenantId,
      periodKey,
      jobsProcessed: usage.jobsProcessed,
      aiSpendCents: usage.aiSpendCents,
      aiVoiceMinutes: usage.aiVoiceMinutes,
      storageBytes: usage.storageBytes,
      bandKey: band.key,
      basePriceCents: bill.basePriceCents,
      overageCents: bill.overageTotalCents,
      totalCents: bill.totalCents,
    };
    const [row] = await tx
      .insert(usageSnapshot)
      .values(values)
      .onConflictDoUpdate({
        target: [usageSnapshot.tenantId, usageSnapshot.periodKey],
        set: values,
      })
      .returning();
    return row!;
  });
}
