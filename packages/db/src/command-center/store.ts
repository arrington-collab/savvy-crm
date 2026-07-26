import { and, eq } from "drizzle-orm";
import type { DailyMetrics, QueueItem } from "@savvy/command-center";
import { withTenant } from "../tenant";
import { dailyMetrics, exceptionQueue } from "../schema/command-center";
export { loadEventsForDay } from "./read";

export async function upsertDailyMetrics(tenantId: string, m: DailyMetrics): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(dailyMetrics).values({ tenantId, businessDate: m.businessDate, metrics: m as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: [dailyMetrics.tenantId, dailyMetrics.businessDate], set: { metrics: m as unknown as Record<string, unknown>, generatedAt: new Date() } });
  });
}

export async function getDailyMetrics(tenantId: string, businessDate: string): Promise<DailyMetrics | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(dailyMetrics).where(and(eq(dailyMetrics.tenantId, tenantId), eq(dailyMetrics.businessDate, businessDate)));
    return row ? (row.metrics as unknown as DailyMetrics) : null;
  });
}

// QueueItem (reshaped in Task 5) has no escalationId/idempotencyKey — it has
// eventId + ruleId directly, mirrored 1:1 by the exception_queue columns
// (event_id added in Task 8). Do not split escalation_key to recover fields.
export async function upsertQueueItem(tenantId: string, it: QueueItem): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(exceptionQueue).values({
      tenantId, escalationKey: it.key, ruleId: it.ruleId, eventId: it.eventId, severity: it.severity, reason: it.reason,
      notify: it.notify, assignee: it.assignee, state: it.state,
      createdAt: new Date(it.createdAt),
      acknowledgedAt: it.acknowledgedAt ? new Date(it.acknowledgedAt) : null,
      resolvedAt: it.resolvedAt ? new Date(it.resolvedAt) : null,
      resolutionNote: it.resolutionNote, snoozeUntil: it.snoozeUntil ? new Date(it.snoozeUntil) : null,
    }).onConflictDoUpdate({ target: [exceptionQueue.tenantId, exceptionQueue.escalationKey], set: {
      state: it.state, assignee: it.assignee,
      acknowledgedAt: it.acknowledgedAt ? new Date(it.acknowledgedAt) : null,
      resolvedAt: it.resolvedAt ? new Date(it.resolvedAt) : null,
      resolutionNote: it.resolutionNote, snoozeUntil: it.snoozeUntil ? new Date(it.snoozeUntil) : null,
    } });
  });
}

export async function listQueue(tenantId: string): Promise<QueueItem[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
    return rows.map((r) => ({
      key: r.escalationKey, ruleId: r.ruleId, eventId: r.eventId, severity: r.severity,
      reason: r.reason, notify: r.notify, assignee: r.assignee, state: r.state as QueueItem["state"],
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null, resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionNote: r.resolutionNote ?? null, snoozeUntil: r.snoozeUntil?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
