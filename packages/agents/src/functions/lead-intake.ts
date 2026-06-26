import { z, signPayloadToken, requireSecret, scoreLead, deriveLane, parseScoringConfig, buildLeadFeatures, deriveInstallRecommendation, parseAssignmentConfig, pickAssignee, resolveRepOrigin, shouldSendChannel, renderTemplate, type LeadFeatures, type ScoringConfig } from "@savvy/core";
import {
  withTenant, lead, customer, property, communication, recordAgentRun, eq, createBookingLink,
  getAssignmentCandidates, getAssignmentSettings, getScoringSettings, setLeadOwner, getRepSameDayAppts, getSchedulingOffice,
  tenant as tenantTbl,
} from "@savvy/db";
import * as ai from "@savvy/ai";
import { sms, smsFrom, type SmsSender, stormProof as defaultStormProof, type StormProofGateway, distance, type LatLng, getEmailSender } from "@savvy/integrations";
import { inngest } from "../client";

const scoreSchema = z.object({ score: z.number().min(0).max(100), reason: z.string().max(200) });

export async function hybridScore(
  features: LeadFeatures,
  cfg: ScoringConfig,
  aiClient: Pick<typeof ai, "completeObject"> = ai,
): Promise<{ score: number; reason: string; baseline: number; band: string; reasons: string[]; model: string }> {
  const scored = scoreLead(features, cfg);
  const baseline = scored.score;
  const factorText = scored.reasons.join("; ") || "no strong signals";
  try {
    const { object, model } = await aiClient.completeObject({
      capability: "reasoning",
      schema: scoreSchema,
      system: "You refine a roofing lead score. A deterministic baseline and its reasons are given. " +
        "Adjust the score only slightly (stay close to the baseline) and write a terse reason citing the factors. Do not invent facts.",
      prompt: `Baseline ${baseline}/100. Reasons: ${factorText}. Source=${features.source}. ` +
        `Roof age=${features.roofAgeYears ?? "unknown"}. Return {score, reason}.`,
    });
    const score = Math.max(0, Math.min(100, Math.max(baseline - 10, Math.min(baseline + 10, object.score))));
    return { score, reason: object.reason, baseline, band: scored.band, reasons: scored.reasons, model };
  } catch (err) {
    // AI refinement is best-effort. If the gateway/model is unavailable (no credits,
    // timeout, outage), keep the deterministic baseline so the lead still gets scored,
    // recommended, assigned, and texted instead of failing the whole intake workflow.
    console.error("hybridScore: AI refine failed, using deterministic baseline:", err instanceof Error ? err.message : err);
    return { score: baseline, reason: factorText, baseline, band: scored.band, reasons: scored.reasons, model: "baseline-fallback" };
  }
}

export function buildAckSms(v: { name: string; bookingUrl: string }): string {
  return renderTemplate("Hi {{name}}, thanks for reaching out! Book your free roof inspection here: {{bookingUrl}}", v);
}
export function buildAckEmail(v: { name: string; bookingUrl: string }): { subject: string; html: string } {
  return {
    subject: "Your free roof inspection",
    html: renderTemplate("<p>Hi {{name}},</p><p>Thanks for reaching out. Book your free roof inspection any time:</p><p><a href=\"{{bookingUrl}}\">{{bookingUrl}}</a></p>", v),
  };
}

// Pure, unit-testable property enrichment. `sp` (StormProof gateway) is injectable for tests.
// Does NOT overwrite yearBuilt or roofType if the rep already entered them.
export async function enrichProperty(
  input: { lat: number | null; lng: number | null; address: string; yearBuilt: number | null; roofType: string | null; county?: string | null },
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
  let county = input.county ?? null;

  // Only call getProperty if yearBuilt is missing (don't overwrite rep-entered data)
  if (yearBuilt == null && input.lat != null && input.lng != null) {
    const prop = await sp.getProperty({ lat: input.lat, lng: input.lng, address: input.address });
    if (prop) {
      yearBuilt = prop.yearBuilt ?? yearBuilt;
      roofType = roofType ?? prop.roofType;
      county = prop.county ?? county;
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

// Opt-in lead assignment. Never overrides a rep who already owns the lead.
// Returns { assigned: userId, reason: "assigned" } on success or a null/reason pair on skip.
export async function runLeadAssignment(
  tenantId: string,
  leadId: string,
  leadCtx: { state: string | null; city: string | null },
): Promise<{ assigned: string | null; reason: string }> {
  const config = parseAssignmentConfig(await getAssignmentSettings(tenantId));
  if (config.strategy === "off") return { assigned: null, reason: "off" };
  return withTenant(tenantId, async (tx) => {
    const [l] = await tx
      .select({ assignedUserId: lead.assignedUserId, score: lead.score, propertyId: lead.propertyId, lane: lead.lane })
      .from(lead)
      .where(eq(lead.id, leadId));
    if (!l) return { assigned: null, reason: "no-lead" };
    if (l.assignedUserId) return { assigned: null, reason: "already-assigned" };

    let candidates = await getAssignmentCandidates(tx, tenantId);
    let lane: string | null = null;

    if (config.strategy === "proximity") {
      // Destination = the lead's property; prefer the persisted lane (set during scoring),
      // fall back to the old inline rule for older leads that predate Phase B.
      const dest = l.propertyId
        ? (await tx.select({ lat: property.lat, lng: property.lng, roofType: property.roofType }).from(property).where(eq(property.id, l.propertyId)))[0]
        : undefined;
      const destPoint: LatLng | null =
        dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;
      lane = l.lane ?? (dest?.roofType === "tile" ? "tile" : null);

      if (destPoint) {
        const now = new Date();
        const office = await getSchedulingOffice(tenantId);
        const apptsByUser = await getRepSameDayAppts(tx, tenantId, now);
        const resolved = candidates.map((c) => ({
          c,
          origin: resolveRepOrigin({
            sameDayAppts: apptsByUser.get(c.userId) ?? [],
            reference: now,
            repBase: c.baseLat != null && c.baseLng != null ? { lat: c.baseLat, lng: c.baseLng } : null,
            tenantOffice: office,
          }),
        }));
        const withOrigin = resolved.filter((r): r is { c: typeof r.c; origin: LatLng } => r.origin != null);
        const matrix = await distance.driveMinutesMatrix(withOrigin.map((r) => r.origin), [destPoint]);
        const dmByUser = new Map<string, number | null>();
        withOrigin.forEach((r, i) => dmByUser.set(r.c.userId, matrix ? (matrix[i]?.[0] ?? null) : null));
        candidates = candidates.map((c) => ({ ...c, driveMinutes: dmByUser.get(c.userId) ?? null }));
      }
    }

    const userId = pickAssignee({
      strategy: config.strategy,
      config,
      candidates,
      lead: { state: leadCtx.state, city: leadCtx.city, score: l.score, lane },
    });
    if (!userId) return { assigned: null, reason: "no-candidate" };
    await setLeadOwner(tx, { tenantId, leadId, userId });
    return { assigned: userId, reason: "assigned" };
  });
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
        let county: string | null = null;
        let city: string | null = null;
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
            county = p.county ?? null;
            city = p.city ?? null;
          }
        }
        return {
          name: c!.name,
          phone: c!.phone ?? "",
          customerId: l!.customerId!,
          source: l!.source ?? "web",
          address,
          lat,
          lng,
          yearBuilt,
          roofType,
          propertyId,
          state,
          county,
          city,
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
        county: ctx.county,
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
        source: ctx.source, state: ctx.state, phone: ctx.phone,
        roofType: enriched.roofType, yearBuilt: enriched.yearBuilt, storm: enriched.storm,
      });
      const cfg = parseScoringConfig(await getScoringSettings(tenantId));
      const r = await hybridScore(features, cfg);
      const lane = deriveLane(features, cfg);
      const recommendation = deriveInstallRecommendation(features);
      await withTenant(tenantId, (tx) =>
        tx.update(lead).set({
          score: r.score, scoreReason: r.reason, scoreBand: r.band, lane, status: "contacted",
          scoreFeatures: { features, baseline: r.baseline, reasons: r.reasons, aiAdjustment: r.score - r.baseline },
          installRecommendation: recommendation,
        }).where(eq(lead.id, leadId)),
      );
      await recordAgentRun({
        tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok",
        modelUsed: r.model, inngestRunId: event.id ?? null,
      });
      return r;
    });

    await step.run("assign-lead", async () => {
      try {
        const r = await runLeadAssignment(tenantId, leadId, { state: ctx.state, city: ctx.city ?? null });
        await recordAgentRun({
          tenantId, agent: "orchestrator", taskKey: "lead.assign",
          status: r.assigned ? "ok" : "skipped", error: r.assigned ? null : r.reason,
        });
        return r;
      } catch (err) {
        await recordAgentRun({
          tenantId, agent: "orchestrator", taskKey: "lead.assign",
          status: "error", error: err instanceof Error ? err.message : "assign failed",
        });
        return { assigned: null, reason: "error" };
      }
    });

    await step.run("send-ack", async () => {
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
      const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
      const code = await createBookingLink({ tenantId, token, expiresAt: new Date(Date.now() + 14 * 86400000) });
      const bookingUrl = `${base}/b/${code}`;
      const vars = { name: ctx.name, bookingUrl };

      const cust = await withTenant(tenantId, async (tx) => {
        const [row] = await tx.select({
          email: customer.email, smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
          gmail: tenantTbl.settings,
        }).from(customer).leftJoin(tenantTbl, eq(tenantTbl.id, customer.tenantId)).where(eq(customer.id, ctx.customerId));
        return row ?? null;
      });
      if (!cust) return { skipped: "no-customer" };

      // SMS ack (transactional — quiet-hours EXEMPT), gated by consent + opt-out.
      if (ctx.phone && shouldSendChannel("sms", { smsOptOut: cust.smsOptOut, emailOptOut: cust.emailOptOut, smsConsentAt: cust.smsConsentAt })) {
        let sid = "mock";
        try { ({ sid } = await (sms as SmsSender).sendSms({ to: ctx.phone, from: smsFrom(), body: buildAckSms(vars) })); } catch { /* dev: no creds */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({
          tenantId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body: buildAckSms(vars), twilioSid: sid, aiHandled: false,
        }));
      }
      // Email ack, gated by opt-out.
      if (cust.email && shouldSendChannel("email", { smsOptOut: cust.smsOptOut, emailOptOut: cust.emailOptOut, smsConsentAt: cust.smsConsentAt })) {
        const sender = getEmailSender({ gmailConnectionId: null });
        const { subject, html } = buildAckEmail(vars);
        try { await sender.sendEmail({ to: cust.email, from: process.env.RESEND_FROM ?? "noreply@savvy.app", subject, html }); } catch { /* dev: no creds */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({
          tenantId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: cust.email, body: subject, aiHandled: false,
        }));
      }
      return { ok: true };
    });

    return { leadId, score: scored.score };
  },
);
