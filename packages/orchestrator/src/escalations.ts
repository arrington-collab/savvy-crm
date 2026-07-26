import type { DomainEvent, EventType, PayloadFor } from "./events";
import type { EscalationRecord } from "./store";

export type Severity = "low" | "medium" | "high";

export interface EscalationRule {
  id: string;
  event: EventType;
  severity: Severity;
  notify: string[];
  when: (e: DomainEvent) => boolean;
  reason: (e: DomainEvent) => string;
}

export interface EscalationHit {
  ruleId: string;
  severity: Severity;
  reason: string;
  notify: string[];
}

// Rules are DATA — tune a threshold or add a rule without touching the engine.
export const ESCALATIONS: EscalationRule[] = [
  {
    id: "low-margin", event: "estimate.approved", severity: "high",
    notify: ["sales-manager", "arrington"],
    when: (e) => (e.payload as PayloadFor<"estimate.approved">).marginPct < 25,
    reason: (e) => `estimate margin ${(e.payload as PayloadFor<"estimate.approved">).marginPct}% below 25% floor`,
  },
  {
    id: "collections-90", event: "invoice.past_due", severity: "high",
    notify: ["admin", "arrington"],
    when: (e) => (e.payload as PayloadFor<"invoice.past_due">).daysPastDue >= 90,
    reason: (e) => `invoice ${(e.payload as PayloadFor<"invoice.past_due">).daysPastDue} days past due`,
  },
  {
    id: "negative-review", event: "review.posted", severity: "high",
    notify: ["manager"],
    when: (e) => (e.payload as PayloadFor<"review.posted">).stars <= 3,
    reason: (e) => `${(e.payload as PayloadFor<"review.posted">).stars}-star review posted`,
  },
  {
    id: "supplement-denied", event: "supplement.approved", severity: "medium",
    notify: ["claims"],
    when: (e) => (e.payload as PayloadFor<"supplement.approved">).amountCents <= 0,
    reason: () => `supplement denied / zero amount`,
  },
  {
    id: "handler-failure", event: "handler.failed", severity: "high",
    notify: ["eng-oncall"],
    when: () => true,
    reason: (e) => {
      const p = e.payload as PayloadFor<"handler.failed">;
      return `${p.agent} handler for ${p.ofType} threw: ${p.error}`;
    },
  },
  {
    id: "speed-to-lead-breach", event: "lead.sla_breach", severity: "high",
    notify: ["sales-manager", "arrington"],
    when: () => true,
    reason: (e) => `lead ${(e.payload as PayloadFor<"lead.sla_breach">).leadId} breached speed-to-lead SLA by ${(e.payload as PayloadFor<"lead.sla_breach">).minutes}m`,
  },
  {
    id: "assignment-failure", event: "lead.assignment_failed", severity: "medium",
    notify: ["admin", "arrington"],
    when: () => true,
    reason: (e) => `lead ${(e.payload as PayloadFor<"lead.assignment_failed">).leadId} failed to assign: ${(e.payload as PayloadFor<"lead.assignment_failed">).reason}`,
  },
];

export function evaluateEscalations(e: DomainEvent): EscalationHit[] {
  return ESCALATIONS
    .filter((r) => r.event === e.type && r.when(e))
    .map((r) => ({ ruleId: r.id, severity: r.severity, reason: r.reason(e), notify: r.notify }));
}

// compliance-block is NOT event-driven: it's raised directly from a guardedSms
// verdict (a blocked send is never a DomainEvent on the bus), so it has no
// entry in ESCALATIONS — this constructor builds the EscalationRecord in place
// of evaluateEscalations for that one caller.
export function makeComplianceBlock(input: {
  tenantId: string; correlationId: string; eventId: string; eventType: string; reason: string; notify?: string[];
}): EscalationRecord {
  return {
    ruleId: "compliance-block",
    severity: "high",
    reason: `SMS blocked: ${input.reason}`,
    notify: input.notify ?? [],
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    eventId: input.eventId,
    eventType: input.eventType,
  };
}
