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
