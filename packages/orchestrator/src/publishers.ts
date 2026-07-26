import { makeEvent } from "./events";
import type { Orchestrator } from "./engine";

// Thin publish() helpers — the seam a real code path (lead intake, contract
// signing, payment webhook) calls to drop a canonical event on the bus. The
// idempotencyKey is derived from the entity so a retried webhook dedupes.

export function publishLeadCreated(
  o: Orchestrator, a: { tenantId: string; leadId: string; customerId: string; source: string; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "lead.created", source: "savvy", tenantId: a.tenantId,
    correlationId: a.leadId, idempotencyKey: `lead.created:${a.leadId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId, customerId: a.customerId, source: a.source },
  }));
}

export function publishContractSigned(
  o: Orchestrator, a: { tenantId: string; jobId: string; customerId: string; contractValueCents: number; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "contract.signed", source: "canvass", tenantId: a.tenantId,
    correlationId: a.jobId, idempotencyKey: `contract.signed:${a.jobId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { jobId: a.jobId, customerId: a.customerId, contractValueCents: a.contractValueCents },
  }));
}

export function publishPaymentReceived(
  o: Orchestrator, a: { tenantId: string; invoiceId: string; amountCents: number; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "payment.received", source: "savvy", tenantId: a.tenantId,
    correlationId: a.invoiceId, idempotencyKey: `payment.received:${a.invoiceId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { invoiceId: a.invoiceId, amountCents: a.amountCents },
  }));
}

// --- Slice B bridge additions ------------------------------------------

export async function publishFirstTouch(
  o: Orchestrator,
  a: { tenantId: string; leadId: string; channel: string; locationId?: string | null; latencySeconds?: number; occurredAtLeadCreated?: string; slaLatencySeconds?: number; quietHoursDeferred?: boolean; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "lead.first_touch",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.leadId,
    idempotencyKey: `lead.first_touch:${a.leadId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId, channel: a.channel, locationId: a.locationId ?? null, latencySeconds: a.latencySeconds, occurredAtLeadCreated: a.occurredAtLeadCreated, slaLatencySeconds: a.slaLatencySeconds, quietHoursDeferred: a.quietHoursDeferred },
  }));
}

export async function publishLeadAssigned(
  o: Orchestrator,
  a: { tenantId: string; leadId: string; userId: string; repId?: string; locationId?: string | null; territory?: string; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "lead.assigned",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.leadId,
    idempotencyKey: `lead.assigned:${a.leadId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId, userId: a.userId, repId: a.repId, locationId: a.locationId ?? null, territory: a.territory },
  }));
}

export async function publishReminderSent(
  o: Orchestrator,
  a: { tenantId: string; leadId: string; appointmentId: string; offset: "24h" | "1h"; channel: string; locationId?: string | null; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "reminder.sent",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.appointmentId,
    idempotencyKey: `reminder.sent:${a.appointmentId}:${a.offset}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId, appointmentId: a.appointmentId, offset: a.offset, channel: a.channel, locationId: a.locationId ?? null },
  }));
}

export async function publishDripStepSent(
  o: Orchestrator,
  a: { tenantId: string; customerId: string; step: number; channel: string; leadId?: string | null; locationId?: string | null; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "drip.step.sent",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.customerId,
    idempotencyKey: `drip.step.sent:${a.customerId}:${a.step}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId ?? null, customerId: a.customerId, locationId: a.locationId ?? null, step: a.step, channel: a.channel },
  }));
}

export async function publishMessageInbound(
  o: Orchestrator,
  a: { tenantId: string; messageSid: string; channel: string; isOptOut: boolean; contactId?: string | null; customerId?: string | null; leadId?: string | null; locationId?: string | null; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "message.inbound",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.messageSid,
    idempotencyKey: `message.inbound:${a.messageSid}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { contactId: a.contactId ?? null, customerId: a.customerId ?? null, leadId: a.leadId ?? null, locationId: a.locationId ?? null, channel: a.channel, isOptOut: a.isOptOut },
  }));
}

export async function publishContactOptedOut(
  o: Orchestrator,
  a: { tenantId: string; channel: string; phoneOrContactId: string; reason: string; contactId?: string | null; customerId?: string | null; locationId?: string | null; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "contact.opted_out",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? a.phoneOrContactId,
    idempotencyKey: `contact.opted_out:${a.channel}:${a.phoneOrContactId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { contactId: a.contactId ?? null, customerId: a.customerId ?? null, locationId: a.locationId ?? null, channel: a.channel, reason: a.reason },
  }));
}

export async function publishCallMissed(
  o: Orchestrator,
  a: { tenantId: string; fromNumber: string; toNumber: string; occurredAt: string; leadId?: string | null; locationId?: string | null; correlationId?: string; actor?: string },
): Promise<void> {
  await o.publish(makeEvent({
    type: "call.missed",
    source: "savvy",
    tenantId: a.tenantId,
    correlationId: a.correlationId ?? `${a.fromNumber}:${a.toNumber}`,
    idempotencyKey: `call.missed:${a.fromNumber}:${a.toNumber}:${a.occurredAt}`,
    occurredAt: a.occurredAt,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId ?? null, locationId: a.locationId ?? null, fromNumber: a.fromNumber, toNumber: a.toNumber },
  }));
}
