import { withTenant, getCurrentPriceBookTx, recordAgentRun } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import type { Capability } from "@savvy/ai";
import { z, proposePriceBookDiff, type PriceBookDiffChange } from "@savvy/core";

// Estimate Experience slice 1: paste/upload a supplier price sheet → AI-extract
// {name, cost, best-effort catalog key} lines → grounded cost diff against the
// CURRENT book. The model never sets prices in the book — the diff feeds
// applyPriceBookVersion behind the owner's confirm UI (margin red-path there).

const sheetSchema = z.object({
  lines: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        unitCostCents: z.number().int().min(0),
        // Best-effort match against the supplied catalog; null when unsure.
        matchedKey: z.string().nullable(),
      }),
    )
    .max(200),
});

type SheetOutput = z.infer<typeof sheetSchema>;

type AiClient = {
  completeObject: (opts: {
    capability: Capability;
    schema: z.ZodType<SheetOutput>;
    system?: string;
    prompt: string;
  }) => Promise<{ object: SheetOutput; model: string }>;
};

export interface PriceSheetParseResult {
  diff: { changes: PriceBookDiffChange[]; unmatched: { name: string; unitCostCents: number }[] };
  model: string;
}

export async function parsePriceSheet(
  input: { tenantId: string; rawText: string; defaultMarginFloorBps?: number },
  aiClient: AiClient = { completeObject },
): Promise<PriceSheetParseResult> {
  const { tenantId, rawText } = input;

  const items = await withTenant(tenantId, async (tx) =>
    (await getCurrentPriceBookTx(tx)).items.filter((i) => i.active),
  );
  const catalog = items.map((i) => ({ key: i.key, name: i.name, unit: i.unit }));
  const validKeys = new Set(catalog.map((c) => c.key));

  try {
    const { object, model } = await aiClient.completeObject({
      capability: "cheap-classify",
      schema: sheetSchema,
      system:
        "You extract line items from roofing supplier price sheets. For each priced line return its name, " +
        "the per-unit cost in integer cents, and — ONLY if you are confident — the matching key from the " +
        "supplied catalog (else null). Never invent catalog keys. Skip non-price lines (headers, terms, totals).",
      prompt: `Price sheet text:\n"""${rawText}"""\nCatalog: ${JSON.stringify(catalog)}`,
    });

    // Ground the model's matches: a key not in the catalog is treated as no
    // match — proposePriceBookDiff then falls back to normalized-name matching.
    const parsedLines = object.lines.map((l) => ({
      key: l.matchedKey && validKeys.has(l.matchedKey) ? l.matchedKey : null,
      name: l.name,
      unitCostCents: l.unitCostCents,
    }));

    const diff = proposePriceBookDiff({
      parsedLines,
      book: items,
      defaultMarginFloorBps: input.defaultMarginFloorBps ?? 2000,
    });

    await recordAgentRun({
      tenantId,
      agent: "finance",
      taskKey: "price-book.sheet-parse",
      status: "ok",
      jobId: null,
      modelUsed: model,
    });
    return { diff, model };
  } catch (e) {
    await recordAgentRun({
      tenantId,
      agent: "finance",
      taskKey: "price-book.sheet-parse",
      status: "error",
      jobId: null,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
