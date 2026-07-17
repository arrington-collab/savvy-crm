import { z } from "zod";

// Phase 26 slice 3 — material reconciliation (spec: docs/superpowers/specs/
// prompts-phase26-margin-market.md #347/#348). Ordered (PO) vs invoiced
// (parsed actuals) vs used (invoiced − leftover). Variance beyond the
// threshold flags the job and feeds the waste-factor review.

const procurementConfigSchema = z.object({
  varianceThresholdPct: z.number().min(0).catch(10).default(10),
  returnWindowDays: z.number().int().min(1).catch(14).default(14),
  restockingFeePct: z.number().min(0).max(100).catch(15).default(15),
});
export type ProcurementConfig = z.infer<typeof procurementConfigSchema>;

const PROCUREMENT_DEFAULTS: ProcurementConfig = { varianceThresholdPct: 10, returnWindowDays: 14, restockingFeePct: 15 };

export function parseProcurementConfig(raw: unknown): ProcurementConfig {
  const r = procurementConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : PROCUREMENT_DEFAULTS;
}

export type ReconcileLine = {
  key: string;
  name: string | null;
  orderedQty: number;
  invoicedQty: number;
  leftoverQty: number;
  usedQty: number;
  variancePct: number | null; // invoiced vs ordered; null when never ordered
  flagged: boolean;
};

export type ReconcileResult = { lines: ReconcileLine[]; flagged: boolean };

/**
 * Pure reconciliation math. used = invoiced − leftover (falls back to ordered
 * when nothing was invoiced for the key). A key invoiced without ever being
 * ordered is ALWAYS flagged — that's exactly the kind of quiet leak the
 * reconciliation exists to catch.
 */
export function reconcileMaterialLines(
  input: {
    ordered: Array<{ key: string; name?: string | null; quantity: number; unitCostCents?: number | null }>;
    invoiced: Array<{ key: string; quantity: number }>;
    leftover: Array<{ key: string; quantity: number }>;
  },
  varianceThresholdPct: number,
): ReconcileResult {
  const keys = new Set<string>([
    ...input.ordered.map((l) => l.key),
    ...input.invoiced.map((l) => l.key),
    ...input.leftover.map((l) => l.key),
  ]);
  const lines: ReconcileLine[] = [];
  for (const key of keys) {
    const ordered = input.ordered.filter((l) => l.key === key);
    const orderedQty = ordered.reduce((s, l) => s + l.quantity, 0);
    const invoicedQty = input.invoiced.filter((l) => l.key === key).reduce((s, l) => s + l.quantity, 0);
    const leftoverQty = input.leftover.filter((l) => l.key === key).reduce((s, l) => s + l.quantity, 0);
    const usedQty = (invoicedQty > 0 ? invoicedQty : orderedQty) - leftoverQty;

    let variancePct: number | null = null;
    let flagged = false;
    if (orderedQty > 0 && invoicedQty > 0) {
      variancePct = Math.round((Math.abs(invoicedQty - orderedQty) / orderedQty) * 100);
      flagged = variancePct > varianceThresholdPct;
    } else if (orderedQty === 0 && invoicedQty > 0) {
      flagged = true; // billed for something never ordered
    }
    lines.push({ key, name: ordered[0]?.name ?? null, orderedQty, invoicedQty, leftoverQty, usedQty, variancePct, flagged });
  }
  return { lines, flagged: lines.some((l) => l.flagged) };
}
