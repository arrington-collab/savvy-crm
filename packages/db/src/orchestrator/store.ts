import { and, eq, sql } from "drizzle-orm";
import type { OrchestratorStore, AuditRecord, EscalationRecord } from "@savvy/orchestrator";
import type { DomainEvent } from "@savvy/orchestrator";
import { withTenant } from "../tenant";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";

// Drizzle-backed store. Every write goes through withTenant so RLS is enforced
// on the app connection. insertEventIfNew leans on the partial unique index
// (outcome='received') — a duplicate receipt violates it and returns false.
export class DrizzleOrchestratorStore implements OrchestratorStore {
  async insertEventIfNew(e: DomainEvent): Promise<boolean> {
    return withTenant(e.tenantId, async (tx) => {
      const rows = await tx.insert(orchestratorEvent).values({
        tenantId: e.tenantId, eventId: e.id, eventType: e.type, version: e.version,
        source: e.source, correlationId: e.correlationId, idempotencyKey: e.idempotencyKey,
        actor: e.actor ?? null, agent: "system", outcome: "received",
        emitted: [], payload: e.payload as Record<string, unknown>,
      }).onConflictDoNothing({ target: [orchestratorEvent.tenantId, orchestratorEvent.idempotencyKey], where: sql`outcome = 'received'` }).returning({ id: orchestratorEvent.id });
      return rows.length > 0;
    });
  }

  async appendAudit(r: AuditRecord): Promise<void> {
    // The "received" outcome is written by insertEventIfNew; skip it here so we
    // don't collide with the dedupe index.
    if (r.outcome === "received") return;
    await withTenant(r.event.tenantId, async (tx) => {
      await tx.insert(orchestratorEvent).values({
        tenantId: r.event.tenantId, eventId: r.event.id, eventType: r.event.type, version: r.event.version,
        source: r.event.source, correlationId: r.event.correlationId, idempotencyKey: r.event.idempotencyKey,
        actor: r.event.actor ?? null, agent: r.agent, outcome: r.outcome,
        emitted: r.emitted, error: r.error ?? null, payload: r.event.payload as Record<string, unknown>,
      });
    });
  }

  async recordEscalation(r: EscalationRecord): Promise<void> {
    await withTenant(r.tenantId, async (tx) => {
      await tx.insert(orchestratorEscalation).values({
        tenantId: r.tenantId, ruleId: r.ruleId, severity: r.severity, reason: r.reason,
        notify: r.notify, eventId: r.eventId, eventType: r.eventType, correlationId: r.correlationId,
      });
    });
  }

  async traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]> {
    return withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(orchestratorEvent)
        .where(and(eq(orchestratorEvent.tenantId, tenantId), eq(orchestratorEvent.correlationId, correlationId)));
      return rows.map((row) => ({
        event: {
          id: row.eventId, type: row.eventType as DomainEvent["type"], version: row.version,
          occurredAt: row.createdAt.toISOString(), source: row.source as DomainEvent["source"],
          correlationId: row.correlationId, idempotencyKey: row.idempotencyKey,
          ...(row.actor ? { actor: row.actor } : {}), tenantId: row.tenantId,
          payload: (row.payload ?? {}) as never,
        },
        agent: row.agent,
        outcome: row.outcome as AuditRecord["outcome"],
        emitted: row.emitted,
        ...(row.error ? { error: row.error } : {}),
      }));
    });
  }

  async listEscalations(tenantId: string): Promise<EscalationRecord[]> {
    return withTenant(tenantId, async (tx) => {
      const rows = await tx.select().from(orchestratorEscalation)
        .where(eq(orchestratorEscalation.tenantId, tenantId));
      return rows.map((row) => ({
        tenantId: row.tenantId, correlationId: row.correlationId, eventId: row.eventId,
        eventType: row.eventType, ruleId: row.ruleId,
        severity: row.severity as EscalationRecord["severity"], reason: row.reason, notify: row.notify,
      }));
    });
  }
}
