import { validateEvent, makeEvent, type DomainEvent, type EventType, type PayloadFor } from "./events";
import { subscriptionsFor, type Subscription, type ActionCtx } from "./triggers";
import { evaluateEscalations, type EscalationHit } from "./escalations";
import type { OrchestratorStore } from "./store";

export interface OrchestratorOpts {
  store: OrchestratorStore;
  triggers?: (t: EventType) => Subscription[];
  escalate?: (e: DomainEvent) => EscalationHit[];
}

// Synchronous in-process dispatch. A single FIFO queue drained one event at a
// time keeps per-correlation ordering (an event's children are enqueued behind
// whatever is already queued, and nothing runs concurrently).
export class Orchestrator {
  private readonly store: OrchestratorStore;
  private readonly triggers: (t: EventType) => Subscription[];
  private readonly escalate: (e: DomainEvent) => EscalationHit[];

  constructor(opts: OrchestratorOpts) {
    this.store = opts.store;
    this.triggers = opts.triggers ?? subscriptionsFor;
    this.escalate = opts.escalate ?? evaluateEscalations;
  }

  async publish(input: DomainEvent): Promise<void> {
    const queue: DomainEvent[] = [input];
    while (queue.length > 0) {
      const event = queue.shift()!;
      await this.process(event, queue);
    }
  }

  private async process(event: DomainEvent, queue: DomainEvent[]): Promise<void> {
    // 1. Validate — a malformed event never enters the pipeline.
    const v = validateEvent(event);
    if (!v.ok) {
      await this.store.appendAudit({ event, agent: "system", outcome: "dead_letter", emitted: [], error: v.reason });
      return;
    }

    // 2. Dedupe on (tenant, idempotencyKey).
    const isNew = await this.store.insertEventIfNew(event);
    if (!isNew) return;

    // 3. Record receipt.
    await this.store.appendAudit({ event, agent: "system", outcome: "received", emitted: [] });

    // 4. Run each subscriber in isolation; collect its emits.
    for (const sub of this.triggers(event.type)) {
      const emitted: DomainEvent[] = [];
      // Per-subscriber emit sequence: disambiguates siblings of the same type
      // emitted by the same subscriber (e.g. lead.assigned x2) so they don't
      // collide on (tenantId, idempotencyKey) and get silently deduped.
      let emitSeq = 0;
      const ctx: ActionCtx = {
        emit: <U extends EventType>(type: U, payload: PayloadFor<U>) =>
          emitted.push(makeEvent({
            type, payload, source: "system", tenantId: event.tenantId,
            correlationId: event.correlationId,
            idempotencyKey: `${event.idempotencyKey}>${sub.agent}>${type}#${emitSeq++}`,
          })),
      };
      try {
        await sub.action(event, ctx);
        await this.store.appendAudit({ event, agent: sub.agent, outcome: "handled", emitted: emitted.map((e) => e.type) });
        queue.push(...emitted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.appendAudit({ event, agent: sub.agent, outcome: "dead_letter", emitted: [], error: message });
        queue.push(makeEvent({
          type: "handler.failed",
          payload: { ofType: event.type, agent: sub.agent, error: message },
          source: "system", tenantId: event.tenantId,
          correlationId: event.correlationId,
          idempotencyKey: `${event.idempotencyKey}>fail>${sub.agent}`,
        }));
      }
    }

    // 5. Escalations are evaluated against the event and sunk to the queue.
    for (const hit of this.escalate(event)) {
      await this.store.recordEscalation({
        ...hit, tenantId: event.tenantId, correlationId: event.correlationId,
        eventId: event.id, eventType: event.type,
      });
    }
  }
}
