import { adminDb, withTenant, lead, customer, property, tenant, eq, recordAgentRun } from "@savvy/db";
import { buildAssistantOverrides, shouldPlaceVoiceCall, parseFinanceConfig, parseLeadCadenceConfig } from "@savvy/core";
import { inngest } from "../client";
import { getTenantVoice } from "../telephony";

/**
 * Builds the storm-context string from a lead's scoreFeatures jsonb field.
 * Returns null when no storm data is present.
 * Pure / no DB — exported for unit testing.
 */
export function formatVoiceStormContext(scoreFeatures: unknown): string | null {
  const sf = scoreFeatures as { storm?: { maxHailInches?: number; maxWindMph?: number } } | null;
  const storm = sf?.storm;
  if (!storm || (!storm.maxHailInches && !storm.maxWindMph)) return null;
  const parts: string[] = [];
  if (storm.maxHailInches) parts.push(`${storm.maxHailInches}" hail`);
  if (storm.maxWindMph) parts.push(`${storm.maxWindMph} mph wind`);
  return parts.join(", ");
}

/**
 * Maps the place-call result to a run-status pair.
 * Pure / no DB — exported for unit testing.
 */
export function voiceRunOutcome(result: { callId: string } | null): { status: "ok" | "skipped"; error: string | null } {
  return result ? { status: "ok", error: null } : { status: "skipped", error: "no-vapi-key" };
}

export const voiceFallback = inngest.createFunction(
  {
    id: "voice-fallback",
    concurrency: { limit: 5 },
    cancelOn: [{ event: "lead/contacted", match: "data.leadId" }],
  },
  { event: "lead/contact-overdue" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;

    // 1) Load everything + decide the guard in one durable step.
    const decision = await step.run("guard", async () => {
      const [t] = await adminDb.select({ name: tenant.name, settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
      const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;
      const quietHours = parseLeadCadenceConfig((t?.settings as { leadCadence?: unknown } | null)?.leadCadence).quietHours;

      const row = await withTenant(tenantId, async (tx) => {
        const [r] = await tx
          .select({
            status: lead.status, firstRepContactAt: lead.firstRepContactAt, scoreFeatures: lead.scoreFeatures,
            customerId: lead.customerId, leadName: customer.name, phone: customer.phone,
            smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
            address: property.address,
          })
          .from(lead)
          .leftJoin(customer, eq(lead.customerId, customer.id))
          .leftJoin(property, eq(lead.propertyId, property.id))
          .where(eq(lead.id, leadId));
        return r ?? null;
      });
      if (!row) return { ok: false as const, reason: "no-lead" };

      // step.run JSON-serializes Dates to strings — coerce before the guard.
      const firstRepContactAt = row.firstRepContactAt ? new Date(row.firstRepContactAt as unknown as string) : null;
      const smsConsentAt = row.smsConsentAt ? new Date(row.smsConsentAt as unknown as string) : null;
      const verdict = shouldPlaceVoiceCall({
        status: row.status, firstRepContactAt, phone: row.phone ?? null,
        smsOptOut: row.smsOptOut ?? false, emailOptOut: row.emailOptOut ?? false, smsConsentAt,
        now: new Date(), tz, quietHours,
      });
      if (!verdict.ok) return { ok: false as const, reason: verdict.reason };

      const stormContext = formatVoiceStormContext(row.scoreFeatures);

      return {
        ok: true as const,
        tenantName: t?.name ?? "our team",
        leadName: row.leadName ?? "there",
        address: row.address ?? "",
        phone: row.phone!,
        stormContext,
        tz,
      };
    });

    if (!decision.ok) {
      await step.run("record-skip", () =>
        recordAgentRun({ tenantId, agent: "comms", taskKey: "lead.voice.fallback", status: "skipped", error: decision.reason }),
      );
      return { status: "skipped", reason: decision.reason };
    }

    // 2) Place the call — memoized so a retry can't double-dial.
    await step.run("place-call", async () => {
      const overrides = buildAssistantOverrides({
        tenantName: decision.tenantName, leadName: decision.leadName, address: decision.address,
        stormContext: decision.stormContext, leadId, tenantId, tz: decision.tz,
      });
      const gateway = await getTenantVoice(tenantId);
      const result = await gateway.placeOutboundCall({
        toPhone: decision.phone,
        assistantOverrides: overrides,
        metadata: { leadId, tenantId, direction: "outbound", toPhone: decision.phone },
      });
      const outcome = voiceRunOutcome(result);
      await recordAgentRun({
        tenantId, agent: "comms", taskKey: "lead.voice.fallback",
        status: outcome.status, error: outcome.error,
      });
      return { callId: result?.callId ?? null };
    });

    return { status: "placed" };
  },
);
