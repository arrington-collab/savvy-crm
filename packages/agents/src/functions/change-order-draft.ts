import { withTenant, getCurrentPriceBookTx, recordAgentRun } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import type { Capability } from "@savvy/ai";
import { z, DEFAULT_PRICE_BOOK, type EstimateLineItem } from "@savvy/core";

const draftSchema = z.object({
  items: z.array(z.object({ key: z.string(), quantity: z.number().min(0) })).max(20),
  summary: z.string().max(280).optional(),
});

type DraftOutput = z.infer<typeof draftSchema>;

export type ScopeDraft = {
  lineItems: EstimateLineItem[];
  summary: string | null;
  model: string;
  unmatched: string[];
};

// Structural type for the AI client — loose enough to accept test stubs while
// still matching the real @savvy/ai completeObject signature.
type AiClient = {
  completeObject: (opts: {
    capability: Capability;
    schema: z.ZodType<DraftOutput>;
    system?: string;
    prompt: string;
  }) => Promise<{ object: DraftOutput; model: string }>;
};

/**
 * Finance agent: draft priced change-order line items from a plain-English
 * description. The model only chooses price-book keys + quantities (grounded —
 * it never invents prices); the server resolves each key to a real EstimateLineItem.
 * Logs a finance/change-order.ai-draft agent_run. Rethrows on AI failure (the
 * caller surfaces it to the rep).
 */
export async function draftChangeOrderScope(
  input: { tenantId: string; jobId: string | null; description: string },
  aiClient: AiClient = { completeObject },
): Promise<ScopeDraft> {
  const { tenantId, jobId, description } = input;

  // Load tenant-specific price book rows; fall back to DEFAULT_PRICE_BOOK if none exist.
  // Current book only — a bare select would mix live originals with version clones.
  const rows = await withTenant(tenantId, async (tx) => (await getCurrentPriceBookTx(tx)).items);

  // Normalize both sources to the same shape for the catalog map.
  const catalog = (rows.length ? rows : DEFAULT_PRICE_BOOK).map((c) => ({
    key: c.key,
    name: c.name,
    category: c.category as EstimateLineItem["category"],
    unit: c.unit as EstimateLineItem["unit"],
    unitPriceCents: c.unitPriceCents,
  }));
  const byKey = new Map(catalog.map((c) => [c.key, c]));

  try {
    const { object, model } = await aiClient.completeObject({
      capability: "reasoning",
      schema: draftSchema,
      system:
        "You are a roofing change-order assistant. Given a rep's plain-English description of a mid-job " +
        "scope change, select the relevant items from the supplied price book and set realistic quantities. " +
        "Use ONLY keys that appear in the price book. Never invent items or prices.",
      prompt: `Scope change: "${description}". Price book: ${JSON.stringify(catalog)}.`,
    });

    const unmatched: string[] = [];
    const lineItems: EstimateLineItem[] = [];
    object.items.forEach((it, i) => {
      const c = byKey.get(it.key);
      if (!c) { unmatched.push(it.key); return; }
      lineItems.push({
        key: `ai-${i}-${c.key}`,
        name: c.name,
        category: c.category,
        unit: c.unit,
        quantity: it.quantity,
        unitPriceCents: c.unitPriceCents,
        amountCents: Math.round(it.quantity * c.unitPriceCents),
      });
    });

    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "change-order.ai-draft", status: "ok",
      jobId: jobId ?? null, modelUsed: model,
    });
    return { lineItems, summary: object.summary ?? null, model, unmatched };
  } catch (e) {
    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "change-order.ai-draft", status: "error",
      jobId: jobId ?? null, error: String(e).slice(0, 200),
    });
    throw e;
  }
}
