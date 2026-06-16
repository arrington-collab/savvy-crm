"use server";
import { revalidatePath } from "next/cache";
import { withTenant, estimate, tenant, eq, createEstimateFromMeasurement } from "@savvy/db";
import { computeEstimateTotals, parseEstimateConfig, type EstimateLineItem } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

async function taxRateBpsFor(tenantId: string): Promise<number> {
  const [t] = await withTenant(tenantId, (tx) => tx.select().from(tenant).where(eq(tenant.id, tenantId)));
  return parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate).taxRateBps;
}

/** Kick off an async Roofr measurement order for a job's property. */
export async function orderMeasurementAction(jobId: string, propertyId: string) {
  const tenantId = await getTenantId();
  try {
    await inngest.send({ name: "roofr/order.requested", data: { tenantId, jobId, propertyId } });
  } catch (e) {
    console.error(e);
  }
  revalidatePath(`/jobs/${jobId}`);
}

/** Generate a draft estimate synchronously so the rep sees it immediately. */
export async function generateEstimateAction(jobId: string, measurementId: string) {
  const tenantId = await getTenantId();
  const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
  revalidatePath(`/jobs/${jobId}`);
  return est ? { ok: true as const, id: est.id } : { error: "no_measurement" as const };
}

export async function updateEstimateLineItemsAction(input: {
  estimateId: string;
  jobId: string;
  lineItems: EstimateLineItem[];
}) {
  const tenantId = await getTenantId();
  const totals = computeEstimateTotals(input.lineItems, await taxRateBpsFor(tenantId));
  await withTenant(tenantId, (tx) =>
    tx
      .update(estimate)
      .set({ lineItems: input.lineItems, subtotal: totals.subtotalCents, tax: totals.taxCents, total: totals.totalCents })
      .where(eq(estimate.id, input.estimateId)),
  );
  revalidatePath(`/jobs/${input.jobId}/estimates/${input.estimateId}`);
}

type UpsellSuggestion = { name: string; reason?: string; unitPriceCents: number; quantity: number };

/** Move an AI upsell suggestion (by index) into the estimate's line items, recompute totals. */
export async function acceptUpsellAction(input: { estimateId: string; jobId: string; index: number }) {
  const tenantId = await getTenantId();
  await withTenant(tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!est) return;
    const suggestions = (est.upsellSuggestions as UpsellSuggestion[]) ?? [];
    const picked = suggestions[input.index];
    if (!picked) return;
    const lineItems = [...((est.lineItems as EstimateLineItem[]) ?? [])];
    lineItems.push({
      key: `upsell-${input.index}-${Date.now()}`,
      name: picked.name,
      category: "upgrade",
      unit: "each",
      quantity: picked.quantity,
      unitPriceCents: picked.unitPriceCents,
      amountCents: Math.round(picked.quantity * picked.unitPriceCents),
    });
    const remaining = suggestions.filter((_, i) => i !== input.index);
    const totals = computeEstimateTotals(lineItems, await taxRateBpsFor(tenantId));
    await tx
      .update(estimate)
      .set({ lineItems, upsellSuggestions: remaining, subtotal: totals.subtotalCents, tax: totals.taxCents, total: totals.totalCents })
      .where(eq(estimate.id, input.estimateId));
  });
  revalidatePath(`/jobs/${input.jobId}/estimates/${input.estimateId}`);
}

/** Send the estimate for e-signature via the DocuSeal workflow. */
export async function sendEstimateAction(estimateId: string, jobId: string) {
  const tenantId = await getTenantId();
  try {
    await inngest.send({ name: "estimate/send.requested", data: { tenantId, estimateId } });
  } catch (e) {
    console.error(e);
  }
  revalidatePath(`/jobs/${jobId}/estimates/${estimateId}`);
}
