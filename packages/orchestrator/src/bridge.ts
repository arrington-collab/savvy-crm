import type { DomainEvent } from "./events";
import { validateEvent } from "./events";
import type { OrchestratorStore, EscalationRecord } from "./store";
import { evaluateEscalations } from "./escalations";

export interface PublishResult {
  published: boolean;
  escalations: EscalationRecord[];
}

/**
 * Thin durable publish for the Inngest bridge. Unlike Orchestrator.publish(),
 * it does NOT run subscriber choreography — the live agent functions ARE the
 * choreography, so re-running subscribers on an Inngest step retry would double
 * -fire agent actions. Contract: validate -> idempotent insert -> record receipt
 * -> record any escalation hits. Idempotency is the Day-1 (tenant_id,
 * idempotency_key) partial unique index; the receipt audit and escalations are
 * only recorded when the event is newly inserted.
 */
export async function publishDomainEvent(
  store: OrchestratorStore,
  event: DomainEvent,
): Promise<PublishResult> {
  const v = validateEvent(event);
  if (!v.ok) return { published: false, escalations: [] };

  const inserted = await store.insertEventIfNew(v.event);
  if (!inserted) return { published: false, escalations: [] };

  // Record receipt so this event shows up in traceByCorrelation like any
  // event processed through Orchestrator.publish() — the bridge skips
  // choreography, not the audit trail.
  await store.appendAudit({ event: v.event, agent: "system", outcome: "received", emitted: [] });

  const hits = evaluateEscalations(v.event);
  const records: EscalationRecord[] = hits.map((h) => ({
    ...h,
    tenantId: v.event.tenantId,
    correlationId: v.event.correlationId,
    eventId: v.event.id,
    eventType: v.event.type,
  }));
  for (const r of records) await store.recordEscalation(r);
  return { published: true, escalations: records };
}
