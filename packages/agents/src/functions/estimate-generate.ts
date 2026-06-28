import { withTenant, eq, createEstimateFromMeasurement, estimate, measurement, priceBookItem, gateAgentAutomation } from "@savvy/db";
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
): Promise<UpsellSuggestion[]> {
  try {
    const [m] = await withTenant(tenantId, (tx) =>
      tx.select().from(measurement).where(eq(measurement.id, measurementId)),
    );
    const upgrades = await withTenant(tenantId, (tx) =>
      tx.select().from(priceBookItem).where(eq(priceBookItem.category, "upgrade")),
    );

    const { object } = await aiClient.completeObject({
      capability: "reasoning",
      schema: upsellSchema,
      system:
        "You are a roofing sales assistant. Suggest 0-3 optional upgrade line items a rep could offer. " +
        "Never include core roof items already estimated.",
      prompt:
        `Roof measurement: ${JSON.stringify(m?.areas)}. ` +
        `Available upgrade catalog: ${JSON.stringify(upgrades.map((u) => ({ name: u.name, unitPriceCents: u.unitPriceCents })))}.`,
    });

    return object.suggestions;
  } catch {
    // Non-fatal: AI failure should not block estimate creation.
    return [];
  }
}

/**
 * Inngest function: on `measurement/ready`, generate a draft estimate using
 * the price book + estimate engine, then run AI upsell suggestions (resilient)
 * and save them to `estimate.upsellSuggestions`. The upsells are suggestions
 * only — they are NOT added to the estimate totals.
 */
export const generateEstimateOnMeasurement = inngest.createFunction(
  { id: "generate-estimate-on-measurement", concurrency: { limit: 5 }, retries: 2 },
  { event: "measurement/ready" },
  async ({ event, step }) => {
    const { tenantId, jobId, measurementId } = event.data;

    // Runtime automation gate: defer to a human if the owning task isn't full-auto.
    const gate = await step.run("gate", () =>
      gateAgentAutomation({ tenantId, jobId, taskKey: ESTIMATE_TASK_KEY, agent: "claims" }));
    if (!gate.proceed) return { skipped: "automation_deferred", level: gate.level };

    // Step 1: generate the deterministic estimate from the price book.
    const est = await step.run("generate", () =>
      createEstimateFromMeasurement({ tenantId, jobId, measurementId }),
    );
    if (!est) return { skipped: "no_measurement" };

    // Step 2: AI upsell suggestions — resilient, failure returns [].
    const upsells = await step.run("upsell", () =>
      generateUpsells(tenantId, measurementId),
    );

    // Step 3: save upsell suggestions to the estimate row (not added to totals).
    await step.run("save-upsells", () =>
      withTenant(tenantId, (tx) =>
        tx.update(estimate)
          .set({ upsellSuggestions: upsells })
          .where(eq(estimate.id, est.id)),
      ),
    );

    return { estimateId: est.id, upsells: upsells.length };
  },
);
