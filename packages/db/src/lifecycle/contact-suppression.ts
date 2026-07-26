import { and, eq, or, inArray } from "drizzle-orm";
import { normalizePhone } from "@savvy/core";
import { withTenant } from "../tenant";
import { contactSuppression } from "../schema/comms-suppression";

// This module is the frozen compliance source of truth (Appendix A.2) — it
// must normalize internally rather than trust callers, so a lookup and a
// prior suppress() of the "same" phone/email always compare equal even if
// they arrived in different casing/formatting.
function normalizeEmail(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase();
}
function normalizeStoredPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  return normalizePhone(phone) ?? phone.trim();
}

// Global opt-out check — every comms agent calls this before sending. Matches
// on ANY of phone/email/contactId (the "key") AND requires the stored row's
// channel to be either the requested channel or "all" (a global opt-out
// blocks every channel). See packages/db/src/schema/comms-suppression.ts.
export async function isSuppressed(a: {
  tenantId: string; contactId?: string; phoneE164?: string; email?: string; channel: "sms" | "email";
}): Promise<boolean> {
  const phoneE164 = normalizeStoredPhone(a.phoneE164);
  const email = normalizeEmail(a.email);
  return withTenant(a.tenantId, async (tx) => {
    const keyMatch = [
      phoneE164 ? eq(contactSuppression.phoneE164, phoneE164) : undefined,
      email ? eq(contactSuppression.email, email) : undefined,
      a.contactId ? eq(contactSuppression.contactId, a.contactId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (keyMatch.length === 0) return false;
    const rows = await tx.select({ id: contactSuppression.id }).from(contactSuppression).where(and(
      eq(contactSuppression.tenantId, a.tenantId),
      inArray(contactSuppression.channel, [a.channel, "all"]),
      or(...keyMatch),
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
  const phoneE164 = normalizeStoredPhone(a.phoneE164);
  const email = normalizeEmail(a.email);
  await withTenant(a.tenantId, async (tx) => {
    await tx.insert(contactSuppression).values({
      tenantId: a.tenantId, locationId: a.locationId ?? null, contactId: a.contactId ?? null,
      phoneE164: phoneE164 ?? null, email: email ?? null, channel: a.channel, reason: a.reason, source: a.source,
    }).onConflictDoNothing();
  });
  // NOTE: emission of `contact.opted_out` is wired in Slice B's bridge (the
  // caller in the inbound webhook emits it); suppress() stays a pure DB write
  // here so it has no orchestrator dependency. (Spec A.2 lists the emit as the
  // suppress side effect; Slice B moves it into publishDomainEvent — flagged.)
}
