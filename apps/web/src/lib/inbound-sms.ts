import {
  withTenant, customer, communication, eq, stopDripEnrollments,
} from "@savvy/db";
import { isStopKeyword } from "@savvy/core";
import { inngest } from "@savvy/agents";

/**
 * Handles an inbound SMS for a tenant: logs it, then either (a) STOP keyword ->
 * set sms_opt_out + stop drips (opted_out), or (b) ordinary reply -> stop drips
 * (reply). Matches the sender to a customer by phone. Returns what happened.
 */
export async function handleInboundSms(
  tenantId: string,
  opts: { from: string; body: string; twilioSid?: string },
): Promise<{ matched: boolean; stopped: "opted_out" | "reply" | null }> {
  const reason = isStopKeyword(opts.body) ? "opted_out" : "reply";

  const result = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.select().from(customer).where(eq(customer.phone, opts.from));
    await tx.insert(communication).values({
      tenantId, customerId: c?.id ?? null, channel: "sms", direction: "inbound",
      from: opts.from, body: opts.body, twilioSid: opts.twilioSid ?? null,
    });
    if (!c) return { matched: false as const, stopped: null };
    if (reason === "opted_out") {
      await tx.update(customer).set({ smsOptOut: true }).where(eq(customer.id, c.id));
    }
    const ids = await stopDripEnrollments(tx, { tenantId, customerId: c.id, reason });
    return { matched: true as const, customerId: c.id, stoppedCount: ids.length };
  });

  if (result.matched) {
    await inngest.send({ name: "drip/stop", data: { tenantId, customerId: result.customerId, reason } });
    return { matched: true, stopped: reason };
  }
  return { matched: false, stopped: null };
}
