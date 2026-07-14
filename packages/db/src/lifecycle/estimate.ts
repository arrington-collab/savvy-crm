import { withTenant } from "../tenant";
import { estimate } from "../schema/finance";
import { measurement } from "../schema/ops";
import { appointment } from "../schema/comms";
import { lead } from "../schema/crm";
import { tierProduct } from "../schema/pricing";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import {
  parseEstimateConfig,
  estimateRequiresApproval,
  measurementAreasSchema,
  generateEstimateLineItems,
  computeEstimateTotals,
  selectPreferredMeasurement,
  expandTierEstimates,
  estimateTemplateVersion,
  REGISTRY_TASK,
  type EnginePriceBookItem,
  type TierEngineItem,
  type TierProductInput,
} from "@savvy/core";
import { markJobTaskDoneTx } from "./job-tasks";
import { getCurrentPriceBookTx } from "./price-book";
import { ensureEstimateLink } from "./estimate-page";

type CreateEstimateInput = {
  tenantId: string;
  measurementId: string;
  // Lead-stage drafts pass leadId (job_id stays null until acceptance creates the
  // job). Legacy/job-stage callers may still pass jobId. propertyId is derived from
  // the measurement when not supplied. At least one of leadId/jobId should be set.
  leadId?: string;
  jobId?: string;
  propertyId?: string;
};

/** Core insert (runs inside a caller-supplied tx). Returns null if measurement missing. */
async function insertEstimateFromMeasurementTx(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  input: CreateEstimateInput,
): Promise<typeof estimate.$inferSelect | null> {
  const [m] = await tx.select().from(measurement).where(eq(measurement.id, input.measurementId));
  if (!m) return null;

  const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
  const cfg = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate);

  // Always price from ONE book: the current version (or the pre-versioning live
  // items). A bare active=true select would mix live originals with version clones.
  const { versionId, items: bookRows } = await getCurrentPriceBookTx(tx);
  const book = bookRows.filter((i) => i.active) as unknown as EnginePriceBookItem[];

  const areas = measurementAreasSchema.parse(m.areas);
  const { lineItems, wastePctUsed, pitchTierApplied } = generateEstimateLineItems({
    areas,
    priceBook: book,
    defaultWastePct: cfg.defaultWastePct,
    pitchTiers: cfg.steepPitchTiers,
  });
  const totals = computeEstimateTotals(lineItems, cfg.taxRateBps);

  // Good/Better/Best snapshot (Estimate Experience slice 1). Unpriced tier
  // products surface via needsCosts — never invented. Absent tier products
  // (tenants pre-dating the seed) → no snapshot, single-price estimate as before.
  const products = await tx.select().from(tierProduct).where(eq(tierProduct.active, true));
  const tiersSnapshot =
    products.length > 0
      ? expandTierEstimates({
          areas,
          priceBook: book as unknown as TierEngineItem[],
          tierProducts: products.map(
            (p): TierProductInput => ({
              tier: p.tier as TierProductInput["tier"],
              productName: p.productName,
              manufacturer: p.manufacturer,
              unitPriceCents: p.unitPriceCents,
              unitCostCents: p.unitCostCents,
              warrantyText: p.warrantyText,
              recommended: p.recommended,
            }),
          ),
          defaultWastePct: cfg.defaultWastePct,
          pitchTiers: cfg.steepPitchTiers,
          shingleItemKey: "field-shingles",
          defaultMarginFloorBps: cfg.marginFloorBps,
        }).tiers
      : null;

  const [row] = await tx
    .insert(estimate)
    .values({
      tenantId: input.tenantId,
      jobId: input.jobId ?? null,
      leadId: input.leadId ?? null,
      propertyId: input.propertyId ?? m.propertyId,
      source: m.provider === "diy" ? "diy" : "roofr",
      status: "draft",
      lineItems,
      subtotal: totals.subtotalCents,
      tax: totals.taxCents,
      total: totals.totalCents,
      measurementId: input.measurementId,
      wastePctUsed,
      pitchTierApplied,
      measurementSource: m.source ?? null,
      priceBookVersionId: versionId,
      tiers: tiersSnapshot,
    })
    .returning();
  return row ?? null;
}

export async function createEstimateFromMeasurement(
  input: CreateEstimateInput,
): Promise<typeof estimate.$inferSelect | null> {
  return withTenant(input.tenantId, (tx) => insertEstimateFromMeasurementTx(tx, input));
}

/**
 * Slice 1 estimate trigger. Drafts a lead-scoped estimate exactly once, gated on:
 * (1) the inspection is complete, and (2) a measurement (Roofr or DIY — first data
 * wins) has landed for the property. Idempotent: returns { skipped: "estimate_exists" }
 * if the lead already has an estimate. Fired by both measurement/ready and
 * appointment/completed, so either arrival order converges to a single draft.
 */
export async function draftLeadEstimateIfReady(input: {
  tenantId: string;
  leadId: string;
}): Promise<{ estimateId: string; measurementId: string } | { skipped: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [l] = await tx.select().from(lead).where(eq(lead.id, input.leadId));
    if (!l || !l.propertyId) return { skipped: "no_lead" as const };

    // Draft-once.
    const [existing] = await tx
      .select({ id: estimate.id })
      .from(estimate)
      .where(eq(estimate.leadId, input.leadId))
      .limit(1);
    if (existing) return { skipped: "estimate_exists" as const };

    // (1) inspection complete?
    const [insp] = await tx
      .select({ id: appointment.id })
      .from(appointment)
      .where(and(eq(appointment.leadId, input.leadId), eq(appointment.type, "inspection"), eq(appointment.status, "done")))
      .limit(1);
    if (!insp) return { skipped: "inspection_not_complete" as const };

    // (2) measurement landed? Source precedence: ordered > uploaded_report > sketch, newest within a source.
    const measRows = await tx
      .select({ id: measurement.id, source: measurement.source, createdAt: measurement.createdAt })
      .from(measurement)
      .where(eq(measurement.propertyId, l.propertyId));
    const m = selectPreferredMeasurement(measRows);
    if (!m) return { skipped: "no_measurement" as const };

    const row = await insertEstimateFromMeasurementTx(tx, {
      tenantId: input.tenantId,
      measurementId: m.id,
      leadId: input.leadId,
      propertyId: l.propertyId,
    });
    if (!row) return { skipped: "no_measurement" as const };
    return { estimateId: row.id, measurementId: m.id };
  });
}

/**
 * Decides whether a freshly-drafted estimate auto-sends or is parked for approval,
 * based on the tenant's approval threshold. Parking stamps approvalRequiredAt (the
 * evidence slice 4's approval card renders from). The caller emits the send event
 * when the action is "send".
 */
export async function resolveEstimateDelivery(input: {
  tenantId: string;
  estimateId: string;
}): Promise<{ action: "send" | "park" }> {
  return withTenant(input.tenantId, async (tx) => {
    const [e] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!e) return { action: "park" as const };
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate);
    if (estimateRequiresApproval(e.total ?? 0, cfg)) {
      await tx.update(estimate).set({ approvalRequiredAt: sql`now()` }).where(eq(estimate.id, input.estimateId));
      return { action: "park" as const };
    }
    return { action: "send" as const };
  });
}

export async function setEstimateStatus(input: {
  tenantId: string;
  estimateId: string;
  status: "draft" | "sent" | "accepted";
  docusealSubmissionId?: string;
}): Promise<typeof estimate.$inferSelect | undefined> {
  return withTenant(input.tenantId, async (tx) => {
    const set: Record<string, unknown> = { status: input.status };
    if (input.status === "sent") set.sentAt = sql`now()`;
    if (input.status === "accepted") set.acceptedAt = sql`now()`;
    if (input.docusealSubmissionId) set.docusealSubmissionId = input.docusealSubmissionId;
    const [row] = await tx
      .update(estimate)
      .set(set)
      .where(and(eq(estimate.tenantId, input.tenantId), eq(estimate.id, input.estimateId)))
      .returning();
    // A lead-stage estimate has no job yet, so there is no job task to mark done
    // on "sent". The job-task ledger is only relevant once the estimate is attached
    // to a job (post-acceptance / legacy rows).
    if (row && input.status === "sent") {
      // Slice 2: every sent estimate gets its tokenized homeowner page link.
      await ensureEstimateLink({ tenantId: input.tenantId, estimateId: input.estimateId });
      // Slice 7: stamp which page template renders this estimate — the
      // close-rate report splits on it.
      if (!row.templateVersion) {
        const [l] = row.leadId
          ? await tx.select({ source: lead.source }).from(lead).where(eq(lead.id, row.leadId))
          : [null];
        await tx
          .update(estimate)
          .set({ templateVersion: estimateTemplateVersion({ source: row.source, leadSource: l?.source ?? null }) })
          .where(eq(estimate.id, input.estimateId));
      }
    }
    if (row && input.status === "sent" && row.jobId) {
      await markJobTaskDoneTx(tx, input.tenantId, { jobId: row.jobId, taskId: REGISTRY_TASK.ESTIMATE_DELIVERY, owner: "SAGE", evidence: { type: "estimate", ref: row.id } });
    }
    return row;
  });
}
