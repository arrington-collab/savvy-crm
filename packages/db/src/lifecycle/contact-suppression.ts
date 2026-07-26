import { and, eq, or, inArray } from "drizzle-orm";
import { withTenant } from "../tenant";
import { contactSuppression } from "../schema/comms-suppression";

// Global opt-out check — every comms agent calls this before sending. Matches
// on ANY of phone/email/contactId (the "key") AND requires the stored row's
// channel to be either the requested channel or "all" (a global opt-out
// blocks every channel). See packages/db/src/schema/comms-suppression.ts.
export async function isSuppressed(a: {
  tenantId: string; contactId?: string; phoneE164?: string; email?: string; channel: "sms" | "email";
}): Promise<boolean> {
  return withTenant(a.tenantId, async (tx) => {
    const keyMatch = [
      a.phoneE164 ? eq(contactSuppression.phoneE164, a.phoneE164) : undefined,
      a.email ? eq(contactSuppression.email, a.email) : undefined,
      a.contactId ? eq(contactSuppression.contactId, a.contactId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (keyMatch.length === 0) return false;
    const rows = await tx.select({ id: contactSuppression.id }).from(contactSuppression).where(and(
      eq(contactSuppression.tenantId, a.tenantId),
      inArray(contactSuppression.channel, [a.channel, "all"]),
      or(...(keyMatch as [typeof keyMatch[number], ...typeof keyMatch])),
    )).limit(1);
    return rows.length > 0;
  });
}

// Records a suppression. Idempotent: re-suppressing the same (tenant, key,
// channel) is a no-op thanks to the two partial unique indexes on
// contact_suppression (phone+channel, email+channel). onConflictDoNothing()
// with no target covers a conflict on EITHER partial index in one statement,
// which matters here because a single call may set phone, email, or both.
export async function suppress(a: {
  tenantId: string; locationId?: string; contactId?: string; phoneE164?: string; email?: string;
  channel: "sms" | "email" | "all"; reason: "stop" | "manual" | "bounce" | "complaint"; source: string;
}): Promise<void> {
  await withTenant(a.tenantId, async (tx) => {
    await tx.insert(contactSuppression).values({
      tenantId: a.tenantId, locationId: a.locationId ?? null, contactId: a.contactId ?? null,
      phoneE164: a.phoneE164 ?? null, email: a.email ?? null, channel: a.channel, reason: a.reason, source: a.source,
    }).onConflictDoNothing();
  });
  // NOTE: emission of `contact.opted_out` is wired in Slice B's bridge (the
  // caller in the inbound webhook emits it); suppress() stays a pure DB write
  // here so it has no orchestrator dependency. (Spec A.2 lists the emit as the
  // suppress side effect; Slice B moves it into publishDomainEvent — flagged.)
}
