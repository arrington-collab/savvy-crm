import { z } from "zod";

// The tools that can originate an event. `system` = the orchestrator itself
// (synthesized events like a handler failure).
export type Tool =
  | "savvy" | "canvass" | "alta-estimates"
  | "supplement-iq" | "bloomcam" | "bloom-materials" | "system";

const TOOL = z.enum([
  "savvy", "canvass", "alta-estimates",
  "supplement-iq", "bloomcam", "bloom-materials", "system",
]);

// Per-type payload schemas. Add a new event by adding one entry here; the
// EventType union, PayloadFor map, and validateEvent all derive from it.
const payloadSchemas = {
  "lead.created": z.object({ leadId: z.string(), customerId: z.string(), source: z.string() }),
  "lead.first_touch": z.object({
    leadId: z.string(),
    channel: z.string(),
    locationId: z.string().nullable().optional(),
    latencySeconds: z.number().optional(),
    occurredAtLeadCreated: z.string().optional(),
    slaLatencySeconds: z.number().optional(),
    quietHoursDeferred: z.boolean().optional(),
  }),
  "lead.qualified": z.object({ leadId: z.string(), score: z.number() }),
  "lead.assigned": z.object({
    leadId: z.string(),
    userId: z.string(),
    repId: z.string().optional(),
    locationId: z.string().nullable().optional(),
    territory: z.string().optional(),
  }),
  "contract.signed": z.object({ jobId: z.string(), customerId: z.string(), contractValueCents: z.number().int() }),
  "material.order.created": z.object({ jobId: z.string() }),
  "job.approved": z.object({ jobId: z.string() }),
  "estimate.approved": z.object({ estimateId: z.string(), jobId: z.string(), marginPct: z.number() }),
  "job.completed": z.object({ jobId: z.string() }),
  "invoice.created": z.object({ invoiceId: z.string(), jobId: z.string(), amountCents: z.number().int() }),
  "review.requested": z.object({ jobId: z.string(), customerId: z.string() }),
  "payment.received": z.object({ invoiceId: z.string(), amountCents: z.number() }),
  "invoice.past_due": z.object({ invoiceId: z.string(), daysPastDue: z.number() }),
  "supplement.approved": z.object({ supplementId: z.string(), amountCents: z.number() }),
  "review.posted": z.object({ jobId: z.string(), stars: z.number() }),
  "appointment.set": z.object({
    appointmentId: z.string(),
    leadId: z.string().optional(),
    jobId: z.string().optional(),
    scheduledAt: z.string(),
  }),
  "appointment.no_show": z.object({ appointmentId: z.string(), jobId: z.string().optional() }),
  // system-synthesized: emitted when a subscriber throws.
  "handler.failed": z.object({ ofType: z.string(), agent: z.string(), error: z.string() }),
  // Slice B bridge additions — publishers.ts + later wiring tasks (B2+) emit
  // these onto the same bus so the Command Center read-model can project them.
  "reminder.sent": z.object({
    leadId: z.string(),
    locationId: z.string().nullable().optional(),
    appointmentId: z.string(),
    offset: z.string(),
    channel: z.string(),
  }),
  "drip.step.sent": z.object({
    leadId: z.string().nullable().optional(),
    customerId: z.string(),
    locationId: z.string().nullable().optional(),
    step: z.number(),
    channel: z.string(),
  }),
  "message.inbound": z.object({
    contactId: z.string().nullable().optional(),
    customerId: z.string().nullable().optional(),
    leadId: z.string().nullable().optional(),
    locationId: z.string().nullable().optional(),
    channel: z.string(),
    isOptOut: z.boolean(),
  }),
  "contact.opted_out": z.object({
    contactId: z.string().nullable().optional(),
    customerId: z.string().nullable().optional(),
    locationId: z.string().nullable().optional(),
    channel: z.string(),
    reason: z.string(),
  }),
  "call.missed": z.object({
    leadId: z.string().nullable().optional(),
    locationId: z.string().nullable().optional(),
    fromNumber: z.string(),
    toNumber: z.string(),
  }),
  // Slice B escalation-layer additions (Task B3) — synthesized when the
  // speed-to-lead or assignment agents detect a breach/failure, so the
  // event-driven ESCALATIONS rules in escalations.ts can react to them.
  "lead.sla_breach": z.object({ leadId: z.string(), minutes: z.number() }),
  "lead.assignment_failed": z.object({ leadId: z.string(), reason: z.string() }),
} as const;

export type EventType = keyof typeof payloadSchemas;
export type PayloadFor<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

export interface DomainEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  version: number;
  occurredAt: string; // ISO-8601
  source: Tool;
  correlationId: string;
  idempotencyKey: string;
  actor?: string;
  tenantId: string;
  payload: PayloadFor<T>;
}

const envelope = z.object({
  id: z.string().min(1),
  type: z.string(),
  version: z.number().int().positive(),
  occurredAt: z.string().min(1),
  source: TOOL,
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  actor: z.string().optional(),
  tenantId: z.string().uuid(),
});

// uuid-ish id + timestamp without pulling a dep. crypto.randomUUID is in Node
// 18+ and the browser; both targets have it.
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `evt-${Math.random().toString(36).slice(2)}`;
}

export function makeEvent<T extends EventType>(input: {
  type: T; source: Tool; tenantId: string; correlationId: string;
  idempotencyKey: string; payload: PayloadFor<T>; actor?: string;
  id?: string; occurredAt?: string; version?: number;
}): DomainEvent<T> {
  return {
    id: input.id ?? newId(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: input.source,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    ...(input.actor ? { actor: input.actor } : {}),
    tenantId: input.tenantId,
    payload: input.payload,
  };
}

export function validateEvent(
  e: unknown,
): { ok: true; event: DomainEvent } | { ok: false; reason: string } {
  const env = envelope.safeParse(e);
  if (!env.success) return { ok: false, reason: `envelope: ${env.error.issues[0]?.message ?? "invalid"}` };
  const type = env.data.type;
  if (!(type in payloadSchemas)) return { ok: false, reason: `unknown type "${type}"` };
  const schema = payloadSchemas[type as EventType];
  const payload = schema.safeParse((e as { payload: unknown }).payload);
  if (!payload.success) return { ok: false, reason: `payload: ${payload.error.issues[0]?.message ?? "invalid"}` };
  return { ok: true, event: e as DomainEvent };
}
