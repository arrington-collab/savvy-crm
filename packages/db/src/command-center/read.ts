import { and, eq, gte, lt } from "drizzle-orm";
import type { DomainEvent } from "@savvy/orchestrator";
import { denverDayWindow } from "@savvy/command-center";
import { withTenant } from "../tenant";
import { orchestratorEvent } from "../schema/orchestrator";

// New file — does not edit Day-1's orchestrator store. `orchestrator_event`
// has no `occurred_at` column (Day-1 gap), so the loader uses `created_at`
// (write time) for the Denver-day window. For synchronous Day-1 dispatch,
// write time ≈ occurrence time. If a follow-up task adds `occurred_at`,
// switch the window filter to it.
export async function loadEventsForDay(tenantId: string, businessDate: string): Promise<DomainEvent[]> {
  const { startUtc, endUtc } = denverDayWindow(businessDate);
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(orchestratorEvent).where(and(
      eq(orchestratorEvent.tenantId, tenantId),
      eq(orchestratorEvent.outcome, "received"),
      gte(orchestratorEvent.createdAt, startUtc),
      lt(orchestratorEvent.createdAt, endUtc),
    ));
    return rows.map((r) => ({
      id: r.eventId, type: r.eventType as DomainEvent["type"], version: r.version,
      occurredAt: r.createdAt.toISOString(), source: r.source as DomainEvent["source"],
      correlationId: r.correlationId, idempotencyKey: r.idempotencyKey,
      ...(r.actor ? { actor: r.actor } : {}), tenantId: r.tenantId, payload: (r.payload ?? {}) as never,
    }));
  });
}
