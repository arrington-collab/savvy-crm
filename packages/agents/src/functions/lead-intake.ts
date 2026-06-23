import { z, signPayloadToken, requireSecret, scoreLeadBaseline, buildLeadFeatures, deriveInstallRecommendation, type LeadFeatures } from "@savvy/core";
import {
  withTenant, lead, customer, property, communication, recordAgentRun, eq,
} from "@savvy/db";
import * as ai from "@savvy/ai";
import { sms, smsFrom, type SmsSender, stormProof as defaultStormProof, type StormProofGateway } from "@savvy/integrations";
import { inngest } from "../client";

const scoreSchema = z.object({ score: z.number().min(0).max(100), reason: z.string().max(200) });

export async function hybridScore(
  features: LeadFeatures,
  aiClient: Pick<typeof ai, "completeObject"> = ai,
): Promise<{ score: number; reason: string; baseline: number; factors: { label: string; points: number }[]; model: string }> {
  const { score: baseline, factors } = scoreLeadBaseline(features);
  const factorText = factors.map((f) => `${f.label} (+${f.points})`).join("; ") || "no strong signals";
  const { object, model } = await aiClient.completeObject({
    capability: "reasoning",
    schema: scoreSchema,
    system: "You refine a roofing lead score. A deterministic baseline and its factors are given. " +
      "Adjust the score only slightly (stay close to the baseline) and write a terse reason citing the factors. Do not invent facts.",
    prompt: `Baseline ${baseline}/100. Factors: ${factorText}. Source=${features.source}. ` +
      `Roof age=${features.roofAgeYears ?? "unknown"}. Return {score, reason}.`,
  });
  const score = Math.max(0, Math.min(100, Math.max(baseline - 10, Math.min(baseline + 10, object.score))));
  return { score, reason: object.reason, baseline, factors, model };
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
    // and persist results in the same durable step so retries are idempotent.
    const enriched = await step.run("enrich-property", async () => {
      const result = await enrichProperty({
        lat: ctx.lat,
        lng: ctx.lng,
        address: ctx.address,
        yearBuilt: ctx.yearBuilt,
        roofType: ctx.roofType,
      });
      await withTenant(tenantId, async (tx) => {
        if (ctx.propertyId) {
          await tx
            .update(property)
            .set({ yearBuilt: result.yearBuilt, roofType: result.roofType, county: result.county })
            .where(eq(property.id, ctx.propertyId));
        }
        await tx
          .update(lead)
          .set({ stormEventId: result.stormEventId })
          .where(eq(lead.id, leadId));
      });
      return result;
    });

    const scored = await step.run("ai-qualify", async () => {
      const features = buildLeadFeatures({
        source: ctx.source,
        state: ctx.state,
        phone: ctx.phone,
        roofType: enriched.roofType,
        yearBuilt: enriched.yearBuilt,
        storm: enriched.storm,
      });
      const r = await hybridScore(features);
      const recommendation = deriveInstallRecommendation(features);
      await withTenant(tenantId, (tx) =>
        tx.update(lead).set({
          score: r.score, scoreReason: r.reason, status: "contacted",
          scoreFeatures: { features, baseline: r.baseline, factors: r.factors },
          installRecommendation: recommendation,
        }).where(eq(lead.id, leadId)),
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
