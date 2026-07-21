import { withTenant, eq, and, createEstimateFromMeasurement, draftLeadEstimateIfReady, resolveEstimateDelivery, applyRepairCreditToEstimate, listJobPhotoNotes, appointment, estimate, measurement, getCurrentPriceBookTx, gateAgentAutomation, withAgentRun } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import { z } from "@savvy/core";
import { inngest } from "../client";

/** Seeded template task that represents "parse the measurement into an estimate". */
const ESTIMATE_TASK_KEY = "estimating-049";

// ---------------------------------------------------------------------------
// AI gateway type — injectable for tests so the AI call can be stubbed without
// needing a live LiteLLM endpoint. Mirrors the qbo-sync / drip pattern where
// dependencies are injected as optional params with real defaults.
// ---------------------------------------------------------------------------
export type AiClient = Pick<typeof import("@savvy/ai"), "completeObject">;

const upsellSchema = z.object({
  suggestions: z.array(z.object({
    name: z.string(),
    reason: z.string(),
    unitPriceCents: z.number().int().min(0),
    quantity: z.number().min(0),
  })),
});

export type UpsellSuggestion = {
  name: string;
  reason: string;
  unitPriceCents: number;
  quantity: number;
};

/**
 * Generates AI upsell suggestions for a measurement using the tenant's
 * upgrade catalog. Returns an empty array on any error (resilient / non-fatal).
 *
 * Exported as a plain async function for test injection without an Inngest
 * harness. The `aiClient` param defaults to the real @savvy/ai module.
 */
export async function generateUpsells(
  tenantId: string,
  measurementId: string,
  aiClient: { completeObject: typeof completeObject } = { completeObject },
  scope?: { jobId?: string },
): Promise<UpsellSuggestion[]> {
  try {
    const [m] = await withTenant(tenantId, (tx) =>
      tx.select().from(measurement).where(eq(measurement.id, measurementId)),
    );
    // Current book only — a bare select would mix live originals with version clones.
    const upgrades = await withTenant(tenantId, async (tx) =>
      (await getCurrentPriceBookTx(tx)).items.filter((i) => i.category === "upgrade" && i.active),
    );

    // Rep's field notes on the job's photos steer which optional upgrades the AI
    // suggests (e.g. "gutters dented" → gutter replacement). Job-scoped; omitted
    // when there's no jobId or no notes.
    const photoNotes = scope?.jobId ? await listJobPhotoNotes(tenantId, scope.jobId) : [];
    const notesLine = photoNotes.length
      ? ` Field notes on inspection photos: ${photoNotes.map((n) => `- ${n}`).join("\n")}.`
      : "";

    const { object } = await aiClient.completeObject({
      capability: "reasoning",
      schema: upsellSchema,
      system:
        "You are a roofing sales assistant. Suggest 0-3 optional upgrade line items a rep could offer. " +
        "Never include core roof items already estimated. Let the rep's field notes on the photos guide relevant upgrades.",
      prompt:
        `Roof measurement: ${JSON.stringify(m?.areas)}. ` +
        `Available upgrade catalog: ${JSON.stringify(upgrades.map((u) => ({ name: u.name, unitPriceCents: u.unitPriceCents })))}.` +
        notesLine,
    });

    return object.suggestions;
  } catch {
    // Non-fatal: AI failure should not block estimate creation.
    return [];
  }
}

/** Enrich a freshly-drafted estimate with AI upsell suggestions (non-fatal). */
async function attachUpsells(tenantId: string, estimateId: string, measurementId: string, scope?: { jobId?: string }): Promise<number> {
  const upsells = await generateUpsells(tenantId, measurementId, undefined, scope);
  await withTenant(tenantId, (tx) =>
    tx.update(estimate).set({ upsellSuggestions: upsells }).where(eq(estimate.id, estimateId)),
  );
  return upsells.length;
}

/**
 * Drafts a job-stage estimate wrapped in a live `agent_run`: opens a `running` row
 * attributed to the job (visible in-flight while the DB work happens), completes it
 * `ok` on success (or `skipped` if there was no measurement to draft from). Not
 * injected via deps — unlike parse-lead-document, this path does real DB I/O and
 * its test uses a real Postgres DB, so it calls `withAgentRun` directly.
 * Return value is identical to `createEstimateFromMeasurement`'s so `if (!est)`
 * callers are unaffected.
 *
 * This is only reached from the legacy job-stage path (the lead-stage path
 * returns earlier via `finishLeadDraft`), so the run is always job-only —
 * `leadId` is explicitly null here rather than implying dual attribution.
 */
export async function draftEstimateWithRun(input: {
  tenantId: string;
  jobId: string;
  measurementId: string;
}): ReturnType<typeof createEstimateFromMeasurement> {
  return withAgentRun(
    { tenantId: input.tenantId, agent: "claims", taskKey: ESTIMATE_TASK_KEY, jobId: input.jobId, leadId: null },
    () => createEstimateFromMeasurement({ tenantId: input.tenantId, measurementId: input.measurementId, jobId: input.jobId }),
    { resolve: (est) => (est ? { status: "ok" } : { status: "skipped" }) },
  );
}

/**
 * Inngest function: drafts a lead's estimate once the inspection is complete AND a
 * measurement (Roofr or DIY — first data wins) has landed. Fired by BOTH
 * `measurement/ready` and `appointment/completed`, so whichever lands last triggers
 * the (idempotent, draft-once) generation. The legacy job-stage path (measurement/ready
 * carrying a jobId, no leadId) still drafts immediately behind the automation gate.
 * Upsell suggestions are advisory only — never added to totals.
 */
export const generateEstimateOnMeasurement = inngest.createFunction(
  { id: "generate-estimate-on-measurement", concurrency: { limit: 5 }, retries: 2 },
  [{ event: "measurement/ready" }, { event: "appointment/completed" }],
  async ({ event, step }) => {
    // After a lead-stage draft: attach upsells, then either auto-send or park for
    // approval based on the tenant threshold. Shared by both trigger events.
    const finishLeadDraft = async (
      tenantId: string,
      res: { estimateId: string; measurementId: string },
    ) => {
      // Roof Record: an active repair credit lands on the fresh draft as a
      // visible line (repair.credit_applied — no replacement estimate omits it).
      await step.run("apply-repair-credit", () => applyRepairCreditToEstimate({ tenantId, estimateId: res.estimateId }));
      const upsells = await step.run("upsell", () => attachUpsells(tenantId, res.estimateId, res.measurementId));
      const delivery = await step.run("delivery", () => resolveEstimateDelivery({ tenantId, estimateId: res.estimateId }));
      if (delivery.action === "send") {
        await step.sendEvent("send-estimate", { name: "estimate/send.requested", data: { tenantId, estimateId: res.estimateId } });
      }
      return { estimateId: res.estimateId, upsells, delivery: delivery.action };
    };

    // --- appointment/completed: resolve the inspection's lead, then gated draft ---
    if (event.name === "appointment/completed") {
      const { tenantId, appointmentId } = event.data;
      const leadId = await step.run("resolve-inspection-lead", () =>
        withTenant(tenantId, async (tx) => {
          const [a] = await tx
            .select({ leadId: appointment.leadId })
            .from(appointment)
            .where(and(eq(appointment.id, appointmentId), eq(appointment.type, "inspection")));
          return a?.leadId ?? null;
        }),
      );
      if (!leadId) return { skipped: "not_lead_inspection" };
      const res = await step.run("draft", () => draftLeadEstimateIfReady({ tenantId, leadId }));
      if (!("estimateId" in res)) return res;
      return finishLeadDraft(tenantId, res);
    }

    // --- measurement/ready ---
    if (event.name !== "measurement/ready") return { skipped: "unhandled_event" };
    const { tenantId, jobId, leadId, measurementId } = event.data;

    // Lead-stage: gated + draft-once (waits for inspection completion too).
    if (leadId) {
      const res = await step.run("draft", () => draftLeadEstimateIfReady({ tenantId, leadId }));
      if (!("estimateId" in res)) return res;
      return finishLeadDraft(tenantId, res);
    }

    // Legacy job-stage path: draft immediately behind the automation gate.
    if (!jobId) return { skipped: "no_scope" };
    const gate = await step.run("gate", () =>
      gateAgentAutomation({ tenantId, jobId, taskKey: ESTIMATE_TASK_KEY, agent: "claims" }));
    if (!gate.proceed) return { skipped: "automation_deferred", level: gate.level };

    const est = await step.run("generate", () =>
      draftEstimateWithRun({ tenantId, jobId, measurementId }),
    );
    if (!est) return { skipped: "no_measurement" };
    // Job-stage draft: the rep's photo notes on this job steer the AI upsells.
    const upsells = await step.run("upsell", () => attachUpsells(tenantId, est.id, measurementId, { jobId }));
    return { estimateId: est.id, upsells };
  },
);
