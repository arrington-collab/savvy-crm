import { and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  computeValuationSnapshot, parseValuationConfig,
  type QualifiedInput, type ValuationInputs,
} from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { job } from "../schema/jobs";
import { invoice } from "../schema/finance";
import { lead } from "../schema/crm";
import { tenantOpsRollup } from "../schema/task-registry";
import { tenant as tenantTbl } from "../schema/tenancy";
import { valuationSnapshot } from "../schema/valuation";

// Owner's Room slice 1 — input gathering. Every input carries its true
// quality: real (measured), estimated (derived from a subset), or missing
// (the machinery doesn't exist yet — e.g. maintenance MRR until Phase 20).
// The engine turns missing into wider ranges, never into invented numbers.

const YEAR_MS = 365 * 86_400_000;

function q(value: number | null, quality: QualifiedInput["quality"]): QualifiedInput {
  return { value, quality };
}

export async function gatherValuationInputs(tenantId: string, asOf: Date): Promise<ValuationInputs> {
  return withTenant(tenantId, async (tx) => {
    const windowStart = new Date(asOf.getTime() - YEAR_MS);

    const completed = await tx.select({
      customerId: job.customerId, leadId: job.leadId, type: job.type,
      valueFinal: job.valueFinal, valueEstimate: job.valueEstimate,
      costCents: job.costCents, closedAt: job.closedAt,
    }).from(job).where(and(
      eq(job.tenantId, tenantId), eq(job.stage, "complete"),
      isNotNull(job.closedAt), gt(job.closedAt, windowStart), lt(job.closedAt, asOf),
    ));

    // Months of history — from the earliest completed job ever, capped at 12.
    const [earliest] = await tx.select({ min: sql<string | null>`min(${job.closedAt})` })
      .from(job).where(and(eq(job.tenantId, tenantId), eq(job.stage, "complete")));
    const ttmMonths = earliest?.min
      ? Math.min(12, Math.floor((asOf.getTime() - new Date(earliest.min).getTime()) / (30 * 86_400_000)))
      : 0;

    const revOf = (j: { valueFinal: number | null; valueEstimate: number | null }) => j.valueFinal ?? j.valueEstimate ?? 0;
    const ttmRevenue = completed.reduce((s, j) => s + revOf(j), 0);
    const allFinal = completed.length > 0 && completed.every((j) => j.valueFinal != null);
    const ttmRevenueCents = completed.length === 0
      ? q(null, "missing")
      : q(ttmRevenue, allFinal ? "real" : "estimated");

    // Gross margin from the known-cost subset only — a partial subset is
    // 'estimated', an empty one is 'missing'. Unknown costs never count as $0.
    const costed = completed.filter((j) => j.costCents != null);
    const costedRev = costed.reduce((s, j) => s + revOf(j), 0);
    const costedCost = costed.reduce((s, j) => s + (j.costCents ?? 0), 0);
    const ttmGrossMarginPct = costed.length === 0 || costedRev === 0
      ? q(null, "missing")
      : q(Math.round(((costedRev - costedCost) / costedRev) * 100),
          costed.length === completed.length ? "real" : "estimated");

    const insuranceRev = completed.filter((j) => j.type === "insurance").reduce((s, j) => s + revOf(j), 0);
    const insuranceMixPct = ttmRevenue > 0 ? q(Math.round((insuranceRev / ttmRevenue) * 100), "real") : q(null, "missing");

    const byCustomer = new Map<string, number>();
    for (const j of completed) byCustomer.set(j.customerId, (byCustomer.get(j.customerId) ?? 0) + revOf(j));
    const topCustomerPct = ttmRevenue > 0
      ? q(Math.round((Math.max(...byCustomer.values()) / ttmRevenue) * 100), "real")
      : q(null, "missing");

    const leadIds = completed.map((j) => j.leadId).filter((x): x is string => !!x);
    let topLeadSourcePct: QualifiedInput = q(null, "missing");
    if (leadIds.length > 0) {
      const sources = await tx.select({ id: lead.id, source: lead.source }).from(lead).where(inArray(lead.id, leadIds));
      const srcOf = new Map(sources.map((s) => [s.id, s.source ?? "unknown"]));
      const bySource = new Map<string, number>();
      for (const j of completed) {
        if (!j.leadId) continue;
        const s = srcOf.get(j.leadId) ?? "unknown";
        bySource.set(s, (bySource.get(s) ?? 0) + revOf(j));
      }
      const attributed = [...bySource.values()].reduce((a, b) => a + b, 0);
      if (attributed > 0) topLeadSourcePct = q(Math.round((Math.max(...bySource.values()) / attributed) * 100), "real");
    }

    const [rollup] = await tx.select({
      fullAutoGreen: tenantOpsRollup.fullAutoGreen, totalTasks: tenantOpsRollup.totalTasks,
      founderMinutes30d: tenantOpsRollup.founderMinutes30d,
    }).from(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, tenantId));
    const coveragePct = rollup && rollup.totalTasks > 0
      ? q(Math.round((rollup.fullAutoGreen / rollup.totalTasks) * 100), "real")
      : q(null, "missing");
    const founderMinutes30d = rollup ? q(Number(rollup.founderMinutes30d ?? 0), "real") : q(null, "missing");

    const backlogRows = await tx.select({ valueFinal: job.valueFinal, valueEstimate: job.valueEstimate })
      .from(job).where(and(eq(job.tenantId, tenantId), eq(job.stage, "approved")));
    const backlogCents = q(backlogRows.reduce((s, j) => s + revOf(j), 0), "real");

    const openInvoices = await tx.select({ amountDue: invoice.amountDue, amountPaid: invoice.amountPaid, dueAt: invoice.dueAt })
      .from(invoice).where(and(eq(invoice.tenantId, tenantId), inArray(invoice.status, ["sent", "overdue"])));
    const outstanding = openInvoices
      .map((i) => ({ ...i, open: Math.max(0, (i.amountDue ?? 0) - (i.amountPaid ?? 0)) }))
      .filter((i) => i.open > 0);
    const outstandingTotal = outstanding.reduce((s, i) => s + i.open, 0);
    const over60 = outstanding
      .filter((i) => i.dueAt && asOf.getTime() - i.dueAt.getTime() > 60 * 86_400_000)
      .reduce((s, i) => s + i.open, 0);
    const arOver60Pct = openInvoices.length === 0
      ? q(null, "missing")
      : q(outstandingTotal > 0 ? Math.round((over60 / outstandingTotal) * 100) : 0, "real");

    const [t] = await adminDb.select({ qbo: tenantTbl.qboConnectionId }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));

    return {
      ttmMonths,
      ttmRevenueCents,
      ttmGrossMarginPct,
      insuranceMixPct,
      maintenanceMrrCents: q(null, "missing"), // Phase 20 unbuilt — honest gap
      topCustomerPct,
      topLeadSourcePct,
      coveragePct,
      founderMinutes30d,
      backlogCents,
      arOver60Pct,
      qboReconciled: !!t?.qbo,
    };
  });
}

/** Compute + persist the monthly snapshot; one row per tenant+period, refreshed in place. */
export async function recordValuationSnapshot(tenantId: string, periodKey: string, now: Date): Promise<void> {
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const config = parseValuationConfig((t?.settings as { valuation?: unknown } | null)?.valuation);
  const inputs = await gatherValuationInputs(tenantId, now);
  const snap = computeValuationSnapshot(inputs, config);

  await withTenant(tenantId, (tx) =>
    tx.insert(valuationSnapshot).values({
      tenantId, periodKey,
      status: snap.status,
      reasons: snap.reasons ?? null,
      sdeCents: snap.sdeCents,
      valueLowCents: snap.valueLowCents,
      valueLikelyCents: snap.valueLikelyCents,
      valueHighCents: snap.valueHighCents,
      multipleLow: snap.status === "ok" ? snap.multipleLow : null,
      multipleHigh: snap.status === "ok" ? snap.multipleHigh : null,
      adjustments: snap.adjustments,
      inputQuality: snap.inputQuality,
      inputs: inputs as unknown as Record<string, unknown>,
      methodologyVersion: snap.methodologyVersion,
      computedAt: now,
    }).onConflictDoUpdate({
      target: [valuationSnapshot.tenantId, valuationSnapshot.periodKey],
      set: {
        status: snap.status, reasons: snap.reasons ?? null, sdeCents: snap.sdeCents,
        valueLowCents: snap.valueLowCents, valueLikelyCents: snap.valueLikelyCents, valueHighCents: snap.valueHighCents,
        multipleLow: snap.status === "ok" ? snap.multipleLow : null,
        multipleHigh: snap.status === "ok" ? snap.multipleHigh : null,
        adjustments: snap.adjustments, inputQuality: snap.inputQuality,
        inputs: inputs as unknown as Record<string, unknown>,
        methodologyVersion: snap.methodologyVersion, computedAt: now,
      },
    }));
}
