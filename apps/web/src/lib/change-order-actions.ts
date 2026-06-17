"use server";
import { revalidatePath } from "next/cache";
import { withTenant, adminDb, tenant, job, customer, property, changeOrder, createChangeOrder, sendChangeOrder, eq } from "@savvy/db";
import { computeChangeOrderTotal, type EstimateLineItem } from "@savvy/core";
import { httpDocuseal, makeFakeDocuseal } from "@savvy/integrations";
import { draftChangeOrderScope } from "@savvy/agents";
import { getTenantId } from "./tenant";

/** Real gateway when DocuSeal is configured; fake (fail-soft) otherwise (dev/e2e). */
const docuseal = () => (process.env.DOCUSEAL_API_KEY ? httpDocuseal : makeFakeDocuseal());

export async function createChangeOrderAction(input: { jobId: string; reason: string; lineItems: EstimateLineItem[] }) {
  const tenantId = await getTenantId();
  const found = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id, customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    return j ?? null;
  });
  if (!found) return { error: "not_found" as const };
  const co = await createChangeOrder({
    tenantId, jobId: input.jobId, customerId: found.customerId, reason: input.reason, lineItems: input.lineItems,
  });
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const, id: co.id };
}

export async function updateChangeOrderLineItemsAction(input: { changeOrderId: string; jobId: string; lineItems: EstimateLineItem[] }) {
  const tenantId = await getTenantId();
  const { subtotal, total } = computeChangeOrderTotal(input.lineItems);
  await withTenant(tenantId, (tx) =>
    tx.update(changeOrder).set({ lineItems: input.lineItems, subtotal, total }).where(eq(changeOrder.id, input.changeOrderId)),
  );
  revalidatePath(`/jobs/${input.jobId}/change-orders/${input.changeOrderId}`);
}

type SendResult =
  | { ok: true; signingUrl: string }
  | { error: "not_found" | "no_customer_email" | "no_template" | "docuseal_failed" };

export async function sendChangeOrderForSignatureAction(changeOrderId: string, jobId: string): Promise<SendResult> {
  const tenantId = await getTenantId();
  const ctx = await withTenant(tenantId, async (tx) => {
    const [co] = await tx.select().from(changeOrder).where(eq(changeOrder.id, changeOrderId));
    if (!co) return null;
    const [c] = await tx.select({ name: customer.name, email: customer.email }).from(customer).where(eq(customer.id, co.customerId));
    const [j] = await tx.select({ propertyId: job.propertyId }).from(job).where(eq(job.id, co.jobId));
    const [p] = j ? await tx.select({ address: property.address }).from(property).where(eq(property.id, j.propertyId)) : [undefined];
    return { co, c, address: p?.address ?? "" };
  });
  if (!ctx) return { error: "not_found" };
  if (!ctx.c?.email) return { error: "no_customer_email" };
  const email = ctx.c.email;

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const templateId =
    ((t?.settings as { esign?: { templates?: { change_order?: string } } } | undefined)?.esign?.templates?.change_order)
    || (process.env.DOCUSEAL_TEMPLATE_CHANGE_ORDER ?? "");
  if (!templateId) return { error: "no_template" };

  const total = ctx.co.total ?? 0;
  const fields = [
    { name: "customer_name", default_value: ctx.c.name },
    { name: "property_address", default_value: ctx.address },
    { name: "date", default_value: new Date().toISOString().slice(0, 10) },
    { name: "amount", default_value: `$${(total / 100).toFixed(2)}` },
    { name: "reason", default_value: ctx.co.reason ?? "" },
  ];

  let submission: { submissionId: string; signingUrl: string };
  try {
    submission = await docuseal().createClosoutSubmission({
      templateId,
      signer: { name: ctx.c.name, email },
      fields,
      metadata: { tenantId, jobId, docType: "change_order" },
    });
  } catch {
    return { error: "docuseal_failed" };
  }

  await sendChangeOrder({ tenantId, changeOrderId, docusealSubmissionId: submission.submissionId, signingUrl: submission.signingUrl });
  revalidatePath(`/jobs/${jobId}/change-orders/${changeOrderId}`);
  return { ok: true, signingUrl: submission.signingUrl };
}

export async function draftChangeOrderLineItemsAction(
  input: { jobId: string; description: string },
): Promise<{ ok: true; lineItems: EstimateLineItem[]; summary: string | null } | { error: "empty_description" | "ai_failed" }> {
  const tenantId = await getTenantId();
  if (!input.description.trim()) return { error: "empty_description" };
  try {
    const draft = await draftChangeOrderScope({ tenantId, jobId: input.jobId, description: input.description });
    return { ok: true, lineItems: draft.lineItems, summary: draft.summary };
  } catch {
    return { error: "ai_failed" };
  }
}
