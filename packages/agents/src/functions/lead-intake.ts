import { z, signPayloadToken, requireSecret } from "@savvy/core";
import {
  withTenant, lead, customer, property, communication, recordAgentRun, eq,
} from "@savvy/db";
import * as ai from "@savvy/ai";
import { sms, smsFrom, type SmsSender, stormProof as defaultStormProof, type StormProofGateway } from "@savvy/integrations";
import { inngest } from "../client";

const qualifySchema = z.object({ score: z.number().min(0).max(100), reason: z.string().max(200) });

// Pure, unit-testable AI qualification. `aiClient` is injectable for tests.
export async function qualifyLead(
  input: { name: string; address: string; source: string },
  aiClient: Pick<typeof ai, "completeObject"> = ai,
): Promise<{ score: number; reason: string; model: string }> {
  const { object, model } = await aiClient.completeObject({
    capability: "reflex",
    schema: qualifySchema,
    system: "You score roofing leads 0-100 by likelihood to close. Be terse.",
    prompt: `Lead: ${input.name}, ${input.address}, source=${input.source}. Score it.`,
  });
  return { score: object.score, reason: object.reason, model };
}

export function buildBookingSms(opts: { name: string; bookingUrl: string }): string {
  return `Hi ${opts.name}, thanks for reaching out! Book your free roof inspection here: ${opts.bookingUrl}`;
}

// Pure, unit-testable property enrichment. `sp` (StormProof gateway) is injectable for tests.
// Does NOT overwrite yearBuilt or roofType if the rep already entered them.
export async function enrichProperty(
  input: { lat: number | null; lng: number | null; address: string; yearBuilt: number | null; roofType: string | null },
  sp: StormProofGateway = defaultStormProof,
): Promise<{
  yearBuilt: number | null;
  roofType: string | null;
  county: string | null;
  storm: { eventCount: number; maxHailInches: number; maxWindMph: number; daysSinceWorst: number | null };
  stormEventId: string | null;
}> {
  let yearBuilt = input.yearBuilt;
  let roofType = input.roofType;
  let county: string | null = null;

  // Only call getProperty if yearBuilt is missing (don't overwrite rep-entered data)
  if (yearBuilt == null && input.lat != null && input.lng != null) {
    const prop = await sp.getProperty({ lat: input.lat, lng: input.lng, address: input.address });
    if (prop) {
      yearBuilt = prop.yearBuilt ?? yearBuilt;
      roofType = roofType ?? prop.roofType;
      county = prop.county;
    }
  }

  const storms = await sp.lookupStorms({
    lat: input.lat ?? undefined,
    lng: input.lng ?? undefined,
    address: input.address,
    months: 12,
  });

  return {
    yearBuilt,
    roofType,
    county,
    storm: {
      eventCount: storms.eventCount,
      maxHailInches: storms.maxHailInches,
      maxWindMph: storms.maxWindMph,
      daysSinceWorst: storms.daysSinceWorst,
    },
    stormEventId: storms.worstEventId,
  };
}

// Placeholder business-hours check (per-tenant tz comes in Phase 3). Returns
// true outside ~8am-6pm UTC. Deterministic, non-critical for Phase 0.
function isAfterHours(d: Date): boolean {
  const h = d.getUTCHours();
  return h < 8 || h >= 18;
}

export const leadIntake = inngest.createFunction(
  { id: "lead-intake", concurrency: { limit: 5 } },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;

    // Load lead, customer, and property in one DB round-trip.
    // property is nullable on the lead row — guard for the null case.
    const ctx = await step.run("load-lead", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select().from(lead).where(eq(lead.id, leadId));
        const [c] = await tx.select().from(customer).where(eq(customer.id, l!.customerId!));
        let address = "unknown";
        let lat: number | null = null;
        let lng: number | null = null;
        let yearBuilt: number | null = null;
        let roofType: string | null = null;
        let state: string | null = null;
        const propertyId = l!.propertyId ?? null;
        if (propertyId) {
          const [p] = await tx.select().from(property).where(eq(property.id, propertyId));
          if (p) {
            address = p.address;
            lat = p.lat ?? null;
            lng = p.lng ?? null;
            yearBuilt = p.yearBuilt ?? null;
            roofType = p.roofType ?? null;
            state = p.state ?? null;
          }
        }
        return {
          name: c!.name,
          phone: c!.phone ?? "",
          source: l!.source ?? "web",
          address,
          lat,
          lng,
          yearBuilt,
          roofType,
          propertyId,
          state,
        };
      }),
    );

    // Enrich property data from StormProof (year built, county, storm history)
    const enriched = await step.run("enrich-property", () =>
      enrichProperty({
        lat: ctx.lat,
        lng: ctx.lng,
        address: ctx.address,
        yearBuilt: ctx.yearBuilt,
        roofType: ctx.roofType,
      }),
    );

    // Persist enrichment results back to the DB (outside the step closure — I/O after durable step)
    await withTenant(tenantId, async (tx) => {
      if (ctx.propertyId) {
        await tx
          .update(property)
          .set({ yearBuilt: enriched.yearBuilt, roofType: enriched.roofType, county: enriched.county })
          .where(eq(property.id, ctx.propertyId));
      }
      await tx
        .update(lead)
        .set({ stormEventId: enriched.stormEventId })
        .where(eq(lead.id, leadId));
    });

    const scored = await step.run("ai-qualify", async () => {
      const r = await qualifyLead({ name: ctx.name, address: ctx.address, source: ctx.source }, ai);
      await withTenant(tenantId, (tx) =>
        tx.update(lead).set({ score: r.score, scoreReason: r.reason, status: "contacted" }).where(eq(lead.id, leadId)),
      );
      await recordAgentRun({
        tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok",
        modelUsed: r.model, inngestRunId: event.id ?? null,
      });
      return r;
    });

    await step.run("send-sms", async () => {
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
      const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
      const body = buildBookingSms({ name: ctx.name, bookingUrl: `${base}/book/${token}` });
      const sender: SmsSender = sms;
      let sid = "mock";
      try {
        ({ sid } = await sender.sendSms({ to: ctx.phone, from: smsFrom(), body }));
      } catch {
        // No Twilio creds in dev/test — log the comm anyway with a mock sid.
      }
      await withTenant(tenantId, (tx) =>
        tx.insert(communication).values({
          tenantId, channel: "sms", direction: "outbound", to: ctx.phone, body,
          twilioSid: sid, aiHandled: isAfterHours(new Date()),
        }),
      );
      return { sid };
    });

    return { leadId, score: scored.score };
  },
);
