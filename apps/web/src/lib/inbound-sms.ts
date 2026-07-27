import {
  withTenant, customer, communication, appointment, eq, and, asc, stopDripEnrollments, markCustomerLeadsContacted,
  createMoveLeadOnReply, DrizzleOrchestratorStore, matchCustomerByPhone,
} from "@savvy/db";
import { isStopKeyword, isCancelKeyword } from "@savvy/core";
import { inngest } from "@savvy/agents";
import type { OrchestratorStore } from "@savvy/orchestrator";
import { publishDomainEvent, makeEvent } from "@savvy/orchestrator";

// --- Slice B bridge helper ------------------------------------------------
// Pure, DB-free (given a store) so it's unit-testable with an InMemoryStore.
// Publishes onto the domain-event bus for EVERY inbound SMS (matched or not —
// customerId is nullable on the payload) so the Command Center read-model can
// project it, regardless of whether the reply matched an existing customer.
export async function bridgeMessageInbound(
  store: OrchestratorStore,
  a: { tenantId: string; messageSid: string; customerId: string | null; isOptOut: boolean },
): Promise<void> {
  await publishDomainEvent(store, makeEvent({
    type: "message.inbound", source: "savvy", tenantId: a.tenantId,
    correlationId: a.customerId ?? a.messageSid,
    idempotencyKey: `message.inbound:${a.messageSid}`,
    payload: { customerId: a.customerId, channel: "sms", isOptOut: a.isOptOut },
  }));
}

/**
 * Handles an inbound SMS for a tenant:
 *  1. Logs the inbound communication + matches sender to a customer by phone.
 *  2. If body is "CANCEL" and the customer has an upcoming scheduled appointment,
 *     cancel that appointment and emit `appointment/changed` — no opt-out, no drip stop.
 *     If CANCEL but no upcoming appointment, falls through to ordinary reply behavior.
 *  3. STOP/UNSUBSCRIBE -> opt out + stop drips. Any other reply -> stop drips (reply).
 */
export async function handleInboundSms(
  tenantId: string,
  opts: { from: string; body: string; twilioSid?: string },
  deps: { store?: OrchestratorStore } = {},
): Promise<{ matched: boolean; stopped: "opted_out" | "reply" | null }> {
  const store = deps.store ?? new DrizzleOrchestratorStore();

  // 1) Log inbound communication + match customer by phone
  const c = await withTenant(tenantId, async (tx) => {
    const row = await matchCustomerByPhone(tx, opts.from);
    await tx.insert(communication).values({
      tenantId, customerId: row?.id ?? null, channel: "sms", direction: "inbound",
      from: opts.from, body: opts.body, twilioSid: opts.twilioSid ?? null,
    });
    return row ?? null;
  });

  // Slice B bridge: publish message.inbound regardless of match. Fail-soft —
  // a publish error must never block the inbound reply flow below.
  try {
    const messageSid = opts.twilioSid ?? `no-sid-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    await bridgeMessageInbound(store, {
      tenantId, messageSid, customerId: c?.id ?? null, isOptOut: isStopKeyword(opts.body),
    });
  } catch (e) { console.error("bridge-message-inbound: failed to publish message.inbound", e); }

  if (!c) return { matched: false, stopped: null };

  // 2) CANCEL -> cancel next upcoming scheduled appointment (no opt-out, no drip stop)
  if (isCancelKeyword(opts.body)) {
    const canceledId = await withTenant(tenantId, async (tx) => {
      const [next] = await tx.select().from(appointment)
        .where(and(eq(appointment.customerId, c.id), eq(appointment.status, "scheduled")))
        .orderBy(asc(appointment.startsAt)).limit(1);
      if (!next) return null;
      await tx.update(appointment).set({ status: "canceled" }).where(eq(appointment.id, next.id));
      return next.id;
    });
    if (canceledId) {
      try {
        await inngest.send({ name: "appointment/changed", data: { tenantId, appointmentId: canceledId, reason: "canceled" } });
      } catch (e) { console.error("inngest.send failed", e); }
      return { matched: true, stopped: null };
    }
    // No upcoming appointment — fall through to ordinary reply handling below
  }

  // 3) STOP/UNSUBSCRIBE -> opt out; ordinary reply -> stop drips (reply)
  const reason: "opted_out" | "reply" = isStopKeyword(opts.body) ? "opted_out" : "reply";
  await withTenant(tenantId, async (tx) => {
    if (reason === "opted_out") {
      await tx.update(customer).set({ smsOptOut: true }).where(eq(customer.id, c.id));
    }
    await stopDripEnrollments(tx, { tenantId, customerId: c.id, reason });
  });
  try {
    await inngest.send({ name: "drip/stop", data: { tenantId, customerId: c.id, reason } });
  } catch (e) { console.error("inngest.send failed", e); }

  // A customer reply counts as first contact — record it + cancel SLA/cadence.
  if (reason === "reply") {
    const leadIds = await withTenant(tenantId, (tx) => markCustomerLeadsContacted(tx, { tenantId, customerId: c.id }));
    for (const leadId of leadIds) {
      try { await inngest.send({ name: "lead/contacted", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    }

    // Customer for Life Play A: a reply to the recent move-play text converts —
    // one lead at the customer's new address (deduped per move event).
    try {
      const move = await createMoveLeadOnReply(tenantId, c.id);
      if (move.leadId) {
        await inngest.send({ name: "lead/created", data: { leadId: move.leadId, tenantId } });
      }
    } catch (e) { console.error("move-play lead creation failed", e); }
  }

  return { matched: true, stopped: reason };
}
