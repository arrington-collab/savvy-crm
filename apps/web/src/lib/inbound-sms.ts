import {
  withTenant, customer, communication, appointment, eq, and, asc, stopDripEnrollments, markCustomerLeadsContacted,
  crewByMemberPhone, setCrewLanguage,
} from "@savvy/db";
import { isStopKeyword, isCancelKeyword, parseLanguageFlip, languageFlipConfirmation } from "@savvy/core";
import { inngest, getTenantSms } from "@savvy/agents";
import { handleSageCommand } from "./sage-remote";

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
): Promise<{ matched: boolean; stopped: "opted_out" | "reply" | null }> {
  // 0) Sage-by-text: a verified owner number short-circuits here (an owner
  //    texting from their cell isn't a customer, so this must precede the
  //    customer match below). Returns null for everyone else → normal handling.
  const sage = await handleSageCommand(tenantId, opts);
  if (sage) {
    try {
      const { sender, from } = await getTenantSms(tenantId);
      await sender.sendSms({ to: opts.from, from, body: sage.reply });
    } catch (e) {
      console.error("sage reply send failed", e);
    }
    return { matched: true, stopped: null };
  }

  // 0b) Slice 3 self-serve flip: a crew member texting "ESPAÑOL"/"ENGLISH" flips
  //     their crew's message language; confirm in the NEW language. Precedes the
  //     customer match (a crew member isn't a customer).
  const flip = parseLanguageFlip(opts.body);
  if (flip) {
    const crew = await crewByMemberPhone(tenantId, opts.from);
    if (crew) {
      await setCrewLanguage(tenantId, crew.crewId, flip);
      try {
        const { sender, from } = await getTenantSms(tenantId);
        await sender.sendSms({ to: opts.from, from, body: languageFlipConfirmation(flip) });
      } catch (e) {
        console.error("crew language flip reply failed", e);
      }
      return { matched: true, stopped: null };
    }
  }

  // 1) Log inbound communication + match customer by phone
  const c = await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(customer).where(eq(customer.phone, opts.from));
    await tx.insert(communication).values({
      tenantId, customerId: row?.id ?? null, channel: "sms", direction: "inbound",
      from: opts.from, body: opts.body, twilioSid: opts.twilioSid ?? null,
    });
    return row ?? null;
  });
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
  }

  return { matched: true, stopped: reason };
}
