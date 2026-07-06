import { withTenant } from "../tenant";
import { estimate } from "../schema/finance";
import { measurement } from "../schema/ops";
import { priceBookItem } from "../schema/pricing";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import {
  parseEstimateConfig,
  measurementAreasSchema,
  generateEstimateLineItems,
  computeEstimateTotals,
  REGISTRY_TASK,
  type EnginePriceBookItem,
} from "@savvy/core";
import { markJobTaskDoneTx } from "./job-tasks";

export async function createEstimateFromMeasurement(input: {
  tenantId: string;
  measurementId: string;
  // Lead-stage drafts pass leadId (job_id stays null until acceptance creates the
  // job). Legacy/job-stage callers may still pass jobId. propertyId is derived from
  // the measurement when not supplied. At least one of leadId/jobId should be set.
  leadId?: string;
  jobId?: string;
  propertyId?: string;
}): Promise<typeof estimate.$inferSelect | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [m] = await tx.select().from(measurement).where(eq(measurement.id, input.measurementId));
    if (!m) return null;

    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate);

    const book = (await tx
      .select()
      .from(priceBookItem)
      .where(eq(priceBookItem.active, true))) as unknown as EnginePriceBookItem[];

    const areas = measurementAreasSchema.parse(m.areas);
    const { lineItems, wastePctUsed, pitchTierApplied } = generateEstimateLineItems({
      areas,
      priceBook: book,
      defaultWastePct: cfg.defaultWastePct,
      pitchTiers: cfg.steepPitchTiers,
    });
    const totals = computeEstimateTotals(lineItems, cfg.taxRateBps);

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
      })
      .returning();
    return row ?? null;
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
    if (row && input.status === "sent" && row.jobId) {
      await markJobTaskDoneTx(tx, input.tenantId, { jobId: row.jobId, taskId: REGISTRY_TASK.ESTIMATE_DELIVERY, owner: "SAGE", evidence: { type: "estimate", ref: row.id } });
    }
    return row;
  });
}
