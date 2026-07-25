import type { DomainEvent, EventType, PayloadFor } from "./events";

export type Agent = "orchestrator" | "comms" | "scheduling" | "finance" | "claims";

export interface ActionCtx {
  emit: <T extends EventType>(type: T, payload: PayloadFor<T>) => void;
}

export type Action = (event: DomainEvent, ctx: ActionCtx) => Promise<void> | void;

export interface Subscription {
  event: EventType;
  agent: Agent;
  action: Action;
}

// STUB agent actions — Day 1 emits the follow-on events (the choreography) but
// contains no real business logic. Real handlers land on later days.
export const TRIGGERS: Subscription[] = [
  {
    event: "lead.created", agent: "comms",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"lead.created">;
      ctx.emit("lead.first_touch", { leadId: p.leadId, channel: "sms" });
    },
  },
  {
    event: "lead.created", agent: "orchestrator",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"lead.created">;
      ctx.emit("lead.qualified", { leadId: p.leadId, score: 80 });
      ctx.emit("lead.assigned", { leadId: p.leadId, userId: "auto" });
    },
  },
  {
    event: "contract.signed", agent: "scheduling",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"contract.signed">;
      ctx.emit("material.order.created", { jobId: p.jobId });
    },
  },
  {
    event: "contract.signed", agent: "orchestrator",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"contract.signed">;
      ctx.emit("job.approved", { jobId: p.jobId });
    },
  },
  {
    // Finance guardrail. Escalation is data (see escalations.ts) — the action
    // just acknowledges; a low margin is caught by the rule, not here.
    event: "estimate.approved", agent: "finance",
    action: () => {},
  },
  {
    event: "job.completed", agent: "comms",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"job.completed">;
      ctx.emit("review.requested", { jobId: p.jobId, customerId: "unknown" });
    },
  },
  {
    event: "job.completed", agent: "finance",
    action: (e, ctx) => {
      const p = e.payload as PayloadFor<"job.completed">;
      // amountCents is a stub placeholder — no real invoice amount is known at
      // job.completed time; finance later reconciles the real figure.
      ctx.emit("invoice.created", { invoiceId: `inv-${p.jobId}`, jobId: p.jobId, amountCents: 0 });
    },
  },
  {
    event: "payment.received", agent: "finance",
    action: () => {}, // reconcile + close; routine, emits nothing on Day 1
  },
  {
    event: "invoice.past_due", agent: "finance",
    action: () => {}, // dunning; escalation at 90 days is a rule
  },
  {
    event: "review.posted", agent: "comms",
    action: () => {}, // referral ask or escalation (negative-review rule)
  },
  // Follow-on event subscribers (terminal handlers). Routine end-of-chain
  // acknowledgements, like payment.received (no follow-on emits).
  {
    event: "lead.first_touch", agent: "comms",
    action: () => {}, // send initial message
  },
  {
    event: "material.order.created", agent: "orchestrator",
    action: () => {}, // track order lifecycle
  },
  {
    event: "job.approved", agent: "orchestrator",
    action: () => {}, // broadcast approval
  },
  {
    event: "invoice.created", agent: "finance",
    action: () => {}, // track payment lifecycle
  },
  {
    event: "review.requested", agent: "comms",
    action: () => {}, // send review request
  },
];

export function subscriptionsFor(type: EventType): Subscription[] {
  return TRIGGERS.filter((s) => s.event === type);
}

// (event, agent) must be unique across the registry. The engine derives each
// emitted child's idempotencyKey from a PER-SUBSCRIBER emitSeq
// (`${parentIdem}>${agent}>${type}#${emitSeq}`), so two subscriptions on the
// same (event, agent) emitting the same child type would mint colliding keys
// and the second would be silently dedupe-dropped. Enforce it at module load
// so a future contributor can't reintroduce the collision unnoticed.
export function assertUniqueSubscriptions(subs: readonly Subscription[]): void {
  const seen = new Set<string>();
  for (const s of subs) {
    const key = `${s.event} ${s.agent}`;
    if (seen.has(key)) {
      throw new Error(`duplicate subscription for (${s.event}, ${s.agent}) — (event, agent) must be unique`);
    }
    seen.add(key);
  }
}

assertUniqueSubscriptions(TRIGGERS);
